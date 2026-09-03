import {
  MessageId,
  ThreadId,
  type VmAgent,
  VmAgentArtifactId,
  VmAgentBlockerId,
  VmAgentId,
  VmAgentNotificationId,
  type VmAgentTask,
  VmAgentTaskId,
  VmAgentTaskRunId,
  VmId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { VmAgentStore } from "../Services/VmAgents.ts";
import { VmAgentWorkspaceStore } from "../Services/VmAgentWorkspaces.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { VmAgentStoreLive } from "./VmAgents.ts";
import {
  MISSED_OCCURRENCE_ATTEMPTS,
  NOTIFICATION_KEEP_RECENT,
  RUN_HISTORY_KEEP_RECENT,
  RUN_HISTORY_RETENTION_DAYS,
  VmAgentWorkspaceStoreLive,
} from "./VmAgentWorkspaces.ts";

/**
 * A fresh database per scenario.
 *
 * The due query picks the globally earliest task, not one scoped to the agent
 * under test, so a task another test left armed is a task this test will
 * claim. Sharing one store between scenarios makes them claim each other's
 * work in whatever order the runner happens to use.
 */
const stores = () =>
  Layer.mergeAll(VmAgentStoreLive, VmAgentWorkspaceStoreLive).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  );

const createdAt = "2026-08-21T20:00:00.000Z";
const vmAgentId = VmAgentId.make("workspace-agent");
const taskId = VmAgentTaskId.make("workspace-task");

const agent: VmAgent = {
  vmAgentId,
  name: "Workspace",
  handle: "workspace",
  purpose: "Run durable work",
  vmId: VmId.make("workspace-vm"),
  threadId: ThreadId.make("workspace-thread"),
  status: "running",
  controlMode: "agent",
  icon: null,
  guestIp: "127.0.0.1",
  lastError: null,
  createdAt,
  updatedAt: createdAt,
};

/** Inserts the agent and one task, armed for `runAt`. */
const givenTask = (schedule: VmAgentTask["schedule"], runAt: string) =>
  Effect.gen(function* () {
    const agents = yield* VmAgentStore;
    const store = yield* VmAgentWorkspaceStore;
    yield* agents.insert(agent);
    yield* store.ensureDefaults({
      vmAgentId,
      artifactId: VmAgentArtifactId.make("workspace-artifact"),
      now: createdAt,
    });
    return yield* store.createTask({
      taskId,
      vmAgentId,
      title: "Check the dashboard",
      prompt: "Open the dashboard and report what changed.",
      completionCriteria: ["Reported"],
      status: "active",
      schedule,
      nextRunAt: runAt,
      createdBy: "user",
      approvalState: "approved",
      notificationPolicy: "always",
      artifactId: null,
      createdAt,
    });
  });

const readTask = Effect.gen(function* () {
  const store = yield* VmAgentWorkspaceStore;
  return Option.getOrThrow(yield* store.getTask(vmAgentId, taskId));
});

const claim = (runSuffix: string, now: string) =>
  Effect.gen(function* () {
    const store = yield* VmAgentWorkspaceStore;
    const claimed = yield* store.claimNextDue({
      runId: VmAgentTaskRunId.make(`workspace-run-${runSuffix}`),
      now,
    });
    assert.isTrue(Option.isSome(claimed), `expected an occurrence to claim at ${now}`);
    const value = Option.getOrThrow(claimed);
    assert.strictEqual(value.task.taskId, taskId);
    return value.run;
  });

/** Claims the occurrence and fails it the way a never-dispatched run does. */
const missOccurrence = (runSuffix: string, at: string) =>
  Effect.gen(function* () {
    const store = yield* VmAgentWorkspaceStore;
    const run = yield* claim(runSuffix, at);
    yield* store.completeRun({
      runId: run.runId,
      status: "failed",
      // No turn id: no turn ever started, so the work never happened.
      turnId: null,
      resultSummary: null,
      error: "The scheduled turn never started.",
      completedAt: at,
    });
    return run;
  });

it.layer(stores())("VmAgentWorkspaceStore: a one-time occurrence that never ran", (it) => {
  it.effect("goes back on the clock instead of being stranded", () =>
    Effect.gen(function* () {
      const store = yield* VmAgentWorkspaceStore;
      yield* givenTask(
        { kind: "once", runAt: "2026-08-21T20:05:00.000Z" },
        "2026-08-21T20:05:00.000Z",
      );

      // Claiming clears next_run_at, and a null next_run_at is unclaimable.
      yield* missOccurrence("first", "2026-08-21T20:05:00.000Z");

      const settled = yield* readTask;
      assert.strictEqual(settled.status, "active");
      assert.strictEqual(settled.nextRunAt, "2026-08-21T20:10:00.000Z");
      // The point of re-arming: the due query can see it again.
      const retry = yield* store.claimNextDue({
        runId: VmAgentTaskRunId.make("workspace-run-retry"),
        now: "2026-08-21T20:11:00.000Z",
      });
      assert.isTrue(Option.isSome(retry));
    }),
  );
});

it.layer(stores())("VmAgentWorkspaceStore: a one-time occurrence that keeps missing", (it) => {
  it.effect("retires once the attempts are spent, rather than retrying forever", () =>
    Effect.gen(function* () {
      yield* givenTask(
        { kind: "once", runAt: "2026-08-21T20:05:00.000Z" },
        "2026-08-21T20:05:00.000Z",
      );

      for (let attempt = 1; attempt <= MISSED_OCCURRENCE_ATTEMPTS; attempt += 1) {
        const settled = yield* readTask;
        assert.strictEqual(
          settled.status,
          "active",
          `attempt ${attempt} should still be scheduled`,
        );
        yield* missOccurrence(`attempt-${attempt}`, `2026-08-21T2${attempt}:05:00.000Z`);
      }

      const retired = yield* readTask;
      assert.strictEqual(retired.status, "completed");
      assert.strictEqual(retired.nextRunAt, null);
    }),
  );
});

it.layer(stores())("VmAgentWorkspaceStore: a one-time occurrence whose turn ran", (it) => {
  it.effect("is not repeated when that turn failed", () =>
    Effect.gen(function* () {
      const store = yield* VmAgentWorkspaceStore;
      yield* givenTask(
        { kind: "once", runAt: "2026-08-21T20:05:00.000Z" },
        "2026-08-21T20:05:00.000Z",
      );
      const run = yield* claim("ran", "2026-08-21T20:05:00.000Z");

      yield* store.completeRun({
        runId: run.runId,
        status: "failed",
        // A turn id means the agent did the work and it went wrong. Repeating
        // it would repeat whatever it already did out in the world.
        turnId: "workspace-turn",
        resultSummary: null,
        error: "The agent turn ended as error.",
        completedAt: "2026-08-21T20:06:00.000Z",
      });

      const settled = yield* readTask;
      assert.strictEqual(settled.status, "completed");
      assert.strictEqual(settled.nextRunAt, null);
    }),
  );
});

it.layer(stores())("VmAgentWorkspaceStore: a one-time occurrence the user interrupted", (it) => {
  it.effect("is not repeated behind their back", () =>
    Effect.gen(function* () {
      const store = yield* VmAgentWorkspaceStore;
      yield* givenTask(
        { kind: "once", runAt: "2026-08-21T20:05:00.000Z" },
        "2026-08-21T20:05:00.000Z",
      );
      const run = yield* claim("cancelled", "2026-08-21T20:05:00.000Z");

      yield* store.completeRun({
        runId: run.runId,
        status: "cancelled",
        turnId: null,
        resultSummary: null,
        error: "Interrupted.",
        completedAt: "2026-08-21T20:06:00.000Z",
      });

      const settled = yield* readTask;
      assert.strictEqual(settled.status, "completed");
      assert.strictEqual(settled.nextRunAt, null);
    }),
  );
});

it.layer(stores())("VmAgentWorkspaceStore: a stopped agent", (it) => {
  it.effect("keeps due work on the clock but never claims it until the agent runs again", () =>
    Effect.gen(function* () {
      const agents = yield* VmAgentStore;
      const store = yield* VmAgentWorkspaceStore;
      yield* givenTask({ kind: "interval", everyMinutes: 30 }, "2026-08-21T20:05:00.000Z");
      yield* agents.updateStatus({ vmAgentId, status: "stopped", updatedAt: createdAt });

      const whileStopped = yield* store.claimNextDue({
        runId: VmAgentTaskRunId.make("workspace-run-stopped"),
        now: "2026-08-21T20:10:00.000Z",
      });
      assert.isTrue(Option.isNone(whileStopped));
      // Not consumed: the occurrence is still armed for the same instant.
      assert.strictEqual((yield* readTask).nextRunAt, "2026-08-21T20:05:00.000Z");

      yield* agents.updateStatus({ vmAgentId, status: "running", updatedAt: createdAt });
      const run = yield* claim("started", "2026-08-21T20:10:00.000Z");
      assert.strictEqual(run.scheduledFor, "2026-08-21T20:05:00.000Z");
    }),
  );
});

it.layer(stores())("VmAgentWorkspaceStore: a recurring task", (it) => {
  it.effect("keeps the next occurrence the claim booked when one run fails", () =>
    Effect.gen(function* () {
      yield* givenTask({ kind: "interval", everyMinutes: 60 }, "2026-08-21T20:05:00.000Z");

      yield* missOccurrence("interval", "2026-08-21T20:05:00.000Z");

      const settled = yield* readTask;
      assert.strictEqual(settled.status, "active");
      assert.strictEqual(settled.nextRunAt, "2026-08-21T21:05:00.000Z");
    }),
  );
});

it.layer(stores())("VmAgentWorkspaceStore: an unscheduled task", (it) => {
  it.effect("stays runnable by hand after a failure", () =>
    Effect.gen(function* () {
      const store = yield* VmAgentWorkspaceStore;
      yield* givenTask(null, "2026-08-21T20:05:00.000Z");

      yield* missOccurrence("manual", "2026-08-21T20:05:00.000Z");

      const settled = yield* readTask;
      // A null next_run_at is this task's resting state, not a stranding, so a
      // failure must not retire it.
      assert.strictEqual(settled.status, "active");
      assert.strictEqual(settled.nextRunAt, null);
      const rerun = yield* store.runTaskNow({
        vmAgentId,
        taskId,
        now: "2026-08-21T21:00:00.000Z",
      });
      assert.strictEqual(rerun.nextRunAt, "2026-08-21T21:00:00.000Z");
    }),
  );
});

/** Runs the task once at `at`, ending in `status`, and re-arms it for the next loop. */
const runOnceAt = (runSuffix: string, at: string, status: "completed" | "failed") =>
  Effect.gen(function* () {
    const store = yield* VmAgentWorkspaceStore;
    const run = yield* claim(runSuffix, at);
    yield* store.completeRun({
      runId: run.runId,
      status,
      turnId: `workspace-turn-${runSuffix}`,
      resultSummary: status === "completed" ? "Done" : null,
      error: status === "completed" ? null : "It failed.",
      completedAt: at,
    });
  });

it.layer(stores())("VmAgentWorkspaceStore: a stalled dispatch retry", (it) => {
  it.effect("moves the stall clock, and a finished run stays finished", () =>
    Effect.gen(function* () {
      const store = yield* VmAgentWorkspaceStore;
      yield* givenTask({ kind: "interval", everyMinutes: 60 }, createdAt);
      const run = yield* claim("stall", createdAt);
      const messageId = MessageId.make(`vm-task:${run.runId}`);
      yield* store.setRunBooting(run.runId, createdAt);
      yield* store.setRunRunning({ runId: run.runId, messageId, startedAt: createdAt });

      // The stall detector retries a run whose turn never started. Each retry
      // must move started_at, or the very next drain tick still sees the
      // original stale clock and the whole retry budget burns in seconds.
      const retryAt = "2026-08-21T20:02:11.000Z";
      yield* store.setRunRunning({ runId: run.runId, messageId, startedAt: retryAt });
      const retried = (yield* store.snapshot(vmAgentId)).runs.find(
        (entry) => entry.runId === run.runId,
      );
      assert.strictEqual(retried?.status, "running");
      assert.strictEqual(retried?.startedAt, retryAt);

      // Terminal states stay excluded: a late retry of a disposed run must
      // not resurrect it.
      yield* store.completeRun({
        runId: run.runId,
        status: "failed",
        turnId: null,
        resultSummary: null,
        error: "The scheduled turn never started.",
        completedAt: retryAt,
      });
      yield* store.setRunRunning({
        runId: run.runId,
        messageId,
        startedAt: "2026-08-21T20:05:00.000Z",
      });
      const afterDisposal = (yield* store.snapshot(vmAgentId)).runs.find(
        (entry) => entry.runId === run.runId,
      );
      assert.strictEqual(afterDisposal?.status, "failed");
      assert.strictEqual(afterDisposal?.startedAt, retryAt);
    }),
  );
});

it.layer(stores())("VmAgentWorkspaceStore: run history retention", (it) => {
  it.effect("drops finished runs that are both past the cutoff and long superseded", () =>
    Effect.gen(function* () {
      const store = yield* VmAgentWorkspaceStore;
      yield* givenTask({ kind: "interval", everyMinutes: 60 }, "2026-06-01T20:00:00.000Z");

      // A daily failure for longer than both the retention window and the
      // keep-recent window, so every rule gets a chance to bite.
      const older = RUN_HISTORY_KEEP_RECENT + 5;
      for (let index = 0; index < older; index += 1) {
        const day = String(index + 1).padStart(2, "0");
        const at = `2026-06-${day}T20:00:00.000Z`;
        yield* runOnceAt(`old-${index}`, at, "failed");
        yield* store.runTaskNow({ vmAgentId, taskId, now: at });
      }

      // Unbounded growth is the thing being fixed: the history settles at the
      // keep-recent window instead of climbing with every failure.
      const settled = yield* store.snapshot(vmAgentId);
      assert.strictEqual(settled.runs.length, RUN_HISTORY_KEEP_RECENT);
      assert.strictEqual(settled.runs[0]?.runId, `workspace-run-old-${older - 1}`);
      assert.isUndefined(settled.runs.find((run) => run.runId === "workspace-run-old-0"));

      // A run two months later, by which point every survivor is past the
      // cutoff — but the newest ones stay, because age alone never empties it.
      yield* runOnceAt("recent", "2026-08-21T20:00:00.000Z", "completed");

      const after = yield* store.snapshot(vmAgentId);
      assert.strictEqual(after.runs.length, RUN_HISTORY_KEEP_RECENT);
      assert.strictEqual(after.runs[0]?.runId, "workspace-run-recent");
    }),
  );
});

it.layer(stores())("VmAgentWorkspaceStore: a rarely-used agent", (it) => {
  it.effect("keeps its whole history however old it is", () =>
    Effect.gen(function* () {
      const store = yield* VmAgentWorkspaceStore;
      yield* givenTask({ kind: "interval", everyMinutes: 60 }, "2023-01-01T00:00:00.000Z");

      // Years apart, so every run is far past the cutoff. Age alone must not
      // be enough to delete them, or this agent would show an empty history.
      for (const [index, at] of [
        "2023-01-01T00:00:00.000Z",
        "2024-01-01T00:00:00.000Z",
        "2025-01-01T00:00:00.000Z",
      ].entries()) {
        yield* runOnceAt(`rare-${index}`, at, "failed");
        yield* store.runTaskNow({ vmAgentId, taskId, now: at });
      }

      assert.strictEqual((yield* store.snapshot(vmAgentId)).runs.length, 3);
    }),
  );
});

it.layer(stores())("VmAgentWorkspaceStore: notification retention", (it) => {
  it.effect("prunes the alerts those runs raised on the same rule", () =>
    Effect.gen(function* () {
      const store = yield* VmAgentWorkspaceStore;
      yield* givenTask({ kind: "interval", everyMinutes: 60 }, "2026-08-21T20:00:00.000Z");

      const raised = NOTIFICATION_KEEP_RECENT + 10;
      for (let index = 0; index < raised; index += 1) {
        yield* store.createNotification({
          notificationId: VmAgentNotificationId.make(`workspace-alert-${index}`),
          vmAgentId,
          taskId: null,
          runId: null,
          kind: "task-failed",
          title: "Check the dashboard needs attention",
          body: "The scheduled task did not run.",
          deepLink: `/agents/${vmAgentId}`,
          dedupeKey: `workspace-alert-${index}`,
          createdAt: `2026-01-01T00:${String(index).padStart(2, "0")}:00.000Z`,
        });
      }

      yield* runOnceAt("prune", "2026-08-21T20:00:00.000Z", "completed");

      const after = yield* store.snapshot(vmAgentId);
      assert.strictEqual(after.notifications.length, NOTIFICATION_KEEP_RECENT);
    }),
  );
});

it.layer(stores())("VmAgentWorkspaceStore: retention policy", (it) => {
  it.effect("keeps failures visible for the documented window", () =>
    Effect.sync(() => {
      // How long a failure stays on screen is a promise to the user; changing
      // it silently is a behaviour change, not a refactor.
      assert.strictEqual(RUN_HISTORY_RETENTION_DAYS, 14);
      assert.strictEqual(MISSED_OCCURRENCE_ATTEMPTS, 3);
    }),
  );
});

it.layer(stores())("VmAgentWorkspaceStore: completed task retention", (it) => {
  it.effect("deletes only expired completed workspace tasks", () =>
    Effect.gen(function* () {
      const agents = yield* VmAgentStore;
      const store = yield* VmAgentWorkspaceStore;
      yield* agents.insert(agent);

      const createTask = (id: string, status: VmAgentTask["status"], at: string) =>
        store.createTask({
          taskId: VmAgentTaskId.make(id),
          vmAgentId,
          title: id,
          prompt: "Retain or purge this task.",
          completionCriteria: [],
          status,
          schedule: null,
          nextRunAt: null,
          createdBy: "user",
          approvalState: "approved",
          notificationPolicy: "never",
          artifactId: null,
          createdAt: at,
        });

      const expiredTaskId = VmAgentTaskId.make("completed-expired");
      const boundaryTaskId = VmAgentTaskId.make("completed-at-boundary");
      const activeTaskId = VmAgentTaskId.make("active-old");
      yield* createTask(expiredTaskId, "completed", "2026-08-21T10:00:00.000Z");
      yield* createTask(boundaryTaskId, "completed", "2026-08-21T11:00:00.000Z");
      yield* createTask(activeTaskId, "active", "2026-08-21T10:00:00.000Z");

      const affectedAgentIds = yield* store.purgeCompletedTasks({
        cutoff: "2026-08-21T11:00:00.000Z",
      });

      assert.deepStrictEqual(affectedAgentIds, [vmAgentId]);
      assert.isTrue(Option.isNone(yield* store.getTask(vmAgentId, expiredTaskId)));
      assert.isTrue(Option.isSome(yield* store.getTask(vmAgentId, boundaryTaskId)));
      assert.isTrue(Option.isSome(yield* store.getTask(vmAgentId, activeTaskId)));
    }),
  );
});

it.layer(stores())("VmAgentWorkspaceStore: blockers", (it) => {
  it.effect("raises once per obstacle, refreshes on re-report, resolves once", () =>
    Effect.gen(function* () {
      const store = yield* VmAgentWorkspaceStore;
      yield* givenTask(null, createdAt);

      const first = yield* store.raiseBlocker({
        blockerId: VmAgentBlockerId.make("blocker-1"),
        vmAgentId,
        title: "Google sign-in needs you",
        detail: "Studio shows a reCAPTCHA only a human can pass.",
        url: "https://studio.youtube.com/",
        now: "2026-08-23T06:00:00.000Z",
      });
      assert.strictEqual(first.blockerId, "blocker-1");
      assert.isNull(first.resolvedAt);

      // The agent re-reports the same obstacle on its next run: same card,
      // fresher words — never a second card for the user to wade through.
      const refreshed = yield* store.raiseBlocker({
        blockerId: VmAgentBlockerId.make("blocker-2"),
        vmAgentId,
        title: "Google sign-in needs you",
        detail: "Still blocked at the reCAPTCHA.",
        url: null,
        now: "2026-08-23T07:00:00.000Z",
      });
      assert.strictEqual(refreshed.blockerId, "blocker-1");
      assert.strictEqual(refreshed.detail, "Still blocked at the reCAPTCHA.");

      const snapshot = yield* store.snapshot(vmAgentId);
      assert.strictEqual(snapshot.blockers.length, 1);

      const resolved = yield* store.resolveBlocker({
        vmAgentId,
        blockerId: first.blockerId,
        resolvedBy: "user",
        now: "2026-08-23T08:00:00.000Z",
      });
      assert.isTrue(Option.isSome(resolved));
      assert.strictEqual(Option.getOrThrow(resolved).resolvedBy, "user");

      // Resolving again is a no-op, not an error — both sides may race.
      const again = yield* store.resolveBlocker({
        vmAgentId,
        blockerId: first.blockerId,
        resolvedBy: "agent",
        now: "2026-08-23T09:00:00.000Z",
      });
      assert.isTrue(Option.isNone(again));

      // A new report after resolution is a new obstacle, not a refresh of
      // the resolved one.
      const reopened = yield* store.raiseBlocker({
        blockerId: VmAgentBlockerId.make("blocker-3"),
        vmAgentId,
        title: "Google sign-in needs you",
        detail: "Signed out again after the password change.",
        url: null,
        now: "2026-08-23T10:00:00.000Z",
      });
      assert.strictEqual(reopened.blockerId, "blocker-3");
      assert.isNull(reopened.resolvedAt);
    }),
  );
});
