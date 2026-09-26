import type { ThreadTokenUsageSnapshot } from "@t3tools/contracts";

export const GROK_BILLING_METHOD = "x.ai/billing";
export const GROK_SESSION_INFO_METHOD = "x.ai/session/info";
export interface GrokSubscriptionProbe {
  readonly authenticated: boolean;
  readonly email?: string;
  readonly subscriptionTier?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function moneyValue(value: unknown): number | undefined {
  const record = asRecord(value);
  return finiteNumber(record?.val) ?? finiteNumber(value);
}

export function grokBillingConfig(raw: unknown): Record<string, unknown> | null {
  const envelope = asRecord(raw);
  if (!envelope) return null;
  return asRecord(envelope.config) ?? envelope;
}

export function parseGrokSubscription(raw: unknown): GrokSubscriptionProbe | undefined {
  const envelope = asRecord(raw);
  if (!envelope) return undefined;
  const meta = asRecord(envelope.meta) ?? asRecord(envelope._meta) ?? envelope;
  const authenticated = envelope.authenticated === true || Boolean(nonEmptyString(meta.email));
  if (!authenticated && envelope.authenticated !== true) {
    return undefined;
  }
  const email = nonEmptyString(meta.email);
  const subscriptionTier =
    nonEmptyString(meta.subscription_tier) ?? nonEmptyString(envelope.subscription_tier);
  return {
    authenticated: true,
    ...(email !== undefined ? { email } : {}),
    ...(subscriptionTier !== undefined ? { subscriptionTier } : {}),
  };
}

/**
 * Absence is not zero. Grok's billing response is protobuf-shaped, so a
 * `creditUsagePercent` of 0 really is omitted — but so is the field once the
 * account's balance runs out: on 2026-09-18 the same CLI build reported 47,
 * 48, 49 then 52 all afternoon, and from the moment prompts started failing
 * with "Grok Build usage balance exhausted" the field simply stopped
 * appearing. Reading that omission as an authoritative 0% put a confident
 * "0%" on the usage bar for a provider that was refusing every turn, which is
 * the worst of both readings. Unknown stays unknown and the chip hides.
 */
export function grokWeeklyUsagePercent(raw: unknown): number | undefined {
  return finiteNumber(grokBillingConfig(raw)?.creditUsagePercent);
}

export function grokWeeklyResetAtMs(raw: unknown): number | undefined {
  const config = grokBillingConfig(raw);
  const period = asRecord(config?.currentPeriod);
  const end =
    nonEmptyString(period?.end) ??
    nonEmptyString(config?.billingPeriodEnd) ??
    nonEmptyString(config?.billingPeriodStart);
  if (!end) return undefined;
  const parsed = Date.parse(end);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function grokBillingIsExhausted(raw: unknown): boolean {
  const used = grokWeeklyUsagePercent(raw);
  return used !== undefined && used >= 100;
}

function grokSessionInfoResult(raw: unknown): Record<string, unknown> | null {
  const envelope = asRecord(raw);
  if (!envelope) return null;
  return asRecord(envelope.result) ?? envelope;
}

export function grokTokenUsageFromSessionInfo(raw: unknown): ThreadTokenUsageSnapshot | undefined {
  const result = grokSessionInfoResult(raw);
  const context = asRecord(result?.context);
  if (!context) return undefined;
  const usedTokens = finiteNumber(context.used);
  if (usedTokens === undefined || usedTokens < 0) return undefined;
  const maxTokens = finiteNumber(context.total);
  const messageTokens = finiteNumber(context.messageTokens);
  const systemPromptTokens = finiteNumber(context.systemPromptTokens);
  const toolDefinitionsTokens = finiteNumber(context.toolDefinitionsTokens);
  const inputTokens =
    messageTokens !== undefined ||
    systemPromptTokens !== undefined ||
    toolDefinitionsTokens !== undefined
      ? (messageTokens ?? 0) + (systemPromptTokens ?? 0) + (toolDefinitionsTokens ?? 0)
      : undefined;
  return {
    usedTokens,
    lastUsedTokens: usedTokens,
    ...(maxTokens !== undefined && maxTokens > 0 ? { maxTokens } : {}),
    ...(inputTokens !== undefined && inputTokens > 0 ? { inputTokens } : {}),
    ...(typeof context.autoCompactThresholdPercent === "number"
      ? { compactsAutomatically: context.autoCompactThresholdPercent > 0 }
      : {}),
  };
}

export function grokTokenUsageFromSessionUsage(raw: unknown): ThreadTokenUsageSnapshot | undefined {
  const envelope = asRecord(raw);
  const usage = asRecord(envelope?.usage) ?? envelope;
  if (!usage) return undefined;
  const inputTokens = finiteNumber(usage.inputTokens);
  const outputTokens = finiteNumber(usage.outputTokens);
  const reasoningTokens = finiteNumber(usage.reasoningTokens);
  const cachedInputTokens =
    finiteNumber(usage.cachedReadTokens) ?? finiteNumber(usage.cacheCreationTokens);
  const totalTokens = finiteNumber(usage.totalTokens);
  const usedTokens =
    totalTokens ??
    (inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0) + (reasoningTokens ?? 0)
      : undefined);
  if (usedTokens === undefined || usedTokens <= 0) return undefined;
  return {
    usedTokens,
    lastUsedTokens: usedTokens,
    ...(inputTokens !== undefined && inputTokens > 0 ? { inputTokens } : {}),
    ...(outputTokens !== undefined && outputTokens > 0 ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined && cachedInputTokens > 0
      ? { cachedInputTokens, lastCachedInputTokens: cachedInputTokens }
      : {}),
    ...(reasoningTokens !== undefined && reasoningTokens > 0
      ? { reasoningOutputTokens: reasoningTokens, lastReasoningOutputTokens: reasoningTokens }
      : {}),
    ...(outputTokens !== undefined && outputTokens > 0 ? { lastOutputTokens: outputTokens } : {}),
    ...(inputTokens !== undefined && inputTokens > 0 ? { lastInputTokens: inputTokens } : {}),
  };
}

export function grokTokenUsageFromUsageUpdate(input: {
  readonly used: number;
  readonly size: number;
}): ThreadTokenUsageSnapshot | undefined {
  if (!Number.isFinite(input.used) || input.used < 0) return undefined;
  const usedTokens = Math.round(input.used);
  const maxTokens =
    Number.isFinite(input.size) && input.size > 0 ? Math.round(input.size) : undefined;
  return {
    usedTokens,
    lastUsedTokens: usedTokens,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

export function grokPrepaidBalance(raw: unknown): number | undefined {
  return moneyValue(grokBillingConfig(raw)?.prepaidBalance);
}

export function grokOnDemandUsage(raw: unknown):
  | {
      readonly used: number;
      readonly cap: number;
    }
  | undefined {
  const config = grokBillingConfig(raw);
  const used = moneyValue(config?.onDemandUsed);
  const cap = moneyValue(config?.onDemandCap);
  if (used === undefined || cap === undefined || cap <= 0) return undefined;
  return { used, cap };
}

/**
 * Grok's own words for an exhausted account are "API error (status 402
 * Payment Required): Grok Build usage balance exhausted" — accurate, and
 * unreadable to anyone who does not already know that Grok Build bills
 * against a weekly balance. Say what ran out and what to do about it, and
 * keep the phrase "usage balance exhausted" in the text so the shared
 * terminal-refusal check retires the retry loop instead of spending eight
 * attempts on a balance that no retry can refill.
 */
export function grokUsageExhaustedMessage(detail: string): string | undefined {
  if (!/usage balance exhausted/iu.test(detail)) return undefined;
  return (
    "Grok Build's usage balance is exhausted, so xAI declined this turn " +
    "(HTTP 402, usage balance exhausted). The balance refills when your weekly " +
    "period resets, or you can add credit at https://grok.com, or switch this " +
    "thread to a different provider and send the message again."
  );
}
