import * as NodeAssert from "node:assert/strict";
import { describe, it } from "vite-plus/test";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import {
  PROVIDER_TASK_FINISHED_MAX_COUNT,
  PROVIDER_TASK_PAGE_SIZE,
  canStopProviderTask,
  countActiveProviderTasks,
  deriveProviderTasks,
  providerTaskChipLabel,
  providerTaskStatusLabel,
  providerTaskTypeLabel,
  pageProviderTasks,
  resolveProviderTaskPanelPlacement,
  shouldShowProviderTaskPanel,
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
    NodeAssert.equal(shouldShowProviderTaskPanel(tasks), false);
  });

  it("stacks below the active right-panel surface on desktop", () => {
    NodeAssert.equal(
      resolveProviderTaskPanelPlacement({
        hasTasks: true,
        rightPanelOpen: true,
      }),
      "stacked",
    );
  });

  it("uses the same vertical stack inside the full-screen mobile sheet", () => {
    NodeAssert.equal(
      resolveProviderTaskPanelPlacement({
        hasTasks: true,
        rightPanelOpen: true,
      }),
      "stacked",
    );
  });

  it("never renders while the right panel is collapsed", () => {
    // Bound to the right panel so it can never overlay the conversation —
    // collapsing that panel is the user's existing "give me my screen back".
    NodeAssert.equal(
      resolveProviderTaskPanelPlacement({
        hasTasks: true,
        rightPanelOpen: false,
      }),
      "hidden",
    );
  });

  it("hides the panel only when there is nothing to show", () => {
    NodeAssert.equal(
      resolveProviderTaskPanelPlacement({
        hasTasks: false,
        rightPanelOpen: true,
      }),
      "hidden",
    );
  });

  it("counts running and stalled work separately in the chip label", () => {
    const nowMs = Date.parse("2026-08-01T14:31:00Z");
    const live = deriveProviderTasks(
      [
        activity("task.progress", "2026-08-01T14:30:00Z", { taskId: "a", title: "A" }),
        activity("task.progress", "2026-08-01T14:30:00Z", { taskId: "b", title: "B" }),
      ],
      { nowMs },
    );
    NodeAssert.equal(providerTaskChipLabel(live), "2 running tasks");

    const mixed = deriveProviderTasks(
      [
        activity("task.progress", "2026-08-01T14:30:00Z", { taskId: "a", title: "A" }),
        activity("task.started", "2026-08-01T11:00:00Z", { taskId: "ghost", detail: "Ghost" }),
      ],
      { nowMs },
    );
    NodeAssert.equal(providerTaskChipLabel(mixed), "1 running · 1 stalled");

    const stalledOnly = deriveProviderTasks(
      [activity("task.started", "2026-08-01T11:00:00Z", { taskId: "ghost", detail: "Ghost" })],
      { nowMs },
    );
    NodeAssert.equal(providerTaskChipLabel(stalledOnly), "1 stalled task");
  });

  it("shows no chip when nothing is outstanding", () => {
    const nowMs = Date.parse("2026-08-01T14:31:00Z");
    const finished = deriveProviderTasks(
      [
        activity("task.started", "2026-08-01T14:29:00Z", { taskId: "a", detail: "A" }),
        activity("task.completed", "2026-08-01T14:30:00Z", { taskId: "a", status: "completed" }),
      ],
      { nowMs },
    );
    NodeAssert.equal(providerTaskChipLabel(finished), null);
    NodeAssert.equal(providerTaskChipLabel([]), null);
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

  it("pages the list and clamps an out-of-range page", () => {
    const many = Array.from({ length: 23 }, (_, index) =>
      activity("task.progress", "2026-08-01T14:00:00Z", {
        taskId: `t${index}`,
        title: `Task ${index}`,
      }),
    );
    const tasks = deriveProviderTasks(many, { nowMs: Date.parse("2026-08-01T14:00:30Z") });

    const first = pageProviderTasks(tasks, 0);
    NodeAssert.equal(first.items.length, PROVIDER_TASK_PAGE_SIZE);
    NodeAssert.equal(first.pageCount, 3);
    NodeAssert.equal(first.total, 23);

    NodeAssert.equal(pageProviderTasks(tasks, 2).items.length, 3);
    // The list shrinks as tasks age out, so a held page index must not render empty.
    NodeAssert.equal(pageProviderTasks(tasks, 99).page, 2);
    NodeAssert.equal(pageProviderTasks(tasks, -5).page, 0);
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

  it("allows stopping a running task on a runtime with a per-task kill", () => {
    NodeAssert.equal(canStopProviderTask({ task: task(), driverKind: "claudeAgent" }), true);
  });

  it("refuses when the driver has no per-task stop channel", () => {
    NodeAssert.equal(canStopProviderTask({ task: task(), driverKind: "codex" }), false);
    NodeAssert.equal(canStopProviderTask({ task: task(), driverKind: null }), false);
  });

  it("refuses on anything not confidently running", () => {
    for (const status of ["stale", "completed", "failed", "stopped"] as const) {
      NodeAssert.equal(
        canStopProviderTask({ task: task({ status }), driverKind: "claudeAgent" }),
        false,
        status,
      );
    }
  });

  it("refuses on server-side plan refreshes, which have no provider task behind them", () => {
    NodeAssert.equal(
      canStopProviderTask({ task: task({ taskType: "plan-refresh" }), driverKind: "claudeAgent" }),
      false,
    );
  });
});
