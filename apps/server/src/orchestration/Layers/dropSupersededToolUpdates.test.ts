import { describe, expect, it } from "vite-plus/test";

import { dropSupersededToolUpdates } from "./ProjectionSnapshotQuery.ts";

const updated = (toolCallId: string | null) => ({
  kind: "tool.updated",
  payload: { data: toolCallId === null ? {} : { toolCallId }, content: "partial output" },
});
const completed = (toolCallId: string) => ({
  kind: "tool.completed",
  payload: { data: { toolCallId }, content: "final output" },
});

/**
 * Measured on a real thread: all 257 `tool.updated` rows in a 750-activity
 * snapshot were superseded, carrying 2125 KB of a 6389 KB payload that is
 * schema-decoded twice — server and client — before a thread stops loading.
 */
describe("dropSupersededToolUpdates", () => {
  it("drops an in-flight frame the completion already replaced", () => {
    const result = dropSupersededToolUpdates([updated("call-1"), completed("call-1")]);
    expect(result).toEqual([completed("call-1")]);
  });

  it("keeps a tool that never completed, its last frame being the only record", () => {
    // An interrupted turn has no completion to fall back on.
    const activities = [updated("call-1"), completed("call-2"), updated("call-2")];
    expect(dropSupersededToolUpdates(activities)).toEqual([updated("call-1"), completed("call-2")]);
  });

  it("keeps a frame with no tool call id, which nothing can supersede", () => {
    const activities = [updated(null), completed("call-1")];
    expect(dropSupersededToolUpdates(activities)).toEqual(activities);
  });

  it("leaves every other kind of activity untouched", () => {
    const others = [
      { kind: "message.delivered", payload: { data: { toolCallId: "call-1" } } },
      { kind: "tool.started", payload: { data: { toolCallId: "call-1" } } },
      completed("call-1"),
    ];
    expect(dropSupersededToolUpdates(others)).toEqual(others);
  });

  it("returns the input untouched when nothing completed", () => {
    const activities = [updated("call-1"), updated("call-2")];
    expect(dropSupersededToolUpdates(activities)).toBe(activities);
  });

  it("tolerates malformed payloads rather than dropping data on a guess", () => {
    const malformed = [
      { kind: "tool.updated", payload: null },
      { kind: "tool.updated", payload: { data: "not-an-object" } },
      completed("call-1"),
    ];
    expect(dropSupersededToolUpdates(malformed)).toEqual(malformed);
  });
});
