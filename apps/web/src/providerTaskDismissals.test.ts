import { describe, expect, it } from "vite-plus/test";

import {
  applyProviderTaskDismissals,
  dismissableProviderTaskIds,
  hasDismissableProviderTasks,
  PROVIDER_TASK_MAX_AGE_MS,
  pruneProviderTaskDismissals,
  type ProviderTask,
  type ProviderTaskStatus,
} from "./providerTasks";

function task(
  taskId: string,
  status: ProviderTaskStatus,
  updatedAt = "2026-08-02T10:00:00.000Z",
): ProviderTask {
  return {
    taskId,
    taskType: null,
    title: taskId,
    summary: null,
    lastToolName: null,
    status,
    startedAt: "2026-08-02T09:00:00.000Z",
    updatedAt,
    toolUses: null,
  };
}

describe("applyProviderTaskDismissals", () => {
  it("hides a dismissed task", () => {
    const tasks = [task("a", "running"), task("b", "completed")];
    const visible = applyProviderTaskDismissals(tasks, { a: "2026-08-02T11:00:00.000Z" });
    expect(visible.map((entry) => entry.taskId)).toEqual(["b"]);
  });

  it("keeps hiding a task that never reports again", () => {
    // The whole point: a runtime that died leaves a row claiming to run
    // forever, and dismissing it has to be permanent or it was not worth having.
    const ghost = task("ghost", "running", "2026-08-02T10:00:00.000Z");
    const visible = applyProviderTaskDismissals([ghost], { ghost: "2026-08-02T11:00:00.000Z" });
    expect(visible).toEqual([]);
  });

  it("brings a task back when it reports after being dismissed", () => {
    // Dismissing live work must not silently discard it. New evidence that the
    // task is alive overrides the user's guess that it was dead.
    const alive = task("alive", "running", "2026-08-02T12:00:00.000Z");
    const visible = applyProviderTaskDismissals([alive], { alive: "2026-08-02T11:00:00.000Z" });
    expect(visible.map((entry) => entry.taskId)).toEqual(["alive"]);
  });

  it("does not resurrect on an update older than the dismissal", () => {
    const stale = task("stale", "running", "2026-08-02T10:00:00.000Z");
    expect(applyProviderTaskDismissals([stale], { stale: "2026-08-02T10:00:00.000Z" })).toEqual([]);
  });

  it("leaves everything visible when nothing is dismissed", () => {
    const tasks = [task("a", "running"), task("b", "failed")];
    expect(applyProviderTaskDismissals(tasks, {})).toHaveLength(2);
  });
});

describe("dismissableProviderTaskIds", () => {
  it("covers finished, failed, stopped and stale work", () => {
    const tasks = [
      task("done", "completed"),
      task("bad", "failed"),
      task("halted", "stopped"),
      task("quiet", "stale"),
    ];
    expect(dismissableProviderTaskIds(tasks).toSorted()).toEqual([
      "bad",
      "done",
      "halted",
      "quiet",
    ]);
  });

  it("never includes running work", () => {
    // A bulk control gets pressed without reading the rows, so it must not be
    // able to hide something still in flight.
    const tasks = [task("live", "running"), task("done", "completed")];
    expect(dismissableProviderTaskIds(tasks)).toEqual(["done"]);
  });

  it("reports whether there is anything to clear", () => {
    expect(hasDismissableProviderTasks([task("live", "running")])).toBe(false);
    expect(hasDismissableProviderTasks([task("done", "completed")])).toBe(true);
    expect(hasDismissableProviderTasks([])).toBe(false);
  });
});

describe("pruneProviderTaskDismissals", () => {
  const nowMs = Date.parse("2026-08-02T12:00:00.000Z");

  it("keeps recent dismissals", () => {
    const kept = pruneProviderTaskDismissals({ a: "2026-08-02T11:00:00.000Z" }, { nowMs });
    expect(kept).toEqual({ a: "2026-08-02T11:00:00.000Z" });
  });

  it("drops dismissals for tasks that have aged out of the panel anyway", () => {
    // Tasks disappear after PROVIDER_TASK_MAX_AGE_MS, so a record older than
    // that can never hide anything again — it would just accumulate forever.
    const old = new Date(nowMs - PROVIDER_TASK_MAX_AGE_MS - 1000).toISOString();
    expect(pruneProviderTaskDismissals({ a: old }, { nowMs })).toEqual({});
  });

  it("drops unparseable timestamps rather than keeping them forever", () => {
    expect(pruneProviderTaskDismissals({ a: "not-a-date" }, { nowMs })).toEqual({});
  });
});
