import { isTerminalProviderRefusal } from "@t3tools/shared/agentMode";
import { describe, expect, it } from "@effect/vitest";

import {
  grokBillingIsExhausted,
  grokOnDemandUsage,
  grokPrepaidBalance,
  grokTokenUsageFromSessionInfo,
  grokTokenUsageFromSessionUsage,
  grokTokenUsageFromUsageUpdate,
  grokWeeklyResetAtMs,
  grokUsageExhaustedMessage,
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

  // 2026-09-18: xAI stopped sending creditUsagePercent the moment the account
  // could no longer serve a turn, so reading the omission as 0% showed a
  // confident "0%" for a provider refusing everything. Unknown stays unknown.
  it("reports an omitted weekly percentage as unknown, not zero", () => {
    const { creditUsagePercent: _creditUsagePercent, ...omittedPercentConfig } = liveBilling.config;

    expect(grokWeeklyUsagePercent({ config: omittedPercentConfig })).toBeUndefined();
    expect(grokBillingIsExhausted({ config: omittedPercentConfig })).toBe(false);
    expect(grokWeeklyUsagePercent({ config: { prepaidBalance: { val: 0 } } })).toBeUndefined();
    expect(
      grokWeeklyUsagePercent({ config: { ...omittedPercentConfig, creditUsagePercent: 0 } }),
    ).toBe(0);
  });

  it("explains an exhausted Grok balance in words a user can act on", () => {
    const raw = "API error (status 402 Payment Required): Grok Build usage balance exhausted";
    const message = grokUsageExhaustedMessage(raw);

    expect(message).toMatch(/usage balance is exhausted/u);
    expect(message).toMatch(/grok\.com/u);
    // Keeps the provider's phrase so the shared terminal-refusal check retires
    // the retry loop rather than spending eight attempts on it.
    expect(isTerminalProviderRefusal(message ?? "")).toBe(true);
    expect(grokUsageExhaustedMessage("Streaming response failed")).toBeUndefined();
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
