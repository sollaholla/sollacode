import { describe, expect, it } from "vite-plus/test";

import { claudeTurnUsage, EMPTY_CLAUDE_USAGE_LEDGER } from "./claudeTurnUsage.ts";

const modelUsage = (
  models: Record<
    string,
    { input: number; cacheRead: number; cacheWrite: number; output: number; cost?: number }
  >,
) =>
  Object.fromEntries(
    Object.entries(models).map(([model, usage]) => [
      model,
      {
        inputTokens: usage.input,
        cacheReadInputTokens: usage.cacheRead,
        cacheCreationInputTokens: usage.cacheWrite,
        outputTokens: usage.output,
        costUSD: usage.cost ?? 0,
        webSearchRequests: 0,
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
      },
    ]),
  );

describe("claudeTurnUsage", () => {
  it("measures each turn by how far the session's totals grew, sub-agents included", () => {
    const first = claudeTurnUsage({
      ledger: EMPTY_CLAUDE_USAGE_LEDGER,
      model: "claude-opus-5-5",
      result: {
        usage: { input_tokens: 10, cache_read_input_tokens: 900, output_tokens: 50 },
        modelUsage: modelUsage({
          "claude-opus-5-5": { input: 10, cacheRead: 900, cacheWrite: 100, output: 50 },
        }),
        total_cost_usd: 0.25,
      },
    });
    expect(first.usage).toEqual({
      inputTokens: 10,
      cachedInputTokens: 900,
      cacheWriteTokens: 100,
      outputTokens: 50,
      costUsd: 0.25,
      model: "claude-opus-5-5",
    });

    // A sub-agent on another model joins in the second turn.
    const second = claudeTurnUsage({
      ledger: first.ledger,
      model: "claude-opus-5-5",
      result: {
        usage: { input_tokens: 5, output_tokens: 20 },
        modelUsage: modelUsage({
          "claude-opus-5-5": { input: 15, cacheRead: 1_900, cacheWrite: 100, output: 70 },
          "claude-haiku-5-5": { input: 3_000, cacheRead: 0, cacheWrite: 0, output: 400 },
        }),
        total_cost_usd: 0.4,
      },
    });
    expect(second.usage).toEqual({
      inputTokens: 3_005,
      cachedInputTokens: 1_000,
      cacheWriteTokens: 0,
      outputTokens: 420,
      costUsd: 0.15,
      model: "claude-haiku-5-5",
    });
  });

  it("falls back to the turn's main loop when the session's starting point is unknown", () => {
    const resumed = claudeTurnUsage({
      ledger: undefined,
      model: "claude-opus-5-5",
      result: {
        usage: {
          input_tokens: 7,
          cache_read_input_tokens: 70,
          cache_creation_input_tokens: 3,
          output_tokens: 9,
        },
        // Restored from before the resume: not this turn's.
        modelUsage: modelUsage({
          "claude-opus-5-5": { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 1 },
        }),
        total_cost_usd: 42,
      },
    });
    expect(resumed.usage).toEqual({
      inputTokens: 7,
      cachedInputTokens: 70,
      cacheWriteTokens: 3,
      outputTokens: 9,
      model: "claude-opus-5-5",
    });
    // The next turn is measured exactly from there.
    const next = claudeTurnUsage({
      ledger: resumed.ledger,
      model: "claude-opus-5-5",
      result: {
        modelUsage: modelUsage({
          "claude-opus-5-5": { input: 1_000_010, cacheRead: 0, cacheWrite: 0, output: 6 },
        }),
        total_cost_usd: 42.5,
      },
    });
    expect(next.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, costUsd: 0.5 });
  });

  it("treats counters that went backwards as a different session", () => {
    const usage = claudeTurnUsage({
      ledger: {
        models: {
          "claude-opus-5-5": {
            inputTokens: 500,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 50,
          },
        },
        costUsd: 3,
      },
      model: "claude-opus-5-5",
      result: {
        usage: { input_tokens: 4, output_tokens: 2 },
        modelUsage: modelUsage({
          "claude-opus-5-5": { input: 20, cacheRead: 0, cacheWrite: 0, output: 5 },
        }),
      },
    });
    expect(usage.usage).toMatchObject({ inputTokens: 4, outputTokens: 2 });
    expect(usage.ledger?.models["claude-opus-5-5"]?.inputTokens).toBe(20);
  });

  it("reports nothing for an interrupted turn without a result", () => {
    expect(
      claudeTurnUsage({ ledger: EMPTY_CLAUDE_USAGE_LEDGER, model: undefined, result: undefined }),
    ).toEqual({ usage: undefined, ledger: EMPTY_CLAUDE_USAGE_LEDGER });
  });
});
