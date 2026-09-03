import {
  ThreadId,
  type VmAgentAttentionSnapshot,
  VmAgentId,
  VmAgentNotificationId,
  VmAgentTaskRunId,
  VmId,
  type VmAgent,
  type VmAgentWorkspaceSnapshot,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { VmAgentStoreLive } from "../persistence/Layers/VmAgents.ts";
import { VmAgentWorkspaceStoreLive } from "../persistence/Layers/VmAgentWorkspaces.ts";
import { VmAgentStore } from "../persistence/Services/VmAgents.ts";
import { VmAgentWorkspaceStore } from "../persistence/Services/VmAgentWorkspaces.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { VmAgentWorkspace, VmAgentWorkspaceLive } from "./VmAgentWorkspace.ts";

const stores = Layer.mergeAll(VmAgentStoreLive, VmAgentWorkspaceStoreLive).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
/** Interaction mode served per thread id; threads absent here have no shell. */
const threadInteractionModes = new Map<string, "default" | "plan" | "agent">();
const projectionStub = Layer.mock(ProjectionSnapshotQuery)({
  getThreadShellById: (threadId) =>
    Effect.sync(() => {
      const interactionMode = threadInteractionModes.get(String(threadId));
      return interactionMode === undefined
        ? Option.none()
        : Option.some({ interactionMode } as never);
    }),
});
const workspaceLayer = it.layer(
  VmAgentWorkspaceLive.pipe(Layer.provideMerge(stores), Layer.provide(projectionStub)),
);

const insertAgent = (suffix: string) =>
  Effect.gen(function* () {
    const store = yield* VmAgentStore;
    const createdAt = "2026-08-21T20:00:00.000Z";
    const agent: VmAgent = {
      vmAgentId: VmAgentId.make(`agent-${suffix}`),
      name: `Agent ${suffix}`,
      handle: `agent-${suffix}`,
      purpose: "Test durable work",
      vmId: VmId.make(`vm-${suffix}`),
      threadId: ThreadId.make(`thread-${suffix}`),
      status: "running",
      controlMode: "agent",
      icon: null,
      guestIp: "127.0.0.1",
      lastError: null,
      createdAt,
      updatedAt: createdAt,
    };
    yield* store.insert(agent);
    return agent;
  });

workspaceLayer("VmAgentWorkspace", (it) => {
  it.effect("creates default schedule state and enforces approval for agent recurrence", () =>
    Effect.gen(function* () {
      const workspace = yield* VmAgentWorkspace;
      const agent = yield* insertAgent("approval");

      yield* workspace.ensure(agent.vmAgentId);
      const initial = yield* workspace.snapshot(agent.vmAgentId);
      assert.strictEqual(initial.artifact?.definition.kind, "schedule");
      assert.strictEqual(initial.notificationPreferences.enabled, true);

      const task = yield* workspace.createTask({
        vmAgentId: agent.vmAgentId,
        title: "Daily dashboard",
        prompt: "Check the dashboard and summarize changes.",
        completionCriteria: ["Summary recorded"],
        schedule: { kind: "interval", everyMinutes: 1_440 },
        createdBy: "agent",
        activate: true,
      });
      assert.strictEqual(task.status, "draft");
      assert.strictEqual(task.approvalState, "pending");
      assert.strictEqual(task.nextRunAt, null);

      const approved = yield* workspace.updateTask({
        vmAgentId: agent.vmAgentId,
        taskId: task.taskId,
        status: "active",
        approvalState: "approved",
      });
      assert.strictEqual(approved.status, "active");
      assert.strictEqual(approved.approvalState, "approved");
      assert.isNotNull(approved.nextRunAt);
      yield* workspace.updateTask({
        vmAgentId: agent.vmAgentId,
        taskId: task.taskId,
        status: "paused",
      });
    }),
  );

  it.effect("auto-approves agent recurrence while the chat runs in Agent mode", () =>
    Effect.gen(function* () {
      const workspace = yield* VmAgentWorkspace;
      const agent = yield* insertAgent("auto-approve");
      threadInteractionModes.set(String(agent.threadId), "agent");

      const task = yield* workspace.createTask({
        vmAgentId: agent.vmAgentId,
        title: "Nightly sweep",
        prompt: "Run the sweep.",
        completionCriteria: [],
        schedule: { kind: "interval", everyMinutes: 60 },
        createdBy: "agent",
      });
      assert.strictEqual(task.status, "active");
      assert.strictEqual(task.approvalState, "approved");
      assert.isNotNull(task.nextRunAt);
      assert.isTrue(yield* workspace.autoApprovesTasks(agent.vmAgentId));

      // The control is honored: switching it off restores the approval flow
      // even in Agent mode, and an omitted flag on an unrelated preferences
      // update must not flip it back on.
      yield* workspace.updateNotificationPreferences({
        vmAgentId: agent.vmAgentId,
        enabled: true,
        taskCompletions: true,
        taskFailures: true,
        agentMessages: true,
        autoApproveTasks: false,
      });
      yield* workspace.updateNotificationPreferences({
        vmAgentId: agent.vmAgentId,
        enabled: false,
        taskCompletions: true,
        taskFailures: true,
        agentMessages: true,
      });
      const snapshot = yield* workspace.snapshot(agent.vmAgentId);
      assert.strictEqual(snapshot.notificationPreferences.autoApproveTasks, false);
      assert.strictEqual(snapshot.notificationPreferences.enabled, false);
      const gated = yield* workspace.createTask({
        vmAgentId: agent.vmAgentId,
        title: "Gated sweep",
        prompt: "Run the sweep.",
        completionCriteria: [],
        schedule: { kind: "interval", everyMinutes: 60 },
        createdBy: "agent",
        activate: true,
      });
      assert.strictEqual(gated.status, "draft");
      assert.strictEqual(gated.approvalState, "pending");
      assert.isFalse(yield* workspace.autoApprovesTasks(agent.vmAgentId));

      // Park the auto-approved interval task: under the shared TestClock its
      // nextRunAt is near epoch, and leaving it active would win claimNextDue
      // over the claim test's own 2020-dated tasks.
      yield* workspace.updateTask({
        vmAgentId: agent.vmAgentId,
        taskId: task.taskId,
        status: "paused",
      });
    }),
  );

  it.effect("keeps the approval flow when the chat is not in Agent mode", () =>
    Effect.gen(function* () {
      const workspace = yield* VmAgentWorkspace;
      const agent = yield* insertAgent("manual-mode");
      threadInteractionModes.set(String(agent.threadId), "default");

      const task = yield* workspace.createTask({
        vmAgentId: agent.vmAgentId,
        title: "Manual-mode sweep",
        prompt: "Run the sweep.",
        completionCriteria: [],
        schedule: { kind: "interval", everyMinutes: 60 },
        createdBy: "agent",
        activate: true,
      });
      assert.strictEqual(task.status, "draft");
      assert.strictEqual(task.approvalState, "pending");
      assert.isFalse(yield* workspace.autoApprovesTasks(agent.vmAgentId));
    }),
  );

  it.effect("normalizes once schedules to UTC so the due comparison cannot misfire", () =>
    Effect.gen(function* () {
      const workspace = yield* VmAgentWorkspace;
      const agent = yield* insertAgent("timezone");

      // Offset-ISO is exactly what an agent writes for "noon Eastern". Stored
      // verbatim, the lexicographic due check reads its LOCAL digits and fires
      // four hours early.
      const offsetTask = yield* workspace.createTask({
        vmAgentId: agent.vmAgentId,
        title: "Noon Eastern check",
        prompt: "Check the thread.",
        completionCriteria: [],
        schedule: { kind: "once", runAt: "2026-08-22T12:00:00-04:00" },
        createdBy: "user",
      });
      assert.strictEqual(offsetTask.nextRunAt, "2026-08-22T16:00:00.000Z");

      // An unparseable runAt schedules nothing rather than something wrong.
      const invalidTask = yield* workspace.createTask({
        vmAgentId: agent.vmAgentId,
        title: "Broken schedule",
        prompt: "Never runs.",
        completionCriteria: [],
        schedule: { kind: "once", runAt: "next tuesday at noon" },
        createdBy: "user",
      });
      assert.strictEqual(invalidTask.nextRunAt, null);
    }),
  );

  it.effect("publishes complete snapshots after mutations", () =>
    Effect.gen(function* () {
      const workspace = yield* VmAgentWorkspace;
      const agent = yield* insertAgent("stream");
      const snapshots: VmAgentWorkspaceSnapshot[] = [];
      const unsubscribe = yield* workspace.subscribe(agent.vmAgentId, (snapshot) =>
        Effect.sync(() => snapshots.push(snapshot)),
      );
      yield* workspace.createTask({
        vmAgentId: agent.vmAgentId,
        title: "Manual check",
        prompt: "Check the current page.",
        completionCriteria: [],
        schedule: null,
        createdBy: "user",
      });
      unsubscribe();

      assert.strictEqual(snapshots.length, 2);
      assert.strictEqual(snapshots[0]?.tasks.length, 0);
      assert.strictEqual(snapshots[1]?.tasks[0]?.title, "Manual check");
    }),
  );

  it.effect("claims only one due run per agent and advances recurrence", () =>
    Effect.gen(function* () {
      const workspace = yield* VmAgentWorkspace;
      const store = yield* VmAgentWorkspaceStore;
      const agent = yield* insertAgent("claim");
      const first = yield* workspace.createTask({
        vmAgentId: agent.vmAgentId,
        title: "First",
        prompt: "Run first.",
        completionCriteria: [],
        schedule: { kind: "once", runAt: "2020-01-01T00:00:00.000Z" },
        createdBy: "user",
      });
      yield* workspace.createTask({
        vmAgentId: agent.vmAgentId,
        title: "Second",
        prompt: "Run second.",
        completionCriteria: [],
        schedule: { kind: "once", runAt: "2020-01-01T00:01:00.000Z" },
        createdBy: "user",
      });

      const claimed = yield* store.claimNextDue({
        runId: VmAgentTaskRunId.make("run-first"),
        now: "2026-08-21T21:00:00.000Z",
      });
      assert.isTrue(Option.isSome(claimed));
      assert.strictEqual(Option.getOrThrow(claimed).task.taskId, first.taskId);

      const blocked = yield* store.claimNextDue({
        runId: VmAgentTaskRunId.make("run-second"),
        now: "2026-08-21T21:00:00.000Z",
      });
      assert.isTrue(Option.isNone(blocked));
    }),
  );

  it.effect("honors notification preferences and rate-limits direct agent messages", () =>
    Effect.gen(function* () {
      const workspace = yield* VmAgentWorkspace;
      const agent = yield* insertAgent("notify");
      yield* workspace.ensure(agent.vmAgentId);
      yield* workspace.updateNotificationPreferences({
        vmAgentId: agent.vmAgentId,
        enabled: false,
        taskCompletions: true,
        taskFailures: true,
        agentMessages: true,
      });
      const suppressed = yield* workspace.notify({
        vmAgentId: agent.vmAgentId,
        kind: "agent-message",
        title: "Hidden",
        body: "This is disabled.",
      });
      assert.isFalse(suppressed);
      assert.strictEqual((yield* workspace.snapshot(agent.vmAgentId)).notifications.length, 0);

      yield* workspace.updateNotificationPreferences({
        vmAgentId: agent.vmAgentId,
        enabled: true,
        taskCompletions: true,
        taskFailures: true,
        agentMessages: true,
      });
      for (let index = 0; index < 10; index += 1) {
        const delivered = yield* workspace.notify({
          vmAgentId: agent.vmAgentId,
          kind: "agent-message",
          title: `Message ${index}`,
          body: "Update",
        });
        assert.isTrue(delivered);
      }
      const error = yield* Effect.flip(
        workspace.notify({
          vmAgentId: agent.vmAgentId,
          kind: "agent-message",
          title: "Too many",
          body: "Update",
        }),
      );
      assert.strictEqual(error._tag, "VmAgentWorkspaceOperationError");
    }),
  );

  it.effect("expires archived mail past its retention window on the next read", () =>
    Effect.gen(function* () {
      const workspace = yield* VmAgentWorkspace;
      const store = yield* VmAgentWorkspaceStore;
      const agent = yield* insertAgent("expiry");
      const expiredId = VmAgentNotificationId.make("expired-mail");
      const freshId = VmAgentNotificationId.make("fresh-mail");
      yield* workspace.notify({
        vmAgentId: agent.vmAgentId,
        notificationId: expiredId,
        kind: "agent-message",
        title: "Old",
        body: "Archived long ago.",
      });
      yield* workspace.notify({
        vmAgentId: agent.vmAgentId,
        notificationId: freshId,
        kind: "agent-message",
        title: "New",
        body: "Archived just now.",
      });

      // One archived now (inside the window), one backdated as if two days
      // had passed since the user archived it. "Now" is the TestClock's epoch,
      // so the backdated archive must predate 1970, not merely today.
      yield* workspace.updateNotification({
        vmAgentId: agent.vmAgentId,
        notificationId: freshId,
        archived: true,
      });
      yield* store.updateNotification({
        vmAgentId: agent.vmAgentId,
        notificationId: expiredId,
        archivedAt: "1969-12-01T00:00:00.000Z",
      });

      const snapshot = yield* workspace.snapshot(agent.vmAgentId);
      assert.deepStrictEqual(
        snapshot.notifications.map((notification) => notification.notificationId),
        [freshId],
      );
    }),
  );

  it.effect(
    "streams lightweight unread and waiting-on-you counts across reversible inbox state",
    () =>
      Effect.gen(function* () {
        const workspace = yield* VmAgentWorkspace;
        const agent = yield* insertAgent("attention");
        const notificationId = VmAgentNotificationId.make("attention-notification");
        const snapshots: VmAgentAttentionSnapshot[] = [];
        const unsubscribe = yield* workspace.subscribeAttention((snapshot) =>
          Effect.sync(() => snapshots.push(snapshot)),
        );
        const latest = () =>
          snapshots.at(-1)?.agents.find((entry) => entry.vmAgentId === agent.vmAgentId);

        yield* workspace.notify({
          vmAgentId: agent.vmAgentId,
          notificationId,
          kind: "agent-message",
          title: "Launch report",
          body: "**Ready** for review.",
        });
        assert.strictEqual(latest()?.unreadNotificationCount, 1);

        yield* workspace.updateNotification({
          vmAgentId: agent.vmAgentId,
          notificationId,
          read: true,
        });
        assert.strictEqual(latest()?.unreadNotificationCount, 0);

        yield* workspace.updateNotification({
          vmAgentId: agent.vmAgentId,
          notificationId,
          read: false,
        });
        assert.strictEqual(latest()?.unreadNotificationCount, 1);

        yield* workspace.updateNotification({
          vmAgentId: agent.vmAgentId,
          notificationId,
          archived: true,
        });
        assert.strictEqual(latest()?.unreadNotificationCount, 0);
        assert.isNotNull((yield* workspace.snapshot(agent.vmAgentId)).notifications[0]?.archivedAt);

        yield* workspace.updateNotification({
          vmAgentId: agent.vmAgentId,
          notificationId,
          archived: false,
        });
        assert.strictEqual(latest()?.unreadNotificationCount, 1);

        const blocker = yield* workspace.raiseBlocker({
          vmAgentId: agent.vmAgentId,
          title: "Sign-in required",
          detail: "The agent needs a human sign-in.",
        });
        assert.strictEqual(latest()?.openBlockerCount, 1);
        // Waiting-on-you is already durable attention. It must not also add an
        // inbox row or increment the independent notification badge.
        assert.strictEqual(latest()?.unreadNotificationCount, 1);
        assert.isUndefined(
          (yield* workspace.snapshot(agent.vmAgentId)).notifications.find((notification) =>
            notification.title.startsWith("Waiting on you:"),
          ),
        );
        yield* workspace.resolveBlocker({
          vmAgentId: agent.vmAgentId,
          blockerId: blocker.blockerId,
          resolvedBy: "user",
        });
        assert.strictEqual(latest()?.openBlockerCount, 0);
        assert.strictEqual(latest()?.unreadNotificationCount, 1);
        unsubscribe();
      }),
  );
});
