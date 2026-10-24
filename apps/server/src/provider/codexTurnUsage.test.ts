import { describe, expect, it } from "vite-plus/test";

import { makeCodexTurnUsageTracker } from "./codexTurnUsage.ts";

const totals = (input: number, cached: number, output: number, reasoning = 0) => ({
  inputTokens: input,
  cachedInputTokens: cached,
  outputTokens: output,
  reasoningOutputTokens: reasoning,
});

describe("makeCodexTurnUsageTracker", () => {
  it("measures a turn from the total before its first request", () => {
    const tracker = makeCodexTurnUsageTracker();
    // A resumed thread: 50k tokens of history before this turn.
    tracker.observe({
      threadId: "codex-thread",
      turnId: "turn-1",
      total: totals(41_000, 30_000, 10_500, 400),
      last: totals(1_000, 600, 500, 400),
    });
    tracker.observe({
      threadId: "codex-thread",
      turnId: "turn-1",
      total: totals(43_000, 31_500, 11_000, 600),
      last: totals(2_000, 1_500, 500, 200),
    });
    expect(tracker.complete({ threadId: "codex-thread", turnId: "turn-1" })).toEqual({
      // 3,000 prompt tokens, 2,100 of them cached reads.
      inputTokens: 900,
      cachedInputTokens: 2_100,
      cacheWriteTokens: 0,
      outputTokens: 1_000,
      reasoningTokens: 600,
    });
    // Completing again finds nothing: the turn was already reported.
    expect(tracker.complete({ threadId: "codex-thread", turnId: "turn-1" })).toBeUndefined();
  });

  it("keeps a sub-agent's thread apart from its parent", () => {
    const tracker = makeCodexTurnUsageTracker();
    tracker.observe({
      threadId: "parent",
      turnId: "turn-1",
      total: totals(100, 0, 10),
      last: totals(100, 0, 10),
    });
    tracker.observe({
      threadId: "child",
      turnId: "turn-1",
      total: totals(9_000, 0, 900),
      last: totals(9_000, 0, 900),
    });
    expect(tracker.complete({ threadId: "parent", turnId: "turn-1" })).toMatchObject({
      inputTokens: 100,
      outputTokens: 10,
    });
  });

  it("reports nothing when the totals went backwards or the turn used none", () => {
    const tracker = makeCodexTurnUsageTracker();
    tracker.observe({
      threadId: "thread",
      turnId: "turn-1",
      total: totals(500, 0, 50),
      last: totals(100, 0, 10),
    });
    tracker.observe({
      threadId: "thread",
      turnId: "turn-1",
      total: totals(200, 0, 20),
      last: totals(100, 0, 10),
    });
    expect(tracker.complete({ threadId: "thread", turnId: "turn-1" })).toBeUndefined();
    expect(tracker.complete({ threadId: "thread", turnId: "never-reported" })).toBeUndefined();
  });
});
