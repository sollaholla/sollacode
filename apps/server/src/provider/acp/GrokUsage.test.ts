import { describe, expect, it } from "@effect/vitest";

import {
  grokBillingIsExhausted,
  grokOnDemandUsage,
  grokPrepaidBalance,
  grokTokenUsageFromSessionInfo,
  grokTokenUsageFromSessionUsage,
  grokTokenUsageFromUsageUpdate,
  grokWeeklyResetAtMs,
  grokWeeklyUsagePercent,
  parseGrokSubscription,
} from "./GrokUsage.ts";

const liveBilling = {
  config: {
    creditUsagePercent: 6,
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-08-15T00:00:00+00:00",
      end: "2026-08-22T00:00:00+00:00",
    },
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    prepaidBalance: { val: 0 },
    isUnifiedBillingUser: true,
    billingPeriodStart: "2026-08-15T00:00:00+00:00",
    billingPeriodEnd: "2026-08-22T00:00:00+00:00",
  },
  subscription_tier: "SuperGrok Plus",
};

describe("Grok usage parsers", () => {
  it("reads weekly SuperGrok usage from _x.ai/billing", () => {
    expect(grokWeeklyUsagePercent(liveBilling)).toBe(6);
    expect(grokWeeklyResetAtMs(liveBilling)).toBe(Date.parse("2026-08-22T00:00:00+00:00"));
    expect(grokBillingIsExhausted(liveBilling)).toBe(false);
    expect(grokPrepaidBalance(liveBilling)).toBe(0);
    expect(grokOnDemandUsage(liveBilling)).toBeUndefined();
  });

  it("treats an omitted weekly percentage in an active period as zero usage", () => {
    const { creditUsagePercent: _creditUsagePercent, ...zeroUsageConfig } = liveBilling.config;

    expect(grokWeeklyUsagePercent({ config: zeroUsageConfig })).toBe(0);
    expect(grokBillingIsExhausted({ config: zeroUsageConfig })).toBe(false);
    expect(grokWeeklyUsagePercent({ config: { prepaidBalance: { val: 0 } } })).toBeUndefined();
  });

  it("treats a 100% weekly pool as exhausted", () => {
    expect(
      grokBillingIsExhausted({
        config: { ...liveBilling.config, creditUsagePercent: 100 },
      }),
    ).toBe(true);
  });

  it("parses subscription identity from _x.ai/auth/check_subscription", () => {
    expect(
      parseGrokSubscription({
        authenticated: true,
        meta: {
          email: "developer@example.com",
          subscription_tier: "SuperGrok Plus",
        },
      }),
    ).toEqual({
      authenticated: true,
      email: "developer@example.com",
      subscriptionTier: "SuperGrok Plus",
    });
  });

  it("parses subscription identity from authenticate _meta", () => {
    expect(
      parseGrokSubscription({
        _meta: {
          email: "developer@example.com",
          subscription_tier: "SuperGrok Plus",
        },
      }),
    ).toEqual({
      authenticated: true,
      email: "developer@example.com",
      subscriptionTier: "SuperGrok Plus",
    });
  });

  it("maps session info context onto a token-usage snapshot", () => {
    expect(
      grokTokenUsageFromSessionInfo({
        result: {
          context: {
            used: 4051,
            total: 500000,
            messageTokens: 2535,
            systemPromptTokens: 1516,
            toolDefinitionsTokens: 8448,
            autoCompactThresholdPercent: 80,
          },
        },
      }),
    ).toEqual({
      usedTokens: 4051,
      lastUsedTokens: 4051,
      maxTokens: 500000,
      inputTokens: 12499,
      compactsAutomatically: true,
    });
  });

  it("maps session usage and usage_update payloads", () => {
    expect(
      grokTokenUsageFromSessionUsage({
        usage: {
          inputTokens: 120,
          outputTokens: 40,
          reasoningTokens: 10,
          totalTokens: 170,
          cachedReadTokens: 8,
        },
      }),
    ).toEqual({
      usedTokens: 170,
      lastUsedTokens: 170,
      inputTokens: 120,
      outputTokens: 40,
      cachedInputTokens: 8,
      lastCachedInputTokens: 8,
      reasoningOutputTokens: 10,
      lastReasoningOutputTokens: 10,
      lastOutputTokens: 40,
      lastInputTokens: 120,
    });
    expect(grokTokenUsageFromUsageUpdate({ used: 4051, size: 500000 })).toEqual({
      usedTokens: 4051,
      lastUsedTokens: 4051,
      maxTokens: 500000,
    });
  });
});
