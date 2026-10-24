import { describe, expect, it } from "vite-plus/test";

import { selectCurrentTaskList, TASK_LIST_ACTIVITY_KIND } from "./taskLists.ts";

const activity = (id: string, createdAt: string, kind = TASK_LIST_ACTIVITY_KIND) => ({
  id,
  kind,
  createdAt,
});

describe("selectCurrentTaskList", () => {
  it("takes the newest task list, ignoring other activity", () => {
    expect(
      selectCurrentTaskList([
        activity("older", "2026-01-01T00:00:00Z"),
        activity("newer", "2026-01-02T00:00:00Z"),
        activity("tool", "2026-01-03T00:00:00Z", "tool.completed"),
      ])?.id,
    ).toBe("newer");
  });

  it("drops a list made before the newest proposed plan", () => {
    const lists = [activity("old-work", "2026-01-01T00:00:00Z")];
    expect(
      selectCurrentTaskList(lists, { newestProposedPlanCreatedAt: "2026-01-02T00:00:00Z" }),
    ).toBeNull();
    expect(
      selectCurrentTaskList([...lists, activity("plan-work", "2026-01-03T00:00:00Z")], {
        newestProposedPlanCreatedAt: "2026-01-02T00:00:00Z",
      })?.id,
    ).toBe("plan-work");
  });

  it("returns nothing when there is no list", () => {
    expect(selectCurrentTaskList([])).toBeNull();
  });
});
