import * as NodeAssert from "node:assert/strict";
import { describe, it } from "vite-plus/test";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import {
  PROVIDER_TASK_PAGE_SIZE,
  countActiveProviderTasks,
  deriveProviderTasks,
  providerTaskChipLabel,
  providerTaskStatusLabel,
  providerTaskTypeLabel,
  pageProviderTasks,
  resolveProviderTaskPanelPlacement,
  shouldShowProviderTaskPanel,
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
    const tasks = deriveProviderTasks([
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
    ]);

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

  it("preserves a failed status rather than overwriting it", () => {
    const tasks = deriveProviderTasks([
      activity("task.started", "2026-08-01T10:00:00Z", { taskId: "a1", detail: "Work" }),
      activity("task.completed", "2026-08-01T10:00:01Z", { taskId: "a1", status: "failed" }),
    ]);
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

  it("shares the inline right panel column on desktop", () => {
    NodeAssert.equal(
      resolveProviderTaskPanelPlacement({
        hasTasks: true,
        rightPanelOpen: true,
        useSheetLayout: false,
      }),
      "split",
    );
  });

  it("takes the whole screen on mobile rather than covering part of it", () => {
    NodeAssert.equal(
      resolveProviderTaskPanelPlacement({
        hasTasks: true,
        rightPanelOpen: true,
        useSheetLayout: true,
      }),
      "fullscreen",
    );
  });

  it("never renders while the right panel is collapsed", () => {
    // Bound to the right panel so it can never overlay the conversation —
    // collapsing that panel is the user's existing "give me my screen back".
    for (const useSheetLayout of [false, true]) {
      NodeAssert.equal(
        resolveProviderTaskPanelPlacement({
          hasTasks: true,
          rightPanelOpen: false,
          useSheetLayout,
        }),
        "hidden",
      );
    }
  });

  it("hides the panel only when there is nothing to show", () => {
    NodeAssert.equal(
      resolveProviderTaskPanelPlacement({
        hasTasks: false,
        rightPanelOpen: true,
        useSheetLayout: false,
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

  it("drops finished tasks older than a day but keeps recent ones", () => {
    const nowMs = Date.parse("2026-08-02T12:00:00Z");
    const tasks = deriveProviderTasks(
      [
        activity("task.started", "2026-07-30T09:00:00Z", { taskId: "ancient", detail: "Old" }),
        activity("task.completed", "2026-07-30T09:01:00Z", {
          taskId: "ancient",
          status: "completed",
        }),
        activity("task.started", "2026-08-02T11:00:00Z", { taskId: "recent", detail: "New" }),
        activity("task.completed", "2026-08-02T11:01:00Z", {
          taskId: "recent",
          status: "completed",
        }),
      ],
      { nowMs },
    );
    NodeAssert.deepEqual(
      tasks.map((task) => task.taskId),
      ["recent"],
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
