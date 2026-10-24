import { ThreadId, type OrchestrationLiveBeat } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyLiveFeedEvent, upsertLiveBeats } from "./liveFeed.ts";

const beat = (
  id: string,
  overrides: Partial<OrchestrationLiveBeat> = {},
): OrchestrationLiveBeat => ({
  id,
  threadId: ThreadId.make("thread"),
  kind: "command",
  title: "Running",
  detail: id,
  live: true,
  at: "2026-10-11T20:00:00.000Z",
  ...overrides,
});

describe("live feed window", () => {
  it("replaces a beat in place and keeps only the newest", () => {
    const replaced = upsertLiveBeats([beat("a"), beat("b")], [beat("a", { live: false })], 3);
    expect(replaced.map((entry) => [entry.id, entry.live])).toEqual([
      ["a", false],
      ["b", true],
    ]);
    expect(upsertLiveBeats(replaced, [beat("c")], 2).map((entry) => entry.id)).toEqual(["b", "c"]);
  });

  it("starts over from a snapshot", () => {
    const window = applyLiveFeedEvent(
      [beat("old")],
      { type: "snapshot", beats: [beat("x"), beat("y"), beat("z")] },
      2,
    );
    expect(window.map((entry) => entry.id)).toEqual(["y", "z"]);
    expect(
      applyLiveFeedEvent(window, { type: "beat", beat: beat("z", { title: "Ran" }) }, 2).map(
        (entry) => entry.title,
      ),
    ).toEqual(["Running", "Ran"]);
  });
});
