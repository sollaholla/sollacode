import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_USAGE_GUARD_PROVIDER_SETTINGS as config } from "@t3tools/contracts";
import {
  codexCreditCost,
  codexCreditRate,
  creditBudgetDay,
  emptyCreditLedger,
  readCodexCredits,
  recordCreditTokens,
} from "./usageGuardCredits.ts";
import {
  emptyUsageGuardInstanceState,
  evaluateUsageGuard,
  effortCostKey,
  recordBackgroundAdmission,
  extractUsageWindows,
  recordWindowsIntoState,
  recordUsageGuardCredits,
  recordTokensIntoState,
  resolveUsageGuardEvaluationModel,
} from "./ProviderUsageGuard.ts";
const now = Date.parse("2026-09-06T16:00:00Z");
const raw = (balance: string) => ({
  rateLimits: {
    secondary: {
      usedPercent: 100,
      windowDurationMins: 10080,
      resetsAt: (now + 6 * 86400000) / 1000,
    },
    credits: { balance, hasCredits: true, unlimited: false },
  },
});
function state(balance: string) {
  return recordUsageGuardCredits(
    recordWindowsIntoState(
      emptyUsageGuardInstanceState("codex"),
      extractUsageWindows("codex", raw(balance)),
      now,
    ),
    raw(balance),
  );
}
describe("credit budget pacing", () => {
  it("scales the $0 to $50 budget over a 24-hour window", () => {
    const full = evaluateUsageGuard({
      state: state("1250"),
      config,
      nowMs: now,
      model: "gpt-6-astra",
    });
    expect(full.estimatedPercent).toBe(0);
    // Extra usage paces against a daily budget, so the window ends at midnight.
    expect(full.resetsAtMs).toBe(creditBudgetDay(now).endsAt);
    expect(full.effortTarget).toBeNull();
    const half = evaluateUsageGuard({
      state: state("625"),
      config,
      nowMs: now,
      model: "gpt-6-astra",
    });
    expect(half.estimatedPercent).toBe(50);
    const tomorrow = evaluateUsageGuard({
      state: state("625"),
      config,
      nowMs: now + 86400000,
      model: "gpt-6-astra",
    });
    expect(tomorrow.estimatedPercent).toBe(half.estimatedPercent);
    expect(tomorrow.backgroundCooldownMs).toBe(half.backgroundCooldownMs);
    const zero = evaluateUsageGuard({
      state: state("1250"),
      config: { ...config, creditBalanceScaleUsd: 0 },
      nowMs: now,
      model: "gpt-6-astra",
    });
    expect(zero.tier).toBe("pause");
  });
  it("uses the provider's default model before the first call after restart", () => {
    const model = resolveUsageGuardEvaluationModel({
      requested: null,
      lastUsed: null,
      models: [{ slug: "gpt-6-astra", isDefault: true }],
    });
    expect(evaluateUsageGuard({ state: state("1000"), config, nowMs: now, model }).tier).toBe(
      "extra-usage",
    );
    expect(
      resolveUsageGuardEvaluationModel({
        requested: "gpt-5.6-luna",
        lastUsed: "gpt-6-astra",
        models: [],
      }),
    ).toBe("gpt-5.6-luna");
    expect(
      resolveUsageGuardEvaluationModel({ requested: null, lastUsed: null, models: [] }),
    ).toBeNull();
  });
  it("prices input, cached input, output and Astra fast mode in credits", () => {
    const usage = { input: 1_000_000, cached: 500_000, output: 100_000 };
    expect(codexCreditCost("gpt-6-astra", usage)).toBe(262.5);
    expect(codexCreditCost("gpt-6-astra", usage, true)).toBe(656.25);
    expect(codexCreditCost("unknown", usage)).toBeNull();
  });
  it("reads string balances without turning unknown values into free usage", () => {
    expect(readCodexCredits(raw("240.5"), 0)?.balance).toBe(240.5);
    expect(readCodexCredits(raw("unknown"), 0)?.balance).toBeNull();
    expect(readCodexCredits({}, 0)).toBeNull();
  });
  it("uses remaining credits at 100% weekly and tightens cooldown as credits decrease", () => {
    const full = state("1000");
    const low = recordUsageGuardCredits(full, raw("100"));
    const options = { config, nowMs: now, model: "gpt-6-astra", activeThreads: 1 };
    const a = evaluateUsageGuard({ ...options, state: full });
    const b = evaluateUsageGuard({ ...options, state: low });
    expect(a.tier).toBe("extra-usage");
    expect(a.windowKey).toBe("paid-credits");
    expect(b.tier).toBe("extra-usage");
    expect(b.backgroundCooldownMs!).toBeGreaterThan(a.backgroundCooldownMs!);
    expect(a.tokensPerPercent).not.toBe(4_500_000);
  });
  it("stops at exhausted credits, respects avoid, and recognizes top-ups", () => {
    // Out of credits with the window spent: nothing to wait for, so the guard
    // steps aside and the provider's own refusal is what the person sees.
    expect(
      evaluateUsageGuard({ state: state("0"), config, nowMs: now, model: "gpt-6-astra" }).tier,
    ).toBe("optimize");
    expect(
      evaluateUsageGuard({
        state: state("1000"),
        config: { ...config, extraUsage: "avoid" },
        nowMs: now,
        model: "gpt-6-astra",
      }).tier,
    ).toBe("pause");
    const toppedUp = recordUsageGuardCredits(state("0"), raw("500"));
    expect(
      evaluateUsageGuard({ state: toppedUp, config, nowMs: now, model: "gpt-6-astra" }).tier,
    ).toBe("extra-usage");
  });
  it("does not charge previous history or repeated token reports twice", () => {
    const input = {
      threadKey: "thread",
      model: "gpt-6-astra",
      nowMs: now,
      usage: {
        usedTokens: 1000,
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 100_000,
        lastInputTokens: 1000,
        lastOutputTokens: 100,
      },
    };
    const first = recordCreditTokens(emptyCreditLedger(), input);
    expect(first.spent).toBe(0.375);
    expect(recordCreditTokens(first, input).spent).toBe(first.spent);
  });
  it("learns the cost of included calls without charging the paid balance", () => {
    const included = raw("1000");
    included.rateLimits.secondary.usedPercent = 10;
    const initial = recordWindowsIntoState(
      state("1000"),
      extractUsageWindows("codex", included),
      now,
    );
    const learned = recordTokensIntoState(initial, {
      tokens: 500000,
      model: "gpt-6-astra",
      nowMs: now,
      threadKey: "included",
      usage: {
        usedTokens: 500000,
        inputTokens: 500000,
        lastInputTokens: 500000,
        outputTokens: 0,
        lastOutputTokens: 0,
      },
    });
    expect(learned.creditLedger?.spent).toBe(125);
    expect(learned.credits?.spentAtReport).toBe(125);
    const exhausted = recordWindowsIntoState(
      learned,
      extractUsageWindows("codex", raw("1000")),
      now,
    );
    expect(
      evaluateUsageGuard({ state: exhausted, config, nowMs: now, model: "gpt-6-astra" }).summary,
    ).toContain("$40.00 remaining in today’s $50 budget");
  });
  it("consumption between reports reduces credits without the subscription extrapolation cap", () => {
    const initial = state("100");
    const spent = recordTokensIntoState(initial, {
      tokens: 500_000,
      model: "gpt-6-astra",
      nowMs: now,
      threadKey: "thread",
      usage: {
        usedTokens: 500_000,
        inputTokens: 500_000,
        lastInputTokens: 500_000,
        outputTokens: 0,
        lastOutputTokens: 0,
      },
    });
    expect(
      evaluateUsageGuard({ state: spent, config, nowMs: now, model: "gpt-6-astra" }).tier,
    ).toBe("pause");
  });
});

it("charges identical Codex calls separately but deduplicates the same processed total", () => {
  const usage = {
    usedTokens: 110_000,
    inputTokens: 100_000,
    cachedInputTokens: 50_000,
    outputTokens: 10_000,
    lastInputTokens: 100_000,
    lastCachedInputTokens: 50_000,
    lastOutputTokens: 10_000,
    totalProcessedTokens: 220_000,
  };
  const first = recordTokensIntoState(state("1000"), {
    tokens: usage.usedTokens,
    model: "gpt-6-astra",
    threadKey: "same-thread",
    usage,
    nowMs: now,
  });
  const second = recordTokensIntoState(first, {
    tokens: usage.usedTokens,
    model: "gpt-6-astra",
    threadKey: "same-thread",
    usage: { ...usage, totalProcessedTokens: 330_000 },
    nowMs: now + 1000,
  });
  expect(second.creditLedger!.spent).toBe(first.creditLedger!.spent * 2);
  expect(second.tokensTotal).toBe(first.tokensTotal * 2);
  const duplicate = recordTokensIntoState(second, {
    tokens: usage.usedTokens,
    model: "gpt-6-astra",
    threadKey: "same-thread",
    usage: { ...usage, totalProcessedTokens: 330_000 },
    nowMs: now + 2000,
  });
  expect(duplicate.creditLedger!.spent).toBe(second.creditLedger!.spent);
  expect(duplicate.tokensTotal).toBe(second.tokensTotal);
});

it("uses measured effort prices for paid pacing while preserving already spent credits", () => {
  const model = "gpt-6-astra";
  const base = recordBackgroundAdmission(
    {
      ...state("625"),
      costByEffort: {
        [effortCostKey(model, "high", false)]: {
          ewmaWeightedTokens: 150_000,
          credits: 10,
          samples: 3,
        },
        [effortCostKey(model, "low", false)]: {
          ewmaWeightedTokens: 100_000,
          credits: 2,
          samples: 3,
        },
      },
    },
    now,
  );
  const input = { state: base, config, nowMs: now, model };
  expect(evaluateUsageGuard({ ...input, effort: "low" }).backgroundCooldownMs!).toBeLessThan(
    evaluateUsageGuard({ ...input, effort: "high" }).backgroundCooldownMs!,
  );
  const debt = { ...base, creditLedger: { ...emptyCreditLedger(), spent: 20 } };
  expect(evaluateUsageGuard({ ...input, state: debt, effort: "low" }).backgroundCooldownMs).toBe(
    evaluateUsageGuard({ ...input, state: debt, effort: "high" }).backgroundCooldownMs,
  );
});

describe("codexCreditRate", () => {
  it("matches published slugs exactly and tolerant variants by substring", () => {
    expect(codexCreditRate("gpt-6-astra")).toEqual([250, 25, 1250]);
    expect(codexCreditRate("gpt-5.6-daybreak-blue")).toEqual([100, 10, 500]);
    expect(codexCreditRate("gpt-5.6-daybreak-red")).toEqual([312.5, 31.25, 1875]);
    // The longer key wins, so mini is not priced as the full 5.4.
    expect(codexCreditRate("gpt-5.4-mini")).toEqual([18.75, 1.875, 113]);
    expect(codexCreditRate("gpt-5.4")).toEqual([62.5, 6.25, 375]);
  });
  it("invents no rate for models without a published one", () => {
    expect(codexCreditRate("gpt-5.3-codex-spark")).toBeUndefined();
    expect(codexCreditRate(null)).toBeUndefined();
    expect(codexCreditCost("gpt-5.3-codex-spark", { input: 1, cached: 0, output: 1 })).toBeNull();
  });
});
