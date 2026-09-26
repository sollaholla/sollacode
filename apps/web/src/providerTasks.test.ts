import * as NodeAssert from "node:assert/strict";
import { describe, it } from "vite-plus/test";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import {
  PROVIDER_TASK_FINISHED_MAX_COUNT,
  applyProviderTaskDismissals,
  canStopProviderTask,
  countActiveProviderTasks,
  UNANSWERED_CONFIRM_MS,
  confirmDestructiveSend,
  describeSendOverRunningTasks,
  deriveProviderTasks,
  providerTaskStatusLabel,
  providerTaskTypeLabel,
  type ProviderTask,
} from "./providerTasks.ts";

function activity(
  kind: string,
  createdAt: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity {
  return { kind, createdAt, payload } as unknown as OrchestrationThreadActivity;
}

describe("deriveProviderTasks", () => {
  it("loads the final metadata replacement from a fresh persisted activity snapshot", () => {
    // The SQL projection replaces progress and completion under one lifecycle ID.
    // Only the started row and final metadata completion survive a fresh reload.
    const rows = [
      activity("task.started", "2026-01-01T00:00:00.000Z", {
        taskId: "codex-subagent:child",
        detail: "Codex subagent child",
        taskType: "local_agent",
      }),
      activity("task.completed", "2026-01-01T00:00:01.000Z", {
        taskId: "codex-subagent:child",
        title: "Codex subagent /root/installed_task_probe",
        status: "completed",
        metadataOnly: true,
        usage: { total_tokens: 1234 },
      }),
    ];
    const tasks = deriveProviderTasks(rows, { nowMs: Date.parse("2026-01-01T00:00:02.000Z") });
    NodeAssert.equal(tasks.length, 1);
    NodeAssert.equal(tasks[0]?.title, "Codex subagent /root/installed_task_probe");
    NodeAssert.equal(tasks[0]?.status, "completed");
    NodeAssert.equal(tasks[0]?.totalTokens, 1234);
  });

  it("keeps provider token totals as snapshots and revives only an explicitly restarted task", () => {
    const rows = [
      activity("task.started", "2026-08-01T10:00:00Z", {
        taskId: "codex-subagent:child",
        detail: "Codex subagent image preview",
        taskType: "local_agent",
      }),
      activity("task.progress", "2026-08-01T10:00:05Z", {
        taskId: "codex-subagent:child",
        title: "Codex subagent image preview",
        usage: { total_tokens: 1234 },
      }),
      activity("task.progress", "2026-08-01T10:00:06Z", {
        taskId: "codex-subagent:child",
        title: "Codex subagent image preview",
        usage: { total_tokens: 1234 },
      }),
      activity("task.completed", "2026-08-01T10:00:07Z", {
        taskId: "codex-subagent:child",
        status: "completed",
      }),
    ];
    NodeAssert.equal(
      deriveProviderTasks(rows, { nowMs: Date.parse("2026-08-01T10:01:00Z") })[0]?.totalTokens,
      1234,
    );
    NodeAssert.equal(
      deriveProviderTasks(rows, { nowMs: Date.parse("2026-08-01T10:01:00Z") })[0]?.status,
      "completed",
    );
    rows.push(
      activity("task.started", "2026-08-01T10:00:08Z", {
        taskId: "codex-subagent:child",
        detail: "Codex subagent image preview",
      }),
    );
    NodeAssert.equal(
      deriveProviderTasks(rows, { nowMs: Date.parse("2026-08-01T10:01:00Z") })[0]?.status,
      "running",
    );
    NodeAssert.equal(
      deriveProviderTasks([rows[0]!], { nowMs: Date.parse("2026-08-01T10:01:00Z") })[0]
        ?.totalTokens,
      null,
    );
  });

  it("folds start, progress and completion into one row", () => {
    const tasks = deriveProviderTasks(
      [
        activity("task.started", "2026-08-01T10:00:00Z", {
          taskId: "a1",
          taskType: "local_agent",
          detail: "Explore interaction modes",
        }),
        activity("task.progress", "2026-08-01T10:00:05Z", {
          taskId: "a1",
          title: "Running grep",
          lastToolName: "Bash",
          usage: { tool_uses: 4 },
        }),
        activity("task.completed", "2026-08-01T10:00:09Z", {
          taskId: "a1",
          status: "completed",
          summary: "Found 3 files",
        }),
      ],
      // Pinned clock: with real retention, a completed row would age out of a
      // test that happened to run at the wrong time of day.
      { nowMs: Date.parse("2026-08-01T10:00:10Z") },
    );

    NodeAssert.equal(tasks.length, 1);
    NodeAssert.deepEqual(
      {
        taskId: tasks[0]?.taskId,
        taskType: tasks[0]?.taskType,
        title: tasks[0]?.title,
        summary: tasks[0]?.summary,
        status: tasks[0]?.status,
        startedAt: tasks[0]?.startedAt,
        toolUses: tasks[0]?.toolUses,
      },
      {
        taskId: "a1",
        taskType: "local_agent",
        title: "Running grep",
        summary: "Found 3 files",
        status: "completed",
        startedAt: "2026-08-01T10:00:00Z",
        toolUses: 4,
      },
    );
  });

  it("keeps a task running until it completes", () => {
    const tasks = deriveProviderTasks(
      [
        activity("task.started", "2026-08-01T10:00:00Z", { taskId: "a1", detail: "Work" }),
        activity("task.progress", "2026-08-01T10:00:05Z", { taskId: "a1", title: "Still going" }),
      ],
      { nowMs: Date.parse("2026-08-01T10:00:10Z") },
    );
    NodeAssert.equal(tasks[0]?.status, "running");
    NodeAssert.equal(countActiveProviderTasks(tasks), 1);
  });

  // Observed 2026-08-05: the "3D Modeling Trial" thread showed a running
  // background task while its session was stopped and nothing was executing.
  // The fold only ever leaves "running" on a `task.completed` event, so a
  // runtime that dies mid-task strands the row as live forever.
  it("reports tasks as stopped once the provider session is torn down", () => {
    const activities = [
      activity("task.started", "2026-08-01T10:00:00Z", { taskId: "a1", detail: "Work" }),
      activity("task.progress", "2026-08-01T10:00:05Z", { taskId: "a1", title: "Still going" }),
    ];
    const nowMs = Date.parse("2026-08-01T10:00:10Z");

    // Same input, live session: still running.
    NodeAssert.equal(deriveProviderTasks(activities, { nowMs })[0]?.status, "running");

    const settled = deriveProviderTasks(activities, { nowMs, providerSessionEnded: true });
    NodeAssert.equal(settled[0]?.status, "stopped");
    NodeAssert.equal(countActiveProviderTasks(settled), 0);
  });

  it("does not rewrite a task that already reported how it finished", () => {
    const settled = deriveProviderTasks(
      [
        activity("task.started", "2026-08-01T10:00:00Z", { taskId: "a1", detail: "Work" }),
        activity("task.completed", "2026-08-01T10:00:01Z", { taskId: "a1", status: "failed" }),
      ],
      { nowMs: Date.parse("2026-08-01T10:00:02Z"), providerSessionEnded: true },
    );
    NodeAssert.equal(settled[0]?.status, "failed");
  });

  it("retains a newly stopped long-running command from the session end time", () => {
    const activities = [
      activity("task.started", "2026-08-01T10:00:00Z", {
        taskId: "capture",
        taskType: "local_bash",
        detail: "Capture the ground camera",
      }),
    ];
    const options = { providerSessionEnded: true, providerSessionEndedAt: "2026-08-01T11:00:00Z" };
    const tasks = deriveProviderTasks(activities, {
      ...options,
      nowMs: Date.parse("2026-08-01T11:01:00Z"),
    });
    NodeAssert.equal(tasks.length, 1);
    NodeAssert.equal(tasks[0]?.status, "stopped");
    NodeAssert.equal(tasks[0]?.updatedAt, options.providerSessionEndedAt);
    NodeAssert.equal(
      deriveProviderTasks(activities, { ...options, nowMs: Date.parse("2026-08-01T11:11:00Z") })
        .length,
      0,
    );
  });

  it("preserves a failed status rather than overwriting it", () => {
    const tasks = deriveProviderTasks(
      [
        activity("task.started", "2026-08-01T10:00:00Z", { taskId: "a1", detail: "Work" }),
        activity("task.completed", "2026-08-01T10:00:01Z", { taskId: "a1", status: "failed" }),
      ],
      { nowMs: Date.parse("2026-08-01T10:00:02Z") },
    );
    NodeAssert.equal(tasks[0]?.status, "failed");
    NodeAssert.equal(countActiveProviderTasks(tasks), 0);
  });

  it("shows progress for a task whose start was never seen", () => {
    // The events are independent; dropping these would hide long-running work.
    const tasks = deriveProviderTasks(
      [activity("task.progress", "2026-08-01T10:00:05Z", { taskId: "orphan", title: "Running" })],
      { nowMs: Date.parse("2026-08-01T10:00:10Z") },
    );
    NodeAssert.equal(tasks.length, 1);
    NodeAssert.equal(tasks[0]?.status, "running");
  });

  it("sorts running tasks ahead of finished ones", () => {
    const tasks = deriveProviderTasks(
      [
        activity("task.started", "2026-08-01T10:00:00Z", { taskId: "done", detail: "Done" }),
        activity("task.completed", "2026-08-01T10:00:01Z", { taskId: "done", status: "completed" }),
        activity("task.started", "2026-08-01T09:00:00Z", { taskId: "live", detail: "Live" }),
      ],
      { nowMs: Date.parse("2026-08-01T09:00:10Z") },
    );
    NodeAssert.deepEqual(
      tasks.map((task) => task.taskId),
      ["live", "done"],
    );
  });

  it("ignores unrelated activities and entries without a task id", () => {
    const tasks = deriveProviderTasks([
      activity("tool.started", "2026-08-01T10:00:00Z", { itemType: "command_execution" }),
      activity("task.started", "2026-08-01T10:00:01Z", { detail: "no id" }),
    ]);
    NodeAssert.deepEqual(tasks, []);
  });

  it("downgrades a silent running task to stale instead of claiming it is live", () => {
    // The real failure: a runtime dies mid-turn, never emits task.completed,
    // and the task claims to be running for hours afterwards.
    const nowMs = Date.parse("2026-08-01T14:31:00Z");
    const tasks = deriveProviderTasks(
      [activity("task.started", "2026-08-01T12:33:00Z", { taskId: "ghost", detail: "Render" })],
      { nowMs },
    );
    NodeAssert.equal(tasks[0]?.status, "stale");
    NodeAssert.equal(countActiveProviderTasks(tasks), 0);
    NodeAssert.equal(providerTaskStatusLabel(tasks[0]!, nowMs), "No updates for 1h");
  });

  it("drops day-old ghosts that never reported completion", () => {
    // Regression: the age cut originally applied only to finished tasks, so a
    // task whose runtime died without emitting task.completed stayed on the
    // list forever — "No updates for 3d", hundreds deep.
    const nowMs = Date.parse("2026-08-04T14:00:00Z");
    const tasks = deriveProviderTasks(
      [
        activity("task.started", "2026-08-01T10:00:00Z", { taskId: "g3", detail: "3 days" }),
        activity("task.started", "2026-08-02T10:00:00Z", { taskId: "g2", detail: "2 days" }),
        activity("task.started", "2026-08-03T10:00:00Z", { taskId: "g1", detail: "1 day" }),
        activity("task.started", "2026-08-04T13:00:00Z", { taskId: "recent", detail: "1 hour" }),
      ],
      { nowMs },
    );
    NodeAssert.deepEqual(
      tasks.map((task) => task.taskId),
      ["recent"],
    );
    NodeAssert.equal(tasks[0]?.status, "stale");
  });

  it("keeps a recently-updated running task running", () => {
    const nowMs = Date.parse("2026-08-01T14:31:00Z");
    const tasks = deriveProviderTasks(
      [activity("task.progress", "2026-08-01T14:29:00Z", { taskId: "live", title: "Working" })],
      { nowMs },
    );
    NodeAssert.equal(tasks[0]?.status, "running");
    NodeAssert.equal(countActiveProviderTasks(tasks), 1);
  });

  it("does not flag a long build that has simply not reported yet", () => {
    // Background commands emit no progress events, so a 20-minute build looks
    // identical to a dead one until the threshold. It must still read running.
    const nowMs = Date.parse("2026-08-01T14:31:00Z");
    const tasks = deriveProviderTasks(
      [activity("task.started", "2026-08-01T14:11:00Z", { taskId: "build", detail: "Building" })],
      { nowMs },
    );
    NodeAssert.equal(tasks[0]?.status, "running");
  });

  it("completed work leaves in minutes while failures hold on longer", () => {
    const nowMs = Date.parse("2026-08-02T12:00:00Z");
    const tasks = deriveProviderTasks(
      [
        activity("task.started", "2026-08-02T11:30:00Z", { taskId: "old-done", detail: "Old" }),
        activity("task.completed", "2026-08-02T11:40:00Z", {
          taskId: "old-done",
          status: "completed",
        }),
        activity("task.started", "2026-08-02T11:50:00Z", { taskId: "fresh", detail: "New" }),
        activity("task.completed", "2026-08-02T11:55:00Z", {
          taskId: "fresh",
          status: "completed",
        }),
        activity("task.started", "2026-08-02T11:00:00Z", { taskId: "broke", detail: "Boom" }),
        activity("task.completed", "2026-08-02T11:20:00Z", {
          taskId: "broke",
          status: "failed",
        }),
        activity("task.started", "2026-08-02T10:00:00Z", { taskId: "old-broke", detail: "Boom" }),
        activity("task.completed", "2026-08-02T10:45:00Z", {
          taskId: "old-broke",
          status: "failed",
        }),
      ],
      { nowMs },
    );
    // Twenty minutes past completion is history; five is not. A forty-minute
    // failure survives where a completion would not, and seventy-five minutes
    // is too old even for a failure.
    NodeAssert.deepEqual(
      tasks.map((task) => task.taskId),
      ["fresh", "broke"],
    );
  });

  it("caps finished rows so a burst cannot flood the pager", () => {
    const nowMs = Date.parse("2026-08-01T12:06:00Z");
    const burst = Array.from({ length: 25 }, (_, index) =>
      activity("task.completed", `2026-08-01T12:05:${String(index).padStart(2, "0")}Z`, {
        taskId: `t${index}`,
        status: "completed",
      }),
    );
    const tasks = deriveProviderTasks(
      [
        activity("task.progress", "2026-08-01T12:05:59Z", { taskId: "live", title: "Live" }),
        ...burst,
      ],
      { nowMs },
    );
    NodeAssert.equal(tasks.length, 1 + PROVIDER_TASK_FINISHED_MAX_COUNT);
    // Live work is never capped, and the newest finished rows are the ones kept.
    NodeAssert.equal(tasks[0]?.taskId, "live");
    NodeAssert.equal(
      tasks.some((task) => task.taskId === "t24"),
      true,
    );
    NodeAssert.equal(
      tasks.some((task) => task.taskId === "t4"),
      false,
    );
  });

  it("orders running ahead of stale ahead of finished", () => {
    const nowMs = Date.parse("2026-08-01T14:00:00Z");
    const tasks = deriveProviderTasks(
      [
        activity("task.started", "2026-08-01T13:59:00Z", { taskId: "done", detail: "Done" }),
        activity("task.completed", "2026-08-01T13:59:30Z", { taskId: "done", status: "completed" }),
        activity("task.started", "2026-08-01T10:00:00Z", { taskId: "ghost", detail: "Ghost" }),
        activity("task.progress", "2026-08-01T13:59:50Z", { taskId: "live", title: "Live" }),
      ],
      { nowMs },
    );
    NodeAssert.deepEqual(
      tasks.map((task) => task.taskId),
      ["live", "ghost", "done"],
    );
  });

  it("keeps a Monitor watching until the provider reports its terminal state", () => {
    const start = activity("task.started", "2026-08-01T10:00:00Z", {
      taskId: "watch",
      taskType: "local_monitor",
      detail: "Watch the build log",
    });
    const [watching] = deriveProviderTasks([start], { nowMs: Date.parse("2026-08-01T10:01:00Z") });
    NodeAssert.ok(watching);
    NodeAssert.equal(providerTaskTypeLabel(watching), "Monitor");
    NodeAssert.equal(providerTaskStatusLabel(watching), "Watching");
    const [finished] = deriveProviderTasks(
      [
        start,
        activity("task.completed", "2026-08-01T10:02:00Z", {
          taskId: "watch",
          status: "completed",
        }),
      ],
      { nowMs: Date.parse("2026-08-01T10:02:01Z") },
    );
    NodeAssert.ok(finished);
    NodeAssert.equal(providerTaskStatusLabel(finished), "Completed");
    NodeAssert.equal(countActiveProviderTasks([finished]), 0);
  });

  it("labels task types and statuses for display", () => {
    const [task] = deriveProviderTasks(
      [
        activity("task.started", "2026-08-01T10:00:00Z", {
          taskId: "a1",
          taskType: "local_bash",
          detail: "Build",
        }),
        activity("task.progress", "2026-08-01T10:00:01Z", {
          taskId: "a1",
          title: "Build",
          lastToolName: "Bash",
        }),
      ],
      { nowMs: Date.parse("2026-08-01T10:00:10Z") },
    );
    NodeAssert.ok(task);
    NodeAssert.equal(providerTaskTypeLabel(task), "Background command");
    NodeAssert.equal(providerTaskStatusLabel(task), "Running · Bash");
  });
});

describe("provider task dismissals", () => {
  it("keeps a model-switch dismissal hidden until newer runtime activity proves the task is alive", () => {
    const running: ProviderTask = {
      taskId: "ghost",
      taskType: "local_agent",
      title: "Old model task",
      summary: null,
      lastToolName: null,
      status: "running",
      startedAt: "2026-09-01T12:00:00Z",
      updatedAt: "2026-09-01T12:00:05Z",
      toolUses: null,
    };
    const dismissals = { ghost: "2026-09-01T12:00:10Z" };
    NodeAssert.deepEqual(applyProviderTaskDismissals([running], dismissals), []);
    NodeAssert.deepEqual(
      applyProviderTaskDismissals([{ ...running, updatedAt: "2026-09-01T12:00:11Z" }], dismissals),
      [{ ...running, updatedAt: "2026-09-01T12:00:11Z" }],
    );
  });
});

describe("canStopProviderTask", () => {
  function task(overrides: Partial<ProviderTask> = {}): ProviderTask {
    return {
      taskId: "a1",
      taskType: "local_bash",
      title: "Poll the box",
      summary: null,
      lastToolName: null,
      status: "running",
      startedAt: "2026-08-01T10:00:00Z",
      updatedAt: "2026-08-01T10:00:00Z",
      toolUses: null,
      ...overrides,
    };
  }

  /**
   * There is no driver input any more, and that is the fix: only Claude and
   * Grok announce tasks, so a row still showing under Muse belongs to a
   * runtime the provider switch already tore down. Gating the control on the
   * current driver hid it exactly there, leaving the row claiming to run
   * forever with nothing to press. The server settles that row instead.
   */
  it("allows stopping a running task whatever the thread is running now", () => {
    NodeAssert.equal(canStopProviderTask({ task: task() }), true);
  });

  it("refuses on anything not confidently running", () => {
    for (const status of ["stale", "completed", "failed", "stopped"] as const) {
      NodeAssert.equal(canStopProviderTask({ task: task({ status }) }), false, status);
    }
  });

  it("refuses on server-side plan refreshes, which have no provider task behind them", () => {
    NodeAssert.equal(canStopProviderTask({ task: task({ taskType: "plan-refresh" }) }), false);
  });
});

describe("describeSendOverRunningTasks", () => {
  it("names the count and the consequence", () => {
    NodeAssert.equal(
      describeSendOverRunningTasks(1),
      "1 background task is still running. Sending now will cancel it. Send anyway?",
    );
    NodeAssert.equal(
      describeSendOverRunningTasks(3),
      "3 background tasks are still running. Sending now will cancel them. Send anyway?",
    );
  });
});

describe("confirmDestructiveSend", () => {
  function withConfirm<T>(stub: ((message: string) => boolean) | undefined, run: () => T): T {
    const globalScope = globalThis as {
      window?: { confirm?: unknown } | undefined;
    };
    const hadWindow = "window" in globalScope;
    const previousWindow = globalScope.window;
    globalScope.window = { ...previousWindow, confirm: stub };
    try {
      return run();
    } finally {
      if (hadWindow) globalScope.window = previousWindow;
      else delete globalScope.window;
    }
  }

  it("sends when the person accepts", () => {
    const asked: string[] = [];
    const sent = withConfirm(
      (message) => {
        asked.push(message);
        return true;
      },
      () => confirmDestructiveSend("cancel them?", stepClock([0, 900])),
    );
    NodeAssert.equal(sent, true);
    NodeAssert.deepEqual(asked, ["cancel them?"]);
  });

  it("stops when the person reads the dialog and refuses", () => {
    const sent = withConfirm(
      () => false,
      () => confirmDestructiveSend("cancel them?", stepClock([0, UNANSWERED_CONFIRM_MS + 50])),
    );
    NodeAssert.equal(sent, false);
  });

  it("sends anyway when the dialog was suppressed", () => {
    // A browser blocking further dialogs from the page returns false at once.
    // Nobody was asked, so the message must not be dropped on their behalf.
    const sent = withConfirm(
      () => false,
      () => confirmDestructiveSend("cancel them?", stepClock([0, 1])),
    );
    NodeAssert.equal(sent, true);
  });

  it("sends anyway when the webview throws instead of prompting", () => {
    const sent = withConfirm(
      () => {
        throw new Error("dialogs are disabled");
      },
      () => confirmDestructiveSend("cancel them?", stepClock([0, 1])),
    );
    NodeAssert.equal(sent, true);
  });

  it("sends anyway where there is no confirm at all", () => {
    const sent = withConfirm(undefined, () =>
      confirmDestructiveSend("cancel them?", stepClock([0, 1])),
    );
    NodeAssert.equal(sent, true);
  });
});

function stepClock(readings: ReadonlyArray<number>): () => number {
  let index = 0;
  return () => readings[Math.min(index++, readings.length - 1)] ?? 0;
}
