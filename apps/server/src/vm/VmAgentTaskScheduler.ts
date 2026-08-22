import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadId,
  type VmAgentDelegation,
  VmAgentDelegationMessageId,
  VmAgentNotificationId,
  type VmAgentTask,
  type VmAgentTaskRun,
  VmAgentTaskRunId,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { VmAgentStore } from "../persistence/Services/VmAgents.ts";
import { VmAgentCollaborationStore } from "../persistence/Services/VmAgentCollaborations.ts";
import {
  type VmAgentTaskRunObservation,
  VmAgentWorkspaceStore,
} from "../persistence/Services/VmAgentWorkspaces.ts";
import { VmAgentWorkspace } from "./VmAgentWorkspace.ts";
import { VmManager } from "./VmManager.ts";

const POLL_INTERVAL_MS = 1_000;
const MAX_CLAIMS_PER_DRAIN = 8;
/**
 * How long a run may sit "running" with no projected turn before it is failed.
 *
 * A turn.start can race a turn that was already running (the pre-dispatch idle
 * check reads an eventually-consistent projection), and the engine's command
 * receipt then dedupes every retry of the same commandId into a silent no-op —
 * the run stays "running" forever, no turn ever exists, and because claiming
 * skips an agent with any live run, one stuck run starves the agent's entire
 * schedule. Two minutes is far beyond projection lag, so a runless run this
 * old is unstartable, not slow.
 */
const RUN_START_STALL_MS = 120_000;

export interface VmAgentTaskSchedulerShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly wake: () => Effect.Effect<void>;
}

export class VmAgentTaskScheduler extends Context.Service<
  VmAgentTaskScheduler,
  VmAgentTaskSchedulerShape
>()("t3/vm/VmAgentTaskScheduler") {}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const runMessageId = (runId: VmAgentTaskRunId) => MessageId.make(`vm-task:${runId}`);
const runCommandId = (runId: VmAgentTaskRunId) => CommandId.make(`vm-task:${runId}`);

const taskPrompt = (
  task: VmAgentTask,
  delegation: VmAgentDelegation | null,
  pendingMessage?: string,
) => {
  const criteria =
    task.completionCriteria.length === 0
      ? "- Complete the requested work and report the concrete outcome."
      : task.completionCriteria.map((criterion) => `- ${criterion}`).join("\n");
  if (delegation !== null) {
    return [
      `[Delegated work: ${delegation.title}]`,
      "",
      pendingMessage ?? delegation.task,
      "",
      "Completion criteria:",
      criteria,
      "",
      `Requested capabilities: ${delegation.requestedCapabilities.join(", ") || "none"}`,
      "",
      "This is bounded delegated work. You may not create another agent or side chat. Use agent_collaboration to report notes or questions. Consequential external actions always require explicit human approval. Stay in this environment and use the inherited model; do not escalate to a paid model.",
    ].join("\n");
  }
  return [
    `[Scheduled task: ${task.title}]`,
    "",
    task.prompt,
    "",
    "Completion criteria:",
    criteria,
    "",
    "This is durable scheduled work for your custom-agent workspace. Use your VM when needed. When finished, summarize what changed, any evidence, and anything still blocked.",
  ].join("\n");
};

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 4_000);

export const make = Effect.gen(function* () {
  const agents = yield* VmAgentStore;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const store = yield* VmAgentWorkspaceStore;
  const collaboration = yield* VmAgentCollaborationStore;
  const workspace = yield* VmAgentWorkspace;
  const vmManager = yield* VmManager;
  const wakeQueue = yield* Queue.sliding<void>(1);
  const started = yield* Ref.make(false);
  const activeRuns = new Map<string, Fiber.Fiber<void, never>>();

  const wake: VmAgentTaskSchedulerShape["wake"] = () =>
    Queue.offer(wakeQueue, undefined).pipe(Effect.asVoid);

  const getTask = (run: VmAgentTaskRun) =>
    store.getTask(run.vmAgentId, run.taskId).pipe(
      Effect.map(Option.getOrNull),
      Effect.orElseSucceed(() => null),
    );

  const createRunNotification = Effect.fn("VmAgentTaskScheduler.createRunNotification")(function* (
    task: VmAgentTask,
    run: VmAgentTaskRun,
    status: "completed" | "failed" | "cancelled",
    detail: string,
  ) {
    const snapshot = yield* workspace
      .snapshot(task.vmAgentId)
      .pipe(Effect.orElseSucceed(() => null));
    if (!snapshot?.notificationPreferences.enabled || task.notificationPolicy === "never") return;
    const failure = status !== "completed";
    if (failure && !snapshot.notificationPreferences.taskFailures) return;
    if (!failure && task.notificationPolicy !== "always") return;
    if (!failure && !snapshot.notificationPreferences.taskCompletions) return;
    yield* workspace
      .notify({
        vmAgentId: task.vmAgentId,
        notificationId: VmAgentNotificationId.make(`task-run:${run.runId}:${status}`),
        taskId: task.taskId,
        runId: run.runId,
        kind: failure ? "task-failed" : "task-completed",
        title: failure ? `${task.title} needs attention` : `${task.title} completed`,
        body: detail,
        dedupeKey: `task-run:${run.runId}:${status}`,
      })
      .pipe(Effect.ignoreCause({ log: true }));
  });

  const finishObservation = Effect.fn("VmAgentTaskScheduler.finishObservation")(function* (
    observation: VmAgentTaskRunObservation,
  ) {
    const projectionState = observation.projectionState;
    if (
      projectionState !== "completed" &&
      projectionState !== "error" &&
      projectionState !== "interrupted" &&
      projectionState !== "incomplete"
    ) {
      return false;
    }
    const delegation = yield* collaboration
      .getByRunId(observation.run.runId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    const delegationMessages = Option.isSome(delegation)
      ? yield* collaboration
          .listMessages(delegation.value.delegationId)
          .pipe(Effect.orElseSucceed(() => []))
      : [];
    const hasPendingDelegationMessage = delegationMessages.some(
      (message) => message.delivery === "pending",
    );
    const delegationIsContinuing =
      Option.isSome(delegation) &&
      (delegation.value.status === "waiting-input" || hasPendingDelegationMessage);
    const status =
      projectionState === "completed"
        ? ("completed" as const)
        : projectionState === "interrupted"
          ? ("cancelled" as const)
          : ("failed" as const);
    const completedAt = yield* nowIso;
    const summary = observation.assistantText?.trim().slice(0, 4_000) || null;
    const failureDetail =
      status === "completed"
        ? null
        : `The agent turn ended as ${projectionState}.${summary ? ` ${summary}` : ""}`.slice(
            0,
            4_000,
          );
    // Persist the deduplicated notification before terminalizing the run. If
    // the process exits between them, startup still observes the active run
    // and retries; reversing the order would permanently lose the alert.
    const task = yield* getTask(observation.run);
    if (task) {
      yield* createRunNotification(
        task,
        observation.run,
        status,
        summary ?? failureDetail ?? "The scheduled task finished.",
      );
    }
    yield* store.completeRun({
      runId: observation.run.runId,
      status,
      turnId: observation.projectionTurnId,
      resultSummary: summary,
      error: failureDetail,
      completedAt,
    });
    if (Option.isSome(delegation) && hasPendingDelegationMessage) {
      yield* collaboration.requeuePendingFollowup({
        delegationId: delegation.value.delegationId,
        updatedAt: completedAt,
      });
    }
    if (Option.isSome(delegation) && !delegationIsContinuing) {
      yield* collaboration.complete({
        runId: observation.run.runId,
        status,
        summary,
        error: failureDetail,
        completedAt,
        ...(summary
          ? {
              messageId: VmAgentDelegationMessageId.make(
                `delegation-result:${delegation.value.delegationId}:${observation.run.runId}`,
              ),
            }
          : {}),
      });
    }
    yield* workspace.refresh(observation.run.vmAgentId);
    return true;
  });

  const canStart = Effect.fn("VmAgentTaskScheduler.canStart")(function* (run: VmAgentTaskRun) {
    const delegated = yield* collaboration.getByTaskId(run.taskId);
    if (Option.isSome(delegated) && delegated.value.target.kind === "ephemeral") return true;
    const agent = yield* agents.getById(run.vmAgentId);
    if (
      Option.isNone(agent) ||
      agent.value.threadId === null ||
      agent.value.controlMode === "user"
    ) {
      return false;
    }
    const thread = yield* projections.getThreadShellById(agent.value.threadId);
    if (Option.isNone(thread)) return false;
    return thread.value.latestTurn?.state !== "running" && thread.value.pendingWork == null;
  });

  const failRun = Effect.fn("VmAgentTaskScheduler.failRun")(function* (
    task: VmAgentTask | null,
    run: VmAgentTaskRun,
    error: unknown,
  ) {
    const detail = errorText(error);
    const completedAt = yield* nowIso;
    if (task) yield* createRunNotification(task, run, "failed", detail);
    yield* store
      .completeRun({
        runId: run.runId,
        status: "failed",
        turnId: null,
        resultSummary: null,
        error: detail,
        completedAt,
      })
      .pipe(Effect.ignoreCause({ log: true }));
    yield* collaboration
      .complete({
        runId: run.runId,
        status: "failed",
        summary: null,
        error: detail,
        completedAt,
      })
      .pipe(Effect.ignoreCause({ log: true }));
    yield* workspace.refresh(run.vmAgentId);
  });

  const executeRun = (run: VmAgentTaskRun) =>
    Effect.gen(function* () {
      const task = yield* getTask(run);
      if (!task) {
        yield* failRun(null, run, new Error("The scheduled task no longer exists."));
        return;
      }
      const delegated = yield* collaboration
        .getByTaskId(run.taskId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const agent = yield* agents.getById(run.vmAgentId);
      if (Option.isNone(agent) || agent.value.threadId === null) {
        yield* failRun(task, run, new Error("The agent has no dedicated chat session."));
        return;
      }
      if (!(yield* canStart(run).pipe(Effect.orElseSucceed(() => false)))) return;

      const startedAt = yield* nowIso;
      const messageId = run.messageId ?? runMessageId(run.runId);
      let threadId = agent.value.threadId;
      let runtimeMode: RuntimeMode = "full-access";
      let interactionMode: ProviderInteractionMode = DEFAULT_PROVIDER_INTERACTION_MODE;
      if (Option.isSome(delegated) && delegated.value.target.kind === "ephemeral") {
        const source = yield* agents.getById(delegated.value.sourceVmAgentId);
        if (Option.isNone(source) || source.value.threadId === null) {
          yield* failRun(task, run, new Error("The source agent chat no longer exists."));
          return;
        }
        const sourceThread = yield* projections.getThreadShellById(source.value.threadId);
        if (Option.isNone(sourceThread)) {
          yield* failRun(task, run, new Error("The source agent chat is not projected."));
          return;
        }
        threadId =
          delegated.value.workerThreadId === null
            ? ThreadId.make(`delegation-worker:${delegated.value.delegationId}`)
            : delegated.value.workerThreadId;
        const workerThread = yield* projections.getThreadShellById(threadId);
        if (Option.isNone(workerThread)) {
          yield* engine.dispatch({
            type: "thread.fork",
            commandId: CommandId.make(`delegation-fork:${delegated.value.delegationId}`),
            threadId,
            sourceThreadId: source.value.threadId,
            title: delegated.value.target.label ?? `Worker: ${delegated.value.title}`,
            modelSelection: sourceThread.value.modelSelection,
            runtimeMode: sourceThread.value.runtimeMode,
            interactionMode: "agent",
            isSideChat: true,
            sideChatParentThreadId: source.value.threadId,
            createdAt: startedAt,
          });
        }
        if (delegated.value.workerThreadId === null) {
          yield* collaboration.setWorkerThread({
            delegationId: delegated.value.delegationId,
            threadId,
            updatedAt: startedAt,
          });
        }
        runtimeMode = sourceThread.value.runtimeMode;
        interactionMode = "agent";
      }
      yield* store.setRunBooting(run.runId, startedAt);
      yield* workspace.refresh(run.vmAgentId);
      if (Option.isNone(delegated) || delegated.value.target.kind === "agent") {
        yield* vmManager.ensureRunning(run.vmAgentId);
      }
      yield* store.setRunRunning({ runId: run.runId, messageId, startedAt });
      if (Option.isSome(delegated)) {
        yield* collaboration.markRunning({ runId: run.runId, startedAt, messageId });
      }
      yield* workspace.refresh(run.vmAgentId);
      const delegationMessages = Option.isSome(delegated)
        ? yield* collaboration.listMessages(delegated.value.delegationId)
        : [];
      const pendingMessage = delegationMessages.find((message) => message.delivery === "pending");
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: runCommandId(run.runId),
        threadId,
        message: {
          messageId,
          role: "user",
          text: taskPrompt(task, Option.getOrNull(delegated), pendingMessage?.text),
          inputOrigin: "agent-loop",
          ...(Option.isSome(delegated) ? { delegationId: delegated.value.delegationId } : {}),
          attachments: [],
        },
        runtimeMode,
        interactionMode,
        createdAt: startedAt,
      });
      if (pendingMessage) {
        yield* collaboration.markMessageDelivered({
          messageId: pendingMessage.messageId,
          updatedAt: startedAt,
        });
      }
    }).pipe(
      Effect.catch((error) =>
        getTask(run).pipe(Effect.flatMap((task) => failRun(task, run, error))),
      ),
      Effect.catchCause((cause) =>
        Effect.logError("vm-agent-task.scheduler.execution-failed", {
          runId: run.runId,
          vmAgentId: run.vmAgentId,
          cause,
        }),
      ),
    );

  const launch = (run: VmAgentTaskRun) =>
    Effect.gen(function* () {
      if (activeRuns.has(run.runId)) return;
      const fiber = yield* executeRun(run).pipe(Effect.forkScoped);
      activeRuns.set(run.runId, fiber);
      yield* Fiber.await(fiber).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (activeRuns.get(run.runId) === fiber) activeRuns.delete(run.runId);
          }),
        ),
        Effect.forkScoped,
      );
    });

  const expireDelegation = Effect.fn("VmAgentTaskScheduler.expireDelegation")(function* (
    delegation: VmAgentDelegation,
  ) {
    const completedAt = yield* nowIso;
    yield* collaboration.cancel({
      delegationId: delegation.delegationId,
      status: "expired",
      detail: "Delegated work exceeded its 30 minute wall-clock limit.",
      completedAt,
    });
    const threadId =
      delegation.workerThreadId !== null
        ? ThreadId.make(delegation.workerThreadId)
        : delegation.targetVmAgentId !== null
          ? (Option.getOrNull(yield* agents.getById(delegation.targetVmAgentId))?.threadId ?? null)
          : null;
    if (threadId === null) return;
    const thread = yield* projections
      .getThreadShellById(threadId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(thread)) return;
    const activeTurnId =
      thread.value.session?.activeTurnId ??
      (thread.value.latestTurn?.state === "running" ? thread.value.latestTurn.turnId : null);
    if (activeTurnId === null) return;
    yield* engine
      .dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make(`delegation-expire:${delegation.delegationId}`),
        threadId,
        turnId: activeTurnId,
        createdAt: completedAt,
      })
      .pipe(Effect.ignoreCause({ log: true }));
  });

  const drain = Effect.gen(function* () {
    const expired = yield* collaboration.listExpired(yield* nowIso);
    for (const delegation of expired) yield* expireDelegation(delegation);

    const observations = yield* store.listRunObservations();
    for (const observation of observations) {
      if (yield* finishObservation(observation)) continue;
      // `projectionTurnId`, not `projectionState`: a dispatch can also leave a
      // projected turn sitting in `pending` with no turn id, which is just as
      // unstarted as having no projection row at all but was invisible to this
      // check. Observed in the wild — a run stuck `running` for over an hour
      // against an idle `ready` session whose previous turn had completed 20
      // minutes earlier, so this is not only the already-running race below.
      // `projectionTurnId`, not `projectionState`: a dispatch can also leave a
      // projected turn sitting in `pending` with no turn id, which is just as
      // unstarted as having no projection row at all but was invisible to this
      // check. Observed in the wild — a run stuck `running` for over an hour
      // against an idle `ready` session whose previous turn had completed 20
      // minutes earlier, so this is not only the already-running race below.
      if (observation.run.status === "running" && observation.projectionTurnId === null) {
        const startedAt = observation.run.startedAt;
        const startedAtMs = (() => {
          if (startedAt === null) return null;
          try {
            return DateTime.toEpochMillis(DateTime.makeUnsafe(startedAt));
          } catch {
            return null;
          }
        })();
        const nowMs = DateTime.toEpochMillis(DateTime.makeUnsafe(yield* nowIso));
        if (startedAtMs !== null && nowMs - startedAtMs >= RUN_START_STALL_MS) {
          const task = yield* getTask(observation.run);
          yield* failRun(
            task,
            observation.run,
            new Error(
              "The scheduled turn never started — it likely raced a turn that was already running. Run the task again or wait for its next occurrence.",
            ),
          ).pipe(Effect.ignoreCause({ log: true }));
          continue;
        }
      }
      if (
        observation.run.status === "queued" ||
        observation.run.status === "booting" ||
        (observation.run.status === "running" && observation.projectionState === null)
      ) {
        yield* launch(observation.run);
      }
    }

    for (let claimedCount = 0; claimedCount < MAX_CLAIMS_PER_DRAIN; claimedCount += 1) {
      const now = yield* nowIso;
      const claimed = yield* store.claimNextDue({
        runId: VmAgentTaskRunId.make(NodeCrypto.randomUUID()),
        now,
      });
      if (Option.isNone(claimed)) break;
      yield* collaboration.markRunClaimed({
        taskId: claimed.value.task.taskId,
        runId: claimed.value.run.runId,
        updatedAt: now,
      });
      yield* workspace.refresh(claimed.value.run.vmAgentId);
      yield* launch(claimed.value.run);
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("vm-agent-task.scheduler.drain-failed", { cause }),
    ),
  );

  const start: VmAgentTaskSchedulerShape["start"] = () =>
    Effect.gen(function* () {
      const shouldStart = yield* Ref.modify(started, (value) => [!value, true]);
      if (!shouldStart) return;
      yield* Effect.addFinalizer(() => Ref.set(started, false));
      yield* Effect.forkScoped(Effect.forever(Queue.take(wakeQueue).pipe(Effect.andThen(drain))));
      yield* Effect.forkScoped(
        wake().pipe(Effect.repeat(Schedule.spaced(Duration.millis(POLL_INTERVAL_MS)))),
      );
      yield* wake();
      yield* Effect.logInfo("vm-agent-task.scheduler.started", {
        pollIntervalMs: POLL_INTERVAL_MS,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Ref.set(started, false).pipe(
          Effect.andThen(Effect.logError("vm-agent-task.scheduler.start-failed", { cause })),
        ),
      ),
    );

  return { start, wake } satisfies VmAgentTaskSchedulerShape;
});

export const VmAgentTaskSchedulerLive = Layer.effect(VmAgentTaskScheduler, make);
