import { describe, expect, it } from "vite-plus/test";

import {
  activitiesSinceHistoryRecovery,
  describeOversizedToolResult,
  freshSessionOverflowed,
  PROVIDER_HISTORY_COMPACTED_ACTIVITY_KIND,
  PROVIDER_HISTORY_RESET_ACTIVITY_KIND,
} from "./ProviderCommandReactor.ts";

const at = (second: number) => `2026-09-22T23:26:${String(second).padStart(2, "0")}.000Z`;
const reset = (second: number) => ({
  kind: PROVIDER_HISTORY_RESET_ACTIVITY_KIND,
  createdAt: at(second),
});
const tool = (second: number, payload?: unknown) => ({
  kind: "tool.completed",
  createdAt: at(second),
  payload,
});

describe("freshSessionOverflowed", () => {
  it("is false before any reset", () => {
    expect(freshSessionOverflowed({ activities: [tool(1)], messages: [] })).toBe(false);
  });

  it("is true when nothing ran and nothing was answered after the newest reset", () => {
    expect(
      freshSessionOverflowed({
        activities: [tool(1), reset(5)],
        messages: [
          { role: "assistant", text: "done earlier", createdAt: at(2) },
          { role: "user", text: "resent", createdAt: at(6) },
        ],
      }),
    ).toBe(true);
  });

  it("is false once the fresh session ran a tool or answered", () => {
    expect(freshSessionOverflowed({ activities: [reset(5), tool(8)], messages: [] })).toBe(false);
    expect(
      freshSessionOverflowed({
        activities: [reset(5)],
        messages: [{ role: "assistant", text: "on it", createdAt: at(9) }],
      }),
    ).toBe(false);
  });

  it("ignores a blank assistant row", () => {
    expect(
      freshSessionOverflowed({
        activities: [reset(5)],
        messages: [{ role: "assistant", text: "\n", createdAt: at(9) }],
      }),
    ).toBe(true);
  });
});

describe("activitiesSinceHistoryRecovery", () => {
  it("does not blame a large tool result the last recovery already discarded", () => {
    const large = { title: "agent_workspace", detail: "x".repeat(250_000) };
    const activities = [
      tool(1, large),
      { kind: PROVIDER_HISTORY_COMPACTED_ACTIVITY_KIND, createdAt: at(3), payload: undefined },
    ];
    expect(describeOversizedToolResult(activities)).toContain("agent_workspace");
    expect(activitiesSinceHistoryRecovery(activities)).toEqual([]);
    expect(describeOversizedToolResult(activitiesSinceHistoryRecovery(activities))).toBeUndefined();
  });

  it("keeps everything when there was no recovery", () => {
    const activities = [tool(1), tool(2)];
    expect(activitiesSinceHistoryRecovery(activities)).toEqual(activities);
  });
});
