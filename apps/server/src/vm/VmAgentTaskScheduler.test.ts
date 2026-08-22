import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  VmAgentDelegationId,
  VmAgentDelegationMessageId,
  VmAgentId,
  VmAgentTaskId,
  VmAgentTaskRunId,
  VmId,
  type OrchestrationCommand,
  type VmAgent,
  type VmAgentTask,
  type VmAgentTaskRun,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { VmAgentStore } from "../persistence/Services/VmAgents.ts";
import { VmAgentCollaborationStore } from "../persistence/Services/VmAgentCollaborations.ts";
import { VmAgentWorkspaceStore } from "../persistence/Services/VmAgentWorkspaces.ts";
import { VmAgentWorkspace } from "./VmAgentWorkspace.ts";
import { VmAgentTaskScheduler, VmAgentTaskSchedulerLive } from "./VmAgentTaskScheduler.ts";
import { VmManager } from "./VmManager.ts";

const iso = "2026-08-21T20:00:00.000Z";
const vmAgentId = VmAgentId.make("agent-scheduler");
const threadId = ThreadId.make("thread-scheduler");
const task: VmAgentTask = {
  taskId: VmAgentTaskId.make("task-scheduler"),
  vmAgentId,
  title: "Check dashboard",
  prompt: "Open the dashboard and summarize changes.",
  completionCriteria: ["Summary provided"],
  status: "active",
  schedule: { kind: "interval", everyMinutes: 60 },
  nextRunAt: iso,
  createdBy: "user",
  approvalState: "approved",
  notificationPolicy: "always",
  artifactId: null,
  createdAt: iso,
  updatedAt: iso,
};
const run: VmAgentTaskRun = {
  runId: VmAgentTaskRunId.make("run-scheduler"),
  taskId: task.taskId,
  vmAgentId,
  status: "queued",
  messageId: null,
  turnId: null,
  scheduledFor: iso,
  startedAt: null,
  completedAt: null,
  resultSummary: null,
  error: null,
  createdAt: iso,
  updatedAt: iso,
};
const agent: VmAgent = {
  vmAgentId,
  name: "Scheduler",
  handle: "scheduler",
  purpose: "Run durable tasks",
  vmId: VmId.make("vm-scheduler"),
  threadId,
  status: "running",
  controlMode: "agent",
  guestIp: "127.0.0.1",
  lastError: null,
  createdAt: iso,
  updatedAt: iso,
};

const collaborationLayer = Layer.mock(VmAgentCollaborationStore)({
  getByRunId: () => Effect.succeed(Option.none()),
  getByTaskId: () => Effect.succeed(Option.none()),
  listExpired: () => Effect.succeed([]),
});

it.effect(
  "defers a queued task while the dedicated conversation is busy, then boots and dispatches it",
  () =>
    Effect.gen(function* () {
      let busy = true;
      let bootCount = 0;
      const commands: OrchestrationCommand[] = [];
      const firstBusyCheck = yield* Deferred.make<void>();
      const dispatched = yield* Deferred.make<void>();

      const storeLayer = Layer.mock(VmAgentWorkspaceStore)({
        listRunObservations: () =>
          Effect.succeed([
            { run, projectionState: null, projectionTurnId: null, assistantText: null },
          ]),
        getTask: () => Effect.succeed(Option.some(task)),
        claimNextDue: () => Effect.succeed(Option.none()),
        setRunBooting: () => Effect.void,
        setRunRunning: ({ messageId }) =>
          Effect.sync(() => assert.strictEqual(messageId, MessageId.make(`vm-task:${run.runId}`))),
        completeRun: () => Effect.void,
      });
      const agentLayer = Layer.mock(VmAgentStore)({
        getById: () => Effect.succeed(Option.some(agent)),
      });
      const projectionLayer = Layer.mock(ProjectionSnapshotQuery)({
        getThreadShellById: () =>
          Effect.gen(function* () {
            if (busy) yield* Deferred.succeed(firstBusyCheck, undefined).pipe(Effect.ignore);
            return Option.some({
              id: threadId,
              projectId: ProjectId.make("solla-agents"),
              title: "Scheduler",
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              latestTurn: busy
                ? {
                    turnId: "busy-turn",
                    state: "running",
                    requestedAt: iso,
                    startedAt: iso,
                    completedAt: null,
                    assistantMessageId: null,
                  }
                : null,
              createdAt: iso,
              updatedAt: iso,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              session: null,
              latestUserMessageAt: iso,
              hasPendingApprovals: false,
              hasPendingUserInput: false,
              hasActionableProposedPlan: false,
            } as never);
          }),
      });
      const managerLayer = Layer.mock(VmManager)({
        ensureRunning: () =>
          Effect.sync(() => {
            bootCount += 1;
            return agent;
          }),
      });
      const workspaceLayer = Layer.mock(VmAgentWorkspace)({ refresh: () => Effect.void });
      const engineLayer = Layer.mock(OrchestrationEngineService)({
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
          }).pipe(
            Effect.andThen(Deferred.succeed(dispatched, undefined)),
            Effect.as({ sequence: 1 }),
          ),
      });
      const dependencies = Layer.mergeAll(
        storeLayer,
        agentLayer,
        projectionLayer,
        managerLayer,
        workspaceLayer,
        engineLayer,
        collaborationLayer,
      );
      const schedulerLayer = VmAgentTaskSchedulerLive.pipe(Layer.provide(dependencies));

      yield* Effect.gen(function* () {
        const scheduler = yield* VmAgentTaskScheduler;
        yield* scheduler.start();
        yield* Deferred.await(firstBusyCheck);
        assert.strictEqual(commands.length, 0);

        busy = false;
        yield* scheduler.wake();
        yield* Deferred.await(dispatched);
        assert.strictEqual(bootCount, 1);
        assert.strictEqual(commands.length, 1);
        const command = commands[0];
        assert.strictEqual(command?.type, "thread.turn.start");
        if (command?.type === "thread.turn.start") {
          assert.strictEqual(command.threadId, threadId);
          assert.include(command.message.text, "Check dashboard");
          assert.include(command.message.text, "Summary provided");
        }
      }).pipe(Effect.provide(schedulerLayer), Effect.scoped);
    }),
);

it.effect("fails a running run whose turn never projected instead of retrying forever", () =>
  Effect.gen(function* () {
    const failed = yield* Deferred.make<void>();
    let completed: { status: string; error: string | null } | null = null;
    // A turn.start that raced an already-running turn: the command was
    // receipted, so retries dedupe to nothing and no turn ever projects.
    const stuckRun: VmAgentTaskRun = {
      ...run,
      runId: VmAgentTaskRunId.make("run-stuck"),
      status: "running",
      messageId: MessageId.make("vm-task:run-stuck"),
      startedAt: "1970-01-01T00:00:00.000Z",
    };

    const storeLayer = Layer.mock(VmAgentWorkspaceStore)({
      listRunObservations: () =>
        Effect.succeed([
          { run: stuckRun, projectionState: null, projectionTurnId: null, assistantText: null },
        ]),
      getTask: () => Effect.succeed(Option.some(task)),
      claimNextDue: () => Effect.succeed(Option.none()),
      completeRun: (input) =>
        Effect.sync(() => {
          completed = { status: input.status, error: input.error };
        }).pipe(Effect.andThen(Deferred.succeed(failed, undefined)), Effect.asVoid),
    });
    const agentLayer = Layer.mock(VmAgentStore)({
      getById: () => Effect.succeed(Option.some(agent)),
    });
    // The dedicated thread stays busy, so the launch fallback path can never
    // dispatch — only the stall detector can resolve this run.
    const projectionLayer = Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: () =>
        Effect.succeed(
          Option.some({
            latestTurn: { state: "running" },
            pendingWork: null,
          } as never),
        ),
    });
    const workspaceLayer = Layer.mock(VmAgentWorkspace)({
      refresh: () => Effect.void,
      snapshot: () => Effect.succeed({ notificationPreferences: { enabled: false } } as never),
    });
    const stallCollaborationLayer = Layer.mock(VmAgentCollaborationStore)({
      getByRunId: () => Effect.succeed(Option.none()),
      getByTaskId: () => Effect.succeed(Option.none()),
      listExpired: () => Effect.succeed([]),
      complete: () => Effect.void,
    });
    const engineLayer = Layer.mock(OrchestrationEngineService)({
      dispatch: () => Effect.succeed({ sequence: 1 } as never),
    });
    const dependencies = Layer.mergeAll(
      storeLayer,
      agentLayer,
      projectionLayer,
      Layer.mock(VmManager)({}),
      workspaceLayer,
      engineLayer,
      stallCollaborationLayer,
    );
    const schedulerLayer = VmAgentTaskSchedulerLive.pipe(Layer.provide(dependencies));

    yield* Effect.gen(function* () {
      const scheduler = yield* VmAgentTaskScheduler;
      yield* scheduler.start();
      // Under the stall threshold nothing is failed; past it, the drain
      // terminalizes the run so the agent's schedule stops being starved.
      yield* TestClock.adjust(Duration.minutes(3));
      yield* scheduler.wake();
      yield* Deferred.await(failed);
      assert.strictEqual(completed?.status, "failed");
      assert.include(completed?.error ?? "", "never started");
    }).pipe(Effect.provide(schedulerLayer), Effect.scoped);
  }),
);

it.effect("fails a running run whose projected turn never left pending", () =>
  Effect.gen(function* () {
    const failed = yield* Deferred.make<void>();
    let completed: { status: string; error: string | null } | null = null;
    // Observed in the wild: the dispatch DID project a turn, but it sat in
    // `pending` with no turn id for over an hour. Keying the stall check on
    // `projectionState === null` missed it entirely — the run stayed `running`
    // and starved every later task for that agent.
    const pendingRun: VmAgentTaskRun = {
      ...run,
      runId: VmAgentTaskRunId.make("run-pending"),
      status: "running",
      messageId: MessageId.make("vm-task:run-pending"),
      startedAt: "1970-01-01T00:00:00.000Z",
    };

    const storeLayer = Layer.mock(VmAgentWorkspaceStore)({
      listRunObservations: () =>
        Effect.succeed([
          {
            run: pendingRun,
            projectionState: "pending",
            projectionTurnId: null,
            assistantText: null,
          },
        ]),
      getTask: () => Effect.succeed(Option.some(task)),
      claimNextDue: () => Effect.succeed(Option.none()),
      completeRun: (input) =>
        Effect.sync(() => {
          completed = { status: input.status, error: input.error };
        }).pipe(Effect.andThen(Deferred.succeed(failed, undefined)), Effect.asVoid),
    });
    const agentLayer = Layer.mock(VmAgentStore)({
      getById: () => Effect.succeed(Option.some(agent)),
    });
    // Deliberately NOT busy: the real case had an idle `ready` session whose
    // previous turn completed twenty minutes earlier, so this is not the
    // already-running race — and the launch fallback still cannot fire,
    // because it only handles a wholly absent projection.
    const projectionLayer = Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: () =>
        Effect.succeed(
          Option.some({
            latestTurn: { state: "completed" },
            pendingWork: null,
          } as never),
        ),
    });
    const workspaceLayer = Layer.mock(VmAgentWorkspace)({
      refresh: () => Effect.void,
      snapshot: () => Effect.succeed({ notificationPreferences: { enabled: false } } as never),
    });
    const pendingCollaborationLayer = Layer.mock(VmAgentCollaborationStore)({
      getByRunId: () => Effect.succeed(Option.none()),
      getByTaskId: () => Effect.succeed(Option.none()),
      listExpired: () => Effect.succeed([]),
      complete: () => Effect.void,
    });
    const engineLayer = Layer.mock(OrchestrationEngineService)({
      dispatch: () => Effect.succeed({ sequence: 1 } as never),
    });
    const dependencies = Layer.mergeAll(
      storeLayer,
      agentLayer,
      projectionLayer,
      Layer.mock(VmManager)({}),
      workspaceLayer,
      engineLayer,
      pendingCollaborationLayer,
    );
    const schedulerLayer = VmAgentTaskSchedulerLive.pipe(Layer.provide(dependencies));

    yield* Effect.gen(function* () {
      const scheduler = yield* VmAgentTaskScheduler;
      yield* scheduler.start();
      yield* TestClock.adjust(Duration.minutes(3));
      yield* scheduler.wake();
      yield* Deferred.await(failed);
      assert.strictEqual(completed?.status, "failed");
      assert.include(completed?.error ?? "", "never started");
    }).pipe(Effect.provide(schedulerLayer), Effect.scoped);
  }),
);

it.effect("persists a deduplicated notification before terminalizing a completed run", () =>
  Effect.gen(function* () {
    const order: string[] = [];
    const completed = yield* Deferred.make<void>();
    const runningRun: VmAgentTaskRun = {
      ...run,
      status: "running",
      messageId: MessageId.make(`vm-task:${run.runId}`),
      startedAt: iso,
    };
    const storeLayer = Layer.mock(VmAgentWorkspaceStore)({
      listRunObservations: () =>
        Effect.succeed([
          {
            run: runningRun,
            projectionState: "completed" as const,
            projectionTurnId: "turn-completed",
            assistantText: "Dashboard summary ready.",
          },
        ]),
      getTask: () => Effect.succeed(Option.some(task)),
      claimNextDue: () => Effect.succeed(Option.none()),
      completeRun: () =>
        Effect.sync(() => order.push("complete")).pipe(
          Effect.andThen(Deferred.succeed(completed, undefined)),
          Effect.asVoid,
        ),
    });
    const workspaceLayer = Layer.mock(VmAgentWorkspace)({
      snapshot: () =>
        Effect.succeed({
          type: "snapshot" as const,
          vmAgentId,
          tasks: [task],
          runs: [runningRun],
          artifact: null,
          notifications: [],
          notificationPreferences: {
            vmAgentId,
            enabled: true,
            taskCompletions: true,
            taskFailures: true,
            agentMessages: true,
            updatedAt: iso,
          },
        }),
      notify: () => Effect.sync(() => order.push("notify")).pipe(Effect.as(true)),
      refresh: () => Effect.void,
    });
    const dependencies = Layer.mergeAll(
      storeLayer,
      workspaceLayer,
      Layer.mock(VmAgentStore)({}),
      Layer.mock(ProjectionSnapshotQuery)({}),
      Layer.mock(VmManager)({}),
      Layer.mock(OrchestrationEngineService)({}),
      collaborationLayer,
    );
    const schedulerLayer = VmAgentTaskSchedulerLive.pipe(Layer.provide(dependencies));

    yield* Effect.gen(function* () {
      const scheduler = yield* VmAgentTaskScheduler;
      yield* scheduler.start();
      yield* Deferred.await(completed);
      assert.deepStrictEqual(order, ["notify", "complete"]);
    }).pipe(Effect.provide(schedulerLayer), Effect.scoped);
  }),
);

it.effect("re-arms a pending delegation follow-up after the current turn settles", () =>
  Effect.gen(function* () {
    const workerThreadId = ThreadId.make("delegation-worker:followup");
    const followupDelegationId = VmAgentDelegationId.make("delegation-followup");
    const firstRun: VmAgentTaskRun = {
      ...run,
      status: "running",
      messageId: MessageId.make("delegation-first-message"),
      startedAt: iso,
    };
    const followupRun: VmAgentTaskRun = {
      ...run,
      runId: VmAgentTaskRunId.make("run-followup"),
      status: "queued",
    };
    const delegation = {
      delegationId: followupDelegationId,
      rootVmAgentId: vmAgentId,
      sourceVmAgentId: vmAgentId,
      targetVmAgentId: null,
      target: { kind: "ephemeral" },
      workerThreadId,
      taskId: task.taskId,
      runId: firstRun.runId,
      title: "Follow-up",
      task: "Initial delegated work.",
      completionCriteria: [],
      requestedCapabilities: [],
      status: "queued",
    } as never;
    const pendingMessage = {
      messageId: VmAgentDelegationMessageId.make("pending-followup-message"),
      delegationId: followupDelegationId,
      sequence: 2,
      sender: "source-agent",
      senderVmAgentId: vmAgentId,
      kind: "note",
      delivery: "pending",
      text: "Check the final edge case.",
      createdAt: iso,
    } as const;
    const dispatched = yield* Deferred.make<void>();
    const order: string[] = [];
    let observed = false;
    let claimed = false;
    const followupTask = {
      ...task,
      schedule: { kind: "once" as const, runAt: iso },
      notificationPolicy: "never" as const,
    };
    const storeLayer = Layer.mock(VmAgentWorkspaceStore)({
      listRunObservations: () =>
        Effect.sync(() => {
          if (observed) return [];
          observed = true;
          return [
            {
              run: firstRun,
              projectionState: "completed" as const,
              projectionTurnId: "turn-first",
              assistantText: "Initial pass complete.",
            },
          ];
        }),
      getTask: () => Effect.succeed(Option.some(followupTask)),
      completeRun: () => Effect.sync(() => order.push("complete-current-run")),
      claimNextDue: () =>
        Effect.sync(() => {
          if (claimed || !order.includes("requeue-followup")) return Option.none();
          claimed = true;
          order.push("claim-followup");
          return Option.some({ task: followupTask, run: followupRun });
        }),
      setRunBooting: () => Effect.void,
      setRunRunning: () => Effect.void,
    });
    const collaborationStoreLayer = Layer.mock(VmAgentCollaborationStore)({
      getByRunId: () => Effect.succeed(Option.some(delegation)),
      getByTaskId: () => Effect.succeed(Option.some(delegation)),
      listMessages: () => Effect.succeed([pendingMessage]),
      requeuePendingFollowup: () => Effect.sync(() => order.push("requeue-followup")),
      markRunClaimed: () => Effect.void,
      markRunning: () => Effect.void,
      markMessageDelivered: () => Effect.void,
      listExpired: () => Effect.succeed([]),
    });
    const sourceThread = {
      id: threadId,
      projectId: ProjectId.make("solla-agents"),
      title: "Scheduler",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "agent",
      latestTurn: null,
      pendingWork: null,
    };
    const projectionLayer = Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (requestedThreadId) =>
        Effect.succeed(
          Option.some(
            requestedThreadId === workerThreadId
              ? { ...sourceThread, id: workerThreadId, isSideChat: true }
              : sourceThread,
          ) as never,
        ),
    });
    const workspaceLayer = Layer.mock(VmAgentWorkspace)({
      snapshot: () =>
        Effect.succeed({
          notificationPreferences: { enabled: false },
        } as never),
      refresh: () => Effect.void,
    });
    const engineLayer = Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        Effect.sync(() => {
          if (command.type === "thread.turn.start") {
            order.push("dispatch-followup");
            assert.strictEqual(command.threadId, workerThreadId);
            assert.strictEqual(command.message.delegationId, followupDelegationId);
            assert.include(command.message.text, pendingMessage.text);
          }
          return { sequence: 1 };
        }).pipe(Effect.tap(() => Deferred.succeed(dispatched, undefined))),
    });
    const dependencies = Layer.mergeAll(
      storeLayer,
      collaborationStoreLayer,
      Layer.mock(VmAgentStore)({ getById: () => Effect.succeed(Option.some(agent)) }),
      projectionLayer,
      Layer.mock(VmManager)({}),
      workspaceLayer,
      engineLayer,
    );
    const schedulerLayer = VmAgentTaskSchedulerLive.pipe(Layer.provide(dependencies));

    yield* Effect.gen(function* () {
      const scheduler = yield* VmAgentTaskScheduler;
      yield* scheduler.start();
      yield* Deferred.await(dispatched);
      assert.deepStrictEqual(order, [
        "complete-current-run",
        "requeue-followup",
        "claim-followup",
        "dispatch-followup",
      ]);
    }).pipe(Effect.provide(schedulerLayer), Effect.scoped);
  }),
);

it.effect(
  "expires delegated work before claiming new runs and interrupts its exact active turn",
  () =>
    Effect.gen(function* () {
      const expiredThreadId = ThreadId.make("delegation-worker:expired");
      const expiredDelegationId = VmAgentDelegationId.make("delegation-expired");
      const expiredDelegation = {
        delegationId: expiredDelegationId,
        workerThreadId: expiredThreadId,
        targetVmAgentId: null,
        target: { kind: "ephemeral" },
      } as never;
      const drained = yield* Deferred.make<void>();
      const order: string[] = [];
      let listed = false;
      const collaborationStoreLayer = Layer.mock(VmAgentCollaborationStore)({
        listExpired: () =>
          Effect.sync(() => {
            if (listed) return [];
            listed = true;
            return [expiredDelegation];
          }),
        cancel: ({ delegationId, status }) =>
          Effect.sync(() => {
            assert.strictEqual(delegationId, expiredDelegationId);
            assert.strictEqual(status, "expired");
            order.push("cancel");
          }),
        getByTaskId: () => Effect.succeed(Option.none()),
        getByRunId: () => Effect.succeed(Option.none()),
      });
      const workspaceStoreLayer = Layer.mock(VmAgentWorkspaceStore)({
        listRunObservations: () => Effect.succeed([]),
        claimNextDue: () =>
          Effect.sync(() => {
            order.push("claim");
            return Option.none();
          }).pipe(Effect.tap(() => Deferred.succeed(drained, undefined))),
      });
      const projectionLayer = Layer.mock(ProjectionSnapshotQuery)({
        getThreadShellById: () =>
          Effect.succeed(
            Option.some({
              session: { activeTurnId: "turn-expired" },
              latestTurn: null,
            } as never),
          ),
      });
      const engineLayer = Layer.mock(OrchestrationEngineService)({
        dispatch: (command) =>
          Effect.sync(() => {
            assert.strictEqual(command.type, "thread.turn.interrupt");
            if (command.type === "thread.turn.interrupt") {
              assert.strictEqual(command.threadId, expiredThreadId);
              assert.strictEqual(command.turnId, "turn-expired");
            }
            order.push("interrupt");
            return { sequence: 1 };
          }),
      });
      const dependencies = Layer.mergeAll(
        workspaceStoreLayer,
        collaborationStoreLayer,
        Layer.mock(VmAgentStore)({}),
        projectionLayer,
        Layer.mock(VmManager)({}),
        Layer.mock(VmAgentWorkspace)({}),
        engineLayer,
      );
      const schedulerLayer = VmAgentTaskSchedulerLive.pipe(Layer.provide(dependencies));

      yield* Effect.gen(function* () {
        const scheduler = yield* VmAgentTaskScheduler;
        yield* scheduler.start();
        yield* Deferred.await(drained);
        assert.deepStrictEqual(order.slice(0, 3), ["cancel", "interrupt", "claim"]);
      }).pipe(Effect.provide(schedulerLayer), Effect.scoped);
    }),
);
