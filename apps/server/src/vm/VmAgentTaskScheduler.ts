import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadId,
  type VmAgentBlocker,
  type VmAgentDelegation,
  VmAgentDelegationMessageId,
  VmAgentNotificationId,
  type VmAgentTask,
  type VmAgentTaskRun,
  type VmAgentId,
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

import { T3_BROWSER_CONTROL_POLICY } from "../browserControlPolicy.ts";
import { VM_AGENT_TASK_MESSAGE_ID_PREFIX } from "../orchestration/agentModeContinuation.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { VmAgentStore } from "../persistence/Services/VmAgents.ts";
import { VmAgentCollaborationStore } from "../persistence/Services/VmAgentCollaborations.ts";
import {
  type VmAgentTaskRunObservation,
  VmAgentWorkspaceStore,
} from "../persistence/Services/VmAgentWorkspaces.ts";
import { VmAgentCollaboration } from "./VmAgentCollaboration.ts";
import { VmAgentWorkspace } from "./VmAgentWorkspace.ts";

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

/**
 * How many times a runless run is re-dispatched before it is failed.
 *
 * Failing it stops one stuck run starving the agent's schedule, but on its own
 * it still leaves the user looking at a message that says "Queued" and never
 * moves. The dedupe is on `commandId`, so a retry under a fresh one is not
 * swallowed and the turn can actually start — which is the outcome anybody
 * waiting on a scheduled task actually wants. Only once retrying has stopped
 * helping is the run terminalized.
 */
export const MAX_RUN_START_RETRIES = 2;

/**
 * How long a run may wait to be dispatched at all before it is given up on.
 *
 * A queued run is usually waiting for a good reason: the agent's conversation
 * is busy, so starting a turn now would collide with one already in flight.
 * But some reasons never clear on their own — the user took manual control of
 * the agent, or its thread projection is missing — and because a unique index
 * allows one live run per agent, a run waiting on one of those freezes every
 * later occurrence too. An hour is far longer than any real turn, so a run
 * still queued after it is waiting on something that is not going to change.
 *
 * Giving up is not the same as dropping the work: a one-time task goes back on
 * the clock a few minutes later, and a recurring one already has its next
 * occurrence booked.
 */
export const RUN_DISPATCH_DEADLINE_MS = 3_600_000;

export const delegationWorkerThreadProvenance = (input: {
  readonly sourceThreadId: ThreadId;
  readonly inheritedBrowserProfileThreadId?: ThreadId | null | undefined;
}) => ({
  createdByThreadId: input.sourceThreadId,
  browserProfileThreadId: input.inheritedBrowserProfileThreadId ?? input.sourceThreadId,
});

export interface VmAgentTaskSchedulerShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly wake: () => Effect.Effect<void>;
  /**
   * Interrupt the agent's in-flight turn, if any. Used when an agent is
   * stopped: the status flip keeps new work from being claimed, this ends the
   * work already running. Best-effort; never fails.
   */
  readonly interruptAgent: (vmAgentId: VmAgentId) => Effect.Effect<void>;
}

export class VmAgentTaskScheduler extends Context.Service<
  VmAgentTaskScheduler,
  VmAgentTaskSchedulerShape
>()("t3/vm/VmAgentTaskScheduler") {}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

// Built from the shared prefix: the continuation budget and the turn-start
// launch path both recognize scheduled prompts by it, so drift here would
// silently reclassify every run prompt as a synthetic continuation.
const runMessageId = (runId: VmAgentTaskRunId) =>
  MessageId.make(`${VM_AGENT_TASK_MESSAGE_ID_PREFIX}${runId}`);
const runFailureMessageId = (runId: VmAgentTaskRunId) => MessageId.make(`vm-task-failed:${runId}`);
const runCommandId = (runId: VmAgentTaskRunId, attempt = 0) =>
  CommandId.make(attempt === 0 ? `vm-task:${runId}` : `vm-task:${runId}:retry:${attempt}`);

/** @internal Exported for tests: the blocker section is part of the contract with runs. */
export const taskPrompt = (
  task: VmAgentTask,
  delegation: VmAgentDelegation | null,
  pendingMessage?: string,
  openBlockers: ReadonlyArray<VmAgentBlocker> = [],
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
      T3_BROWSER_CONTROL_POLICY,
      "",
      "This is bounded delegated work. You may not create another agent or side chat. Use agent_collaboration to report notes or questions. Consequential external actions always require explicit human approval. Stay in this environment and use the inherited model; do not escalate to a paid model.",
    ].join("\n");
  }
  // Standing requests the agent raised on earlier runs. Injected so every run
  // starts knowing what it is waiting on — retest each, work around what you
  // can, and resolve_blocker the ones that no longer block.
  const blockerSection =
    openBlockers.length === 0
      ? []
      : [
          "",
          "Open blockers you previously reported (standing requests the user can see):",
          ...openBlockers.map(
            (blocker) =>
              `- [${blocker.blockerId}] ${blocker.title}: ${blocker.detail}${blocker.url ? ` (${blocker.url})` : ""}`,
          ),
          "Retest whether each still blocks you. Use agent_workspace resolve_blocker for any that are cleared, and report_blocker for new ones.",
        ];
  return [
    `[Scheduled task: ${task.title}]`,
    "",
    task.prompt,
    "",
    "Completion criteria:",
    criteria,
    ...blockerSection,
    "",
    "This is durable scheduled work for your custom-agent workspace. Use your browser tabs (the preview tools) when needed. When finished, summarize what changed, any evidence, and anything still blocked.",
  ].join("\n");
};

/** Milliseconds between two stored timestamps, or null if either is unusable. */
const elapsedMs = (from: string | null, to: string): number | null => {
  if (from === null) return null;
  try {
    return (
      DateTime.toEpochMillis(DateTime.makeUnsafe(to)) -
      DateTime.toEpochMillis(DateTime.makeUnsafe(from))
    );
  } catch {
    return null;
  }
};

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 4_000);

export const make = Effect.gen(function* () {
  const agents = yield* VmAgentStore;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const store = yield* VmAgentWorkspaceStore;
  const collaboration = yield* VmAgentCollaborationStore;
  const collaborationUpdates = yield* VmAgentCollaboration;
  const workspace = yield* VmAgentWorkspace;
  const wakeQueue = yield* Queue.sliding<void>(1);
  const started = yield* Ref.make(false);
  const activeRuns = new Map<string, Fiber.Fiber<void, never>>();
  /**
   * Start attempts already spent per run, for the stalled-dispatch retry.
   *
   * Deliberately not derived from `startedAt`: a retry goes through
   * `setRunRunning`, which rewrites `started_at` to the retry's own timestamp,
   * so elapsed time resets every attempt and a time-derived counter would
   * retry forever instead of eventually giving up.
   *
   * In memory rather than on the row because the budget only needs to bound
   * one process's retry loop. A restart relaunches the run from scratch, which
   * is a fresh chance for it to start, so a fresh budget is the right reading.
   */
  const runStartAttempts = new Map<string, number>();

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
      yield* collaborationUpdates.refresh;
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
      yield* collaborationUpdates.refresh;
    }
    runStartAttempts.delete(observation.run.runId);
    yield* workspace.refresh(observation.run.vmAgentId);
    return true;
  });

  const canStart = Effect.fn("VmAgentTaskScheduler.canStart")(function* (run: VmAgentTaskRun) {
    const delegated = yield* collaboration.getByTaskId(run.taskId);
    if (Option.isSome(delegated) && delegated.value.target.kind === "ephemeral") return true;
    const agent = yield* agents.getById(run.vmAgentId);
    if (Option.isNone(agent) || agent.value.threadId === null) {
      return false;
    }
    const thread = yield* projections.getThreadShellById(agent.value.threadId);
    if (Option.isNone(thread)) return false;
    return thread.value.latestTurn?.state !== "running" && thread.value.pendingWork == null;
  });

  /**
   * Says in the chat that a scheduled run failed.
   *
   * Only for runs that already posted their prompt. Such a run leaves a user
   * message on screen whose delivery indicator reads "Queued" — and because
   * that indicator is driven by provider receipts, a run that dies before the
   * provider ever takes the prompt produces no receipt and no further output,
   * so the message claims to be queued indefinitely with nothing anywhere
   * saying otherwise. Terminalizing the run in the task list does not reach
   * the person reading the thread; this does.
   */
  const postRunFailure = Effect.fn("VmAgentTaskScheduler.postRunFailure")(function* (
    run: VmAgentTaskRun,
    delegation: Option.Option<VmAgentDelegation>,
    detail: string,
    occurredAt: string,
  ) {
    // No message id means the run never got as far as posting the prompt, so
    // there is nothing on screen that needs explaining.
    if (run.messageId === null) return;
    const agent = yield* agents
      .getById(run.vmAgentId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    const threadId =
      Option.isSome(delegation) &&
      delegation.value.target.kind === "ephemeral" &&
      delegation.value.workerThreadId !== null
        ? delegation.value.workerThreadId
        : Option.isSome(agent)
          ? agent.value.threadId
          : null;
    if (threadId === null) return;
    const messageId = runFailureMessageId(run.runId);
    // Streamed then completed, which is the ordinary way an assistant message
    // is written; the pair is keyed on the run id, so a duplicate call is
    // absorbed by the projector's upsert rather than posting twice.
    yield* engine
      .dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make(`vm-task-failed:${run.runId}`),
        threadId,
        messageId,
        delta: `The scheduled task did not run. ${detail}`,
        createdAt: occurredAt,
      })
      .pipe(Effect.ignoreCause({ log: true }));
    yield* engine
      .dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make(`vm-task-failed-end:${run.runId}`),
        threadId,
        messageId,
        createdAt: occurredAt,
      })
      .pipe(Effect.ignoreCause({ log: true }));
  });

  const failRun = Effect.fn("VmAgentTaskScheduler.failRun")(function* (
    task: VmAgentTask | null,
    run: VmAgentTaskRun,
    error: unknown,
  ) {
    const detail = errorText(error);
    const completedAt = yield* nowIso;
    const delegation = yield* collaboration
      .getByRunId(run.runId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    yield* postRunFailure(run, delegation, detail, completedAt).pipe(
      Effect.ignoreCause({ log: true }),
    );
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
    if (Option.isSome(delegation)) yield* collaborationUpdates.refresh;
    runStartAttempts.delete(run.runId);
    yield* workspace.refresh(run.vmAgentId);
  });

  const executeRun = (run: VmAgentTaskRun, attempt = 0) =>
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
      if (agent.value.status !== "running") {
        // Claimed before the agent was stopped. Due tasks of a stopped agent
        // are no longer claimed at all, so this only settles the straggler.
        yield* failRun(
          task,
          run,
          new Error("The agent is stopped. Start it to resume scheduled work."),
        );
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
            ...delegationWorkerThreadProvenance({
              sourceThreadId: source.value.threadId,
              inheritedBrowserProfileThreadId: sourceThread.value.browserProfileThreadId,
            }),
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
      yield* store.setRunRunning({ runId: run.runId, messageId, startedAt });
      if (Option.isSome(delegated)) {
        yield* collaboration.markRunning({ runId: run.runId, startedAt, messageId });
        // The worker thread binding and running transition are one visible
        // lifecycle boundary, so publish them together rather than sending
        // two full collaboration snapshots.
        yield* collaborationUpdates.refresh;
      }
      yield* workspace.refresh(run.vmAgentId);
      const delegationMessages = Option.isSome(delegated)
        ? yield* collaboration.listMessages(delegated.value.delegationId)
        : [];
      const pendingMessage = delegationMessages.find((message) => message.delivery === "pending");
      // Standing blockers ride along in the prompt so the run starts knowing
      // what it is waiting on. Best-effort — catchCause, not orElseSucceed:
      // nothing about reading decoration may stop the run itself, defects
      // included.
      const openBlockers: ReadonlyArray<VmAgentBlocker> = yield* store.snapshot(run.vmAgentId).pipe(
        Effect.map((current) => current.blockers.filter((blocker) => blocker.resolvedAt === null)),
        Effect.catchCause(() => Effect.succeed([])),
      );
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: runCommandId(run.runId, attempt),
        threadId,
        message: {
          messageId,
          role: "user",
          text: taskPrompt(task, Option.getOrNull(delegated), pendingMessage?.text, openBlockers),
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
        yield* collaborationUpdates.refresh;
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

  const launch = (run: VmAgentTaskRun, attempt = 0) =>
    Effect.gen(function* () {
      if (activeRuns.has(run.runId)) return;
      const fiber = yield* executeRun(run, attempt).pipe(Effect.forkScoped);
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
    yield* collaborationUpdates.refresh;
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
      if (observation.run.status === "running" && observation.projectionTurnId === null) {
        const stalledForMs = elapsedMs(observation.run.startedAt, yield* nowIso);
        if (stalledForMs !== null && stalledForMs >= RUN_START_STALL_MS) {
          const attempt = (runStartAttempts.get(observation.run.runId) ?? 0) + 1;
          if (attempt <= MAX_RUN_START_RETRIES) {
            runStartAttempts.set(observation.run.runId, attempt);
            // `launch` re-runs the pre-flight, so this only proceeds if the
            // thread is still idle; and the message id is carried on the run,
            // so the retry updates the message already on screen in place
            // rather than posting the prompt a second time.
            yield* launch(observation.run, attempt);
            continue;
          }
          const task = yield* getTask(observation.run);
          yield* failRun(
            task,
            observation.run,
            new Error(
              `The scheduled turn never started, and ${MAX_RUN_START_RETRIES} retries did not get it moving. Run the task again or wait for its next occurrence.`,
            ),
          ).pipe(Effect.ignoreCause({ log: true }));
          continue;
        }
      }
      if (observation.run.status === "queued" || observation.run.status === "booting") {
        // Measured from creation, not `startedAt`: nothing has started, which
        // is the whole problem, so `startedAt` is still null here.
        const waitingMs = elapsedMs(observation.run.createdAt, yield* nowIso);
        if (waitingMs !== null && waitingMs >= RUN_DISPATCH_DEADLINE_MS) {
          const task = yield* getTask(observation.run);
          yield* failRun(
            task,
            observation.run,
            new Error(
              "The agent never became free to run this, so the occurrence was skipped. Its conversation was busy, or the agent was under manual control, for the whole hour it waited.",
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
      const delegation = yield* collaboration
        .getByTaskId(claimed.value.task.taskId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      yield* collaboration.markRunClaimed({
        taskId: claimed.value.task.taskId,
        runId: claimed.value.run.runId,
        updatedAt: now,
      });
      if (Option.isSome(delegation)) yield* collaborationUpdates.refresh;
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

  const interruptAgent: VmAgentTaskSchedulerShape["interruptAgent"] = (vmAgentId) =>
    Effect.gen(function* () {
      const agent = yield* agents.getById(vmAgentId);
      if (Option.isNone(agent) || agent.value.threadId === null) return;
      const threadId = agent.value.threadId;
      const thread = yield* projections.getThreadShellById(threadId);
      if (Option.isNone(thread)) return;
      const activeTurnId =
        thread.value.session?.activeTurnId ??
        (thread.value.latestTurn?.state === "running" ? thread.value.latestTurn.turnId : null);
      if (activeTurnId === null) return;
      const createdAt = yield* nowIso;
      yield* engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make(`vm-agent-stop:${vmAgentId}:${activeTurnId}`),
        threadId,
        turnId: activeTurnId,
        createdAt,
      });
    }).pipe(Effect.ignoreCause({ log: true }));

  return { start, wake, interruptAgent } satisfies VmAgentTaskSchedulerShape;
});

export const VmAgentTaskSchedulerLive = Layer.effect(VmAgentTaskScheduler, make);
