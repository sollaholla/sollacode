import { creditBudgetDay } from "./usageGuardCredits.ts";
import { antigravityUsageModelFamily } from "@t3tools/shared/model";
import { usageGuardPaceAllowance } from "@t3tools/shared/usageGuardCurve";
import { antigravityUsageWindowsFromAccountUsage } from "../provider/antigravityUsage.ts";
import {
  emptyCreditLedger,
  creditTurnCost,
  readCodexCredits,
  recordCreditTokens,
  type CreditLedger,
  type UsageGuardCredits,
} from "./usageGuardCredits.ts";
import type { ThreadTokenUsageSnapshot } from "@t3tools/contracts";
import type {
  ModelSelection,
  ProviderInstanceId,
  ProviderOptionDescriptor,
  ServerProvider,
  ServerProviderUsageGuardState,
  ServerSettings,
  UsageGuardProviderSettings,
} from "@t3tools/contracts";
import { DEFAULT_USAGE_GUARD_PROVIDER_SETTINGS } from "@t3tools/contracts";

/**
 * Account-wide pacing uses reported windows and measured token consumption.
 * A shared admission clock reserves the next call and charges every subsequent
 * call in that slice. Running turns yield through their durable supervisor;
 * waiting work resumes automatically. Effort reduction never creates assumed
 * quota. Model-family windows and paid-credit windows retain their own limits.
 */

export const USAGE_GUARD_PAUSED_ACTIVITY_KIND = "usage-guard.paused";
export const USAGE_GUARD_RESUMED_ACTIVITY_KIND = "usage-guard.resumed";
export const USAGE_GUARD_OPTIMIZED_ACTIVITY_KIND = "usage-guard.optimized";

/** Obligation `blockedReason` while a delivery waits behind the guard. */
export const USAGE_GUARD_PAUSED_REASON = "held by the usage guard until the usage window has room";

/**
 * Weighted tokens (see `modelCostMultiplier`) per percentage point of the
 * tightest window. Measured 2026-09-05 from this account's own logs at roughly
 * 750k raw tokens per 1% on a mostly Opus/Fable workload; expressed here in
 * Sonnet-equivalent tokens so the same ratio serves every model. Codex was a
 * full 0→100% weekly window at 4.4M–4.7M in Astra-equivalent tokens. Grok is
 * an estimate. These are fixed: the guard does not learn the ratio from
 * reports. Override per provider with the tokens-per-percent setting.
 */
export const DEFAULT_TOKENS_PER_PERCENT_BY_DRIVER: Readonly<Record<string, number>> = {
  claudeAgent: 2_000_000,
  codex: 4_500_000,
  grok: 2_000_000,
  antigravity: 2_000_000,
};
export const FALLBACK_TOKENS_PER_PERCENT = 1_000_000;

/** Burn-rate samples are taken over at least this long, so a single call's burst is not a pace. */
export const BURN_SAMPLE_MIN_MS = 10 * 60_000;
export const BURN_ALPHA = 0.3;
/** Token-based pace looks back this far, and never divides by less than it. */
export const TOKEN_PACE_WINDOW_MS = 30 * 60_000;
/**
 * How far a window must climb before its spend teaches us anything.
 *
 * Providers report utilization to two decimals, so a reported percent is
 * quantized to whole points and each endpoint carries up to half a point of
 * rounding. Five points holds that error under ~20% per sample, which the
 * EWMA then smooths.
 */
export const MIN_CALIBRATION_CLIMB_PERCENT = 5;
/**
 * The first sample settles for less.
 *
 * A window with no measurement at all is running on the driver default, and
 * any measurement beats a guess that can be orders of magnitude out. Later
 * samples wait for the full climb and the EWMA pulls the first one in.
 */
export const FIRST_CALIBRATION_CLIMB_PERCENT = 2;
/**
 * Deliberately asymmetric: a measurement that makes turns look more expensive
 * is resisted, one that makes them look cheaper is taken quickly.
 *
 * Every way this measurement can go wrong pushes it the same direction. The
 * account climbs on spend from everywhere — another Claude Code in a terminal,
 * another machine — while our meter only sees this app, so a window can jump
 * with almost nothing recorded against it and the division comes out far too
 * small. Too small means turns look enormous, which is the over-holding bug
 * this whole mechanism exists to end. Too large only means the guard declines
 * to hold and the provider raises its own error, which is recoverable.
 */
export const CALIBRATION_RISE_ALPHA = 0.6;
export const CALIBRATION_FALL_ALPHA = 0.1;

/**
 * Upper rail on one measurement, wide enough to fit any plan; it only rejects blowups.
 *
 * The LOWER rail is the driver default, which is why there is no constant for it: a
 * measurement saying a point costs less than the platform's own floor means our meter
 * missed spend the account actually made, which is exactly what a Claude Code running
 * outside this app produces. Rejecting those keeps the learned ratio at or above the
 * value the guard would have used anyway, so switching to it can never hold MORE work
 * than the old fixed constant did — only less.
 */
export const MAX_LEARNED_TOKENS_PER_PERCENT = 100_000_000_000;
/** Raw tokens one turn is assumed to cost before the model has been observed. */
export const DEFAULT_TURN_TOKENS = 150_000;
export const TURN_COST_ALPHA = 0.3;
// Deep enough that a rolling token cap measured over hours is not undercounted
// by samples having fallen off the end.
const MAX_CALL_SAMPLES = 1_024;
/** Reports whose reset time moved by less than this belong to the same window. */
const SAME_WINDOW_RESET_TOLERANCE_MS = 15 * 60_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * How much of the quota one token costs relative to the driver's baseline
 * model. Fixed ratios from first-party list prices on the input side (the
 * full context of every call is input), audited 2026-09-06:
 *
 * Claude (baseline Sonnet 5 at $2/MTok input): Fable 5.1 and Mythos 5.1 $10,
 * Opus 5 / 4.8 / 4.7 $5, Sonnet 4.6 / 4.5 $3, Haiku 4.5 $1.
 *   Source: https://platform.claude.com/docs/en/about-claude/pricing
 *
 * Codex (baseline GPT-6 Astra at 250 credits/MTok input): Daybreak Red 312.5,
 * GPT-5.5 125, GPT-5.6 Sol and Daybreak Blue 100, GPT-5.4 62.5, GPT-5.6 Terra
 * 50, GPT-5.4 mini 18.75, GPT-5.6 Luna 5. Codex-Spark has its own limit and no
 * published rate, so it stays at the baseline.
 *   Source: https://learn.chatgpt.com/docs/pricing#token-rates
 *
 * Grok (baseline Grok 4.6 at $2/MTok input): Grok 4.5 $2, Grok 4.3 and the
 * 4.20 family $1.25, Grok Build $1. The retired Fast and Mini tiers route to
 * Grok 4.3 and are priced as it.
 *   Source: https://docs.x.ai (via xAI pricing trackers, September 2026)
 *
 * Antigravity reports remaining-percent family windows, not token prices.
 * Until a measured tokens-per-percent exists, the Grok estimate is the
 * starting ratio and every native model stays at multiplier 1.
 *
 * These ratios are not learned or adjusted at runtime. The base
 * tokens-per-percent ratio is the driver default or the configured value.
 */
const MODEL_COST_MULTIPLIERS: Readonly<Record<string, ReadonlyArray<readonly [RegExp, number]>>> = {
  claudeAgent: [
    [/fable|mythos/i, 5],
    [/opus/i, 2.5],
    [/sonnet-4/i, 1.5],
    [/sonnet/i, 1],
    [/haiku/i, 0.5],
  ],
  codex: [
    [/daybreak[-_ ]?red/i, 1.25],
    [/astra/i, 1],
    [/gpt-5\.5/i, 0.5],
    [/sol|daybreak[-_ ]?blue/i, 0.4],
    [/mini/i, 0.075],
    [/nano/i, 0.02],
    [/gpt-5\.4/i, 0.25],
    [/terra/i, 0.2],
    [/luna/i, 0.02],
  ],
  grok: [
    [/grok-?4[.-]?6/i, 1],
    [/grok-?4[.-]?5/i, 1],
    [/build/i, 0.5],
    [/grok-?4[.-]?3|grok-?4[.-]?20|fast|mini|grok-?3/i, 0.625],
  ],
};

export function modelCostMultiplier(driver: string, model: string | null | undefined): number {
  if (!model) return 1;
  for (const [pattern, multiplier] of MODEL_COST_MULTIPLIERS[driver] ?? []) {
    if (pattern.test(model)) return multiplier;
  }
  return 1;
}

/** Longest-first so `claude-opus-4-5` cannot match a shorter family. */
const CLAUDE_MODEL_FAMILIES = ["mythos", "sonnet", "haiku", "fable", "opus"] as const;

/** The family a model belongs to for per-family windows; null for drivers without them. */
export function modelFamily(driver: string, model: string | null | undefined): string | null {
  if (driver === "antigravity") return antigravityUsageModelFamily(model);
  if (driver !== "claudeAgent" || !model) return null;
  const normalized = model.toLowerCase();
  return CLAUDE_MODEL_FAMILIES.find((family) => normalized.includes(family)) ?? null;
}

export type UsageWindowScope = "account" | "model-family" | "extra-usage";

export interface UsageWindowSample {
  readonly key: string;
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsAtMs: number | null;
  readonly windowDurationMs: number | null;
  readonly scope: UsageWindowScope;
  /** Model family a `model-family` window binds; null otherwise. */
  readonly family: string | null;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function epochMilliseconds(value: unknown): number | null {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const numeric = finiteNumber(value);
  if (numeric === null || numeric <= 0) return null;
  return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
}

function durationLabel(durationMinutes: number | null, fallback: string): string {
  if (durationMinutes === null) return fallback;
  if (durationMinutes >= 9_000 && durationMinutes <= 11_000) return "weekly";
  if (durationMinutes >= 270 && durationMinutes <= 330) return "5 hour";
  if (durationMinutes % 1_440 === 0) return `${durationMinutes / 1_440} day`;
  if (durationMinutes % 60 === 0) return `${durationMinutes / 60} hour`;
  return `${durationMinutes} min`;
}

function codexWindows(raw: unknown): UsageWindowSample[] {
  const envelope = asRecord(raw);
  const snapshot = asRecord(envelope?.rateLimits) ?? envelope;
  if (!snapshot) return [];
  const windows: UsageWindowSample[] = [];
  for (const [key, fallback] of [
    ["primary", "primary"],
    ["secondary", "secondary"],
  ] as const) {
    const value = asRecord(snapshot[key]);
    const usedPercent = finiteNumber(value?.usedPercent);
    if (!value || usedPercent === null) continue;
    const durationMinutes = finiteNumber(value.windowDurationMins);
    // Codex retired its five-hour limit; stale payloads may still carry it.
    if (durationMinutes !== null && durationMinutes >= 270 && durationMinutes <= 330) continue;
    const weekly =
      durationMinutes !== null && durationMinutes >= 9_000 && durationMinutes <= 11_000;
    windows.push({
      key: weekly ? "weekly" : key,
      label: durationLabel(durationMinutes, fallback),
      usedPercent: clampPercent(usedPercent),
      resetsAtMs: epochMilliseconds(value.resetsAt),
      windowDurationMs: durationMinutes === null ? null : durationMinutes * MINUTE_MS,
      scope: "account",
      family: null,
    });
  }
  return windows;
}

const CLAUDE_WINDOW_DURATIONS_MS: Readonly<Record<string, number>> = {
  five_hour: 5 * 60 * MINUTE_MS,
  current_session: 5 * 60 * MINUTE_MS,
  seven_day: 7 * DAY_MS,
  seven_day_overage_included: 7 * DAY_MS,
  seven_day_oauth_apps: 7 * DAY_MS,
  one_day: DAY_MS,
  daily: DAY_MS,
  weekly: 7 * DAY_MS,
};

function normalizeClaudeWindowKey(key: string): string {
  return key
    .trim()
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .replaceAll(/[\s-]+/g, "_")
    .toLowerCase();
}

/** Windows keyed by a model family are weekly; the key itself never says so. */
function claudeWindowDurationMs(key: string): number | null {
  const known = CLAUDE_WINDOW_DURATIONS_MS[key];
  if (known !== undefined) return known;
  return claudeWindowScope(key).scope === "model-family" ? 7 * DAY_MS : null;
}

/**
 * A model-scoped limit named by display name ("Fable") rather than by key.
 * Claude's `/usage` reports these through the `model_scoped` and `limits`
 * arrays, which is the ONLY place the Fable window appears for a plan on that
 * tier - the typed `seven_day_fable` key is absent there. Keyed the same way
 * the typed event would key it, so calibration learned from one source
 * carries over to the other.
 */
function claudeFamilyWindow(input: {
  readonly displayName: unknown;
  readonly percent: number | null;
  readonly resetsAt: unknown;
}): UsageWindowSample | null {
  const name = typeof input.displayName === "string" ? input.displayName.toLowerCase() : null;
  if (name === null || input.percent === null) return null;
  const family = CLAUDE_MODEL_FAMILIES.find((candidate) => name.includes(candidate)) ?? null;
  if (family === null) return null;
  const key = `seven_day_${family}`;
  return {
    key,
    label: claudeWindowLabel(key),
    usedPercent: clampPercent(input.percent),
    resetsAtMs: epochMilliseconds(input.resetsAt),
    windowDurationMs: claudeWindowDurationMs(key),
    scope: "model-family",
    family,
  };
}

function claudeWindowScope(key: string): { scope: UsageWindowScope; family: string | null } {
  if (key.includes("extra") || key.includes("overage") || key.includes("credit")) {
    return { scope: "extra-usage", family: null };
  }
  const family = CLAUDE_MODEL_FAMILIES.find((candidate) => key.includes(candidate)) ?? null;
  return family === null ? { scope: "account", family: null } : { scope: "model-family", family };
}

function claudeWindowLabel(key: string): string {
  switch (key) {
    case "five_hour":
    case "current_session":
      return "5 hour";
    case "seven_day":
      return "weekly";
    case "seven_day_overage_included":
      return "extra usage (weekly)";
    default: {
      const { scope, family } = claudeWindowScope(key);
      if (scope === "model-family" && family !== null) {
        return `${family[0]!.toUpperCase()}${family.slice(1)} weekly`;
      }
      return key.replaceAll("_", " ");
    }
  }
}

/** Claude reports fractions (0.54) in typed events and percents in `/usage`. */
function claudePercent(value: number): number {
  return clampPercent(value <= 1 ? value * 100 : value);
}

/**
 * Whether we can say what a Claude window actually governs.
 *
 * An unrecognised key falls through `claudeWindowScope` to account scope, which
 * attaches it to EVERY model. That is how `nimbus_quill` — a model id this build
 * has never heard of — came to govern Opus turns, show up under every entry in
 * the model comparison, and pace 0%-used work to a turn every 23 minutes. A
 * window we cannot identify is not one we can reason about: drop it and let the
 * account windows, which we do understand, speak for the account.
 */
function isRecognizedClaudeWindowKey(key: string): boolean {
  if (CLAUDE_WINDOW_DURATIONS_MS[key] !== undefined) return true;
  if (key.includes("extra") || key.includes("overage") || key.includes("credit")) return true;
  return CLAUDE_MODEL_FAMILIES.some((family) => key.includes(family));
}

function claudeWindows(raw: unknown): UsageWindowSample[] {
  const envelope = asRecord(raw);
  if (!envelope) return [];
  const windows: UsageWindowSample[] = [];
  const info = asRecord(envelope.rate_limit_info);
  const unified = asRecord(info?.unifiedWindows);
  if (unified) {
    for (const [rawKey, rawWindow] of Object.entries(unified)) {
      const window = asRecord(rawWindow);
      const utilization = finiteNumber(window?.utilization);
      if (!window || utilization === null) continue;
      const key = normalizeClaudeWindowKey(rawKey);
      if (!isRecognizedClaudeWindowKey(key)) continue;
      windows.push({
        key,
        label: claudeWindowLabel(key),
        usedPercent: claudePercent(utilization),
        resetsAtMs: epochMilliseconds(window.resetsAt ?? window.resets_at),
        windowDurationMs: claudeWindowDurationMs(key),
        ...claudeWindowScope(key),
      });
    }
    if (windows.length > 0) return windows;
  }
  if (info) {
    const key =
      typeof info.rateLimitType === "string" ? normalizeClaudeWindowKey(info.rateLimitType) : null;
    const utilization = finiteNumber(info.utilization);
    const rejected = info.status === "rejected";
    if (key && isRecognizedClaudeWindowKey(key) && (utilization !== null || rejected)) {
      windows.push({
        key,
        label: claudeWindowLabel(key),
        usedPercent: utilization === null ? 100 : claudePercent(utilization),
        resetsAtMs: epochMilliseconds(info.resetsAt ?? info.overageResetsAt),
        windowDurationMs: claudeWindowDurationMs(key),
        ...claudeWindowScope(key),
      });
      return windows;
    }
  }
  const structured = asRecord(envelope.rate_limits);
  if (structured) {
    for (const [rawKey, rawWindow] of Object.entries(structured)) {
      const window = asRecord(rawWindow);
      if (!window) continue;
      const utilization = finiteNumber(window.utilization);
      const rejected = window.status === "rejected";
      if (utilization === null && !rejected) continue;
      const key = normalizeClaudeWindowKey(rawKey);
      if (!isRecognizedClaudeWindowKey(key)) continue;
      windows.push({
        key,
        label: claudeWindowLabel(key),
        usedPercent: utilization === null ? 100 : clampPercent(utilization),
        resetsAtMs: epochMilliseconds(window.resets_at ?? window.resetsAt),
        windowDurationMs: claudeWindowDurationMs(key),
        ...claudeWindowScope(key),
      });
    }
    const hasFamily = (family: string | null) =>
      family !== null && windows.some((entry) => entry.family === family);
    // `model_scoped: [{ display_name: "Fable", utilization: 99, resets_at }]`
    if (Array.isArray(structured.model_scoped)) {
      for (const raw of structured.model_scoped) {
        const entry = asRecord(raw);
        const sample = claudeFamilyWindow({
          displayName: entry?.display_name,
          percent: finiteNumber(entry?.utilization),
          resetsAt: entry?.resets_at ?? entry?.resetsAt,
        });
        if (sample !== null && !hasFamily(sample.family)) windows.push(sample);
      }
    }
    // `limits: [{ kind: "weekly_scoped", percent: 99, scope: { model: { display_name } } }]`
    if (Array.isArray(structured.limits)) {
      for (const raw of structured.limits) {
        const entry = asRecord(raw);
        const model = asRecord(asRecord(entry?.scope)?.model);
        const sample = claudeFamilyWindow({
          displayName: model?.display_name,
          percent: finiteNumber(entry?.percent),
          resetsAt: entry?.resets_at ?? entry?.resetsAt,
        });
        if (sample !== null && !hasFamily(sample.family)) windows.push(sample);
      }
    }
  }
  return windows;
}

function antigravityWindows(raw: unknown): UsageWindowSample[] {
  return antigravityUsageWindowsFromAccountUsage(raw).map((window) => ({
    key: window.key,
    label: window.label,
    usedPercent: window.usedPercent,
    resetsAtMs: window.resetsAt === null ? null : Date.parse(window.resetsAt),
    windowDurationMs: window.windowDurationMs,
    scope: "model-family",
    family: window.family,
  }));
}

function grokWindows(raw: unknown): UsageWindowSample[] {
  const envelope = asRecord(raw);
  if (!envelope) return [];
  const config = asRecord(envelope.config) ?? envelope;
  const period = asRecord(config.currentPeriod);
  const reported = finiteNumber(config.creditUsagePercent);
  const usedPercent = reported ?? (period === null ? null : 0);
  if (usedPercent === null) return [];
  const start = epochMilliseconds(period?.start);
  const end =
    epochMilliseconds(period?.end) ??
    epochMilliseconds(config.billingPeriodEnd) ??
    epochMilliseconds(config.billingPeriodStart);
  const durationMs = start !== null && end !== null && end > start ? end - start : 7 * DAY_MS;
  return [
    {
      key: "weekly",
      label: durationMs >= 27 * DAY_MS ? "monthly" : "weekly",
      usedPercent: clampPercent(usedPercent),
      resetsAtMs: end,
      windowDurationMs: durationMs,
      scope: "account",
      family: null,
    },
  ];
}

/**
 * Every metered window a provider's account-usage payload describes, with
 * used percent and reset time. Empty for drivers that report no usage, which
 * the guard treats as "nothing to guard".
 */
export function extractUsageWindows(driver: string, rateLimits: unknown): UsageWindowSample[] {
  switch (driver) {
    case "codex":
      return codexWindows(rateLimits);
    case "claudeAgent":
      return claudeWindows(rateLimits);
    case "grok":
      return grokWindows(rateLimits);
    case "antigravity":
      return antigravityWindows(rateLimits);
    default:
      return [];
  }
}

export function defaultTokensPerPercent(driver: string): number {
  return DEFAULT_TOKENS_PER_PERCENT_BY_DRIVER[driver] ?? FALLBACK_TOKENS_PER_PERCENT;
}

/**
 * Points of a window one million tokens costs on `model` — the whole per-model
 * cost model, as a fixed constant. Nothing is learned or extrapolated here, so
 * the savings between two model options is just the difference of two numbers.
 */
export function modelPercentPerMillionTokens(
  driver: string,
  model: string | null | undefined,
): number {
  return (1_000_000 * modelCostMultiplier(driver, model)) / defaultTokensPerPercent(driver);
}

export interface UsageGuardCallSample {
  readonly atMs: number;
  /** Raw tokens × the model's cost multiplier. */
  readonly weightedTokens: number;
  readonly fast?: boolean;
  readonly model: string | null;
}

export interface UsageGuardWindowState {
  readonly key: string;
  readonly label: string;
  readonly scope: UsageWindowScope;
  readonly family: string | null;
  readonly reportedPercent: number;
  readonly reportedAtMs: number;
  readonly resetsAtMs: number | null;
  readonly windowDurationMs: number | null;
  /** Instance weighted-token counter when the report arrived. */
  readonly tokensAtReport: number;
  readonly anchorPercent: number | null;
  readonly anchorTokens: number | null;
  readonly learnedTokensPerPercent: number | null;
  readonly calibrationSamples: number;
  /** Smoothed points-per-hour from the provider's own reports; null until two are far enough apart. */
  readonly burnPercentPerHour: number | null;
  readonly burnAnchorPercent: number | null;
  readonly burnAnchorAtMs: number | null;
}

export interface UsageGuardTurnCost {
  readonly ewmaWeightedTokens: number;
  readonly samples: number;
}

export interface UsageGuardInstanceState {
  readonly credits?: UsageGuardCredits | null;
  readonly creditLedger?: CreditLedger;
  readonly driver: string;
  /** Monotonic weighted-token count observed for this instance since the process started. */
  readonly tokensTotal: number;
  readonly windows: Readonly<Record<string, UsageGuardWindowState>>;
  readonly updatedAtMs: number;
  /** Most recent calls, newest last, for the token-based pace. */
  readonly calls: ReadonlyArray<UsageGuardCallSample>;
  /**
   * What one call on each model has been costing, in weighted tokens; `*` is
   * the all-model average in *raw* tokens so it can be re-weighted for a
   * model that has not been observed yet.
   */
  readonly turnCostByModel: Readonly<Record<string, UsageGuardTurnCost>>;
  readonly costByEffort?: Readonly<
    Record<string, UsageGuardTurnCost & { readonly credits: number | null }>
  >;
  /**
   * Threads that were busy while the burn was being observed. The pace is a
   * trailing average, so dividing it by the *current* thread count would make
   * the survivors look more expensive the moment a thread finished, and shrink
   * the budget exactly when room opened up.
   */
  readonly activeThreadsEwma: number | null;
  /**
   * When background work last went out under the pace cooldown. The thread
   * budget says how many threads the window can carry; once it says none,
   * this is what turns "hold until the reset" into a trickle at the rate the
   * window can afford.
   */
  readonly lastBackgroundAdmitAtMs: number | null;
  readonly processedByThread?: Readonly<Record<string, number>>;
  readonly tokensAtAdmission?: number;
  readonly creditsAtAdmission?: number;
  readonly dailyCredits?: { readonly startsAt: number; readonly spent: number };
}

export const ACTIVE_THREADS_ALPHA = 0.2;

export function emptyUsageGuardInstanceState(driver: string): UsageGuardInstanceState {
  return {
    driver,
    tokensTotal: 0,
    windows: {},
    updatedAtMs: 0,
    calls: [],
    turnCostByModel: {},
    activeThreadsEwma: null,
    lastBackgroundAdmitAtMs: null,
  };
}

/**
 * A window that exists only to carry a measured ratio back from disk.
 *
 * Everything else is placeholder and is replaced wholesale by the first real
 * report; `recordWindowsIntoState` reads the learned fields off `previous`, so
 * they survive that replacement.
 */
export function emptyUsageGuardWindowState(key: string): UsageGuardWindowState {
  return {
    key,
    label: key,
    scope: "account",
    family: null,
    reportedPercent: 0,
    reportedAtMs: 0,
    resetsAtMs: null,
    windowDurationMs: null,
    tokensAtReport: 0,
    anchorPercent: null,
    anchorTokens: null,
    learnedTokensPerPercent: null,
    calibrationSamples: 0,
    burnPercentPerHour: null,
    burnAnchorPercent: null,
    burnAnchorAtMs: null,
  };
}

export function recordUsageGuardCredits(
  state: UsageGuardInstanceState,
  raw: unknown,
): UsageGuardInstanceState {
  if (state.driver !== "codex") return state;
  return {
    ...state,
    credits: readCodexCredits(raw, state.creditLedger?.spent ?? 0, state.credits),
  };
}

export function recordBackgroundAdmission(
  state: UsageGuardInstanceState,
  nowMs: number,
): UsageGuardInstanceState {
  return {
    ...state,
    lastBackgroundAdmitAtMs: nowMs,
    tokensAtAdmission: state.tokensTotal,
    creditsAtAdmission: state.creditLedger?.spent ?? 0,
  };
}

function ewma(previous: number | null, observed: number, alpha: number): number {
  return previous === null ? observed : previous * (1 - alpha) + observed * alpha;
}

function bumpTurnCost(
  table: Readonly<Record<string, UsageGuardTurnCost>>,
  key: string,
  weightedTokens: number,
): Record<string, UsageGuardTurnCost> {
  const previous = table[key];
  return {
    ...table,
    [key]: {
      ewmaWeightedTokens: ewma(
        previous?.ewmaWeightedTokens ?? null,
        weightedTokens,
        TURN_COST_ALPHA,
      ),
      samples: (previous?.samples ?? 0) + 1,
    },
  };
}

export function recordTokensIntoState(
  state: UsageGuardInstanceState,
  input: {
    readonly tokens: number;
    readonly model: string | null;
    readonly nowMs: number;
    /** Threads busy on this instance when the call ran. */
    readonly activeThreads?: number;
    readonly usage?: ThreadTokenUsageSnapshot | undefined;
    readonly threadKey?: string | undefined;
    readonly fast?: boolean | undefined;
    readonly effort?: string | undefined;
  },
): UsageGuardInstanceState {
  if (!Number.isFinite(input.tokens) || input.tokens <= 0) return state;
  const processed = input.usage?.totalProcessedTokens;
  const previousProcessed =
    input.threadKey === undefined ? undefined : state.processedByThread?.[input.threadKey];
  const measuredTokens =
    processed !== undefined && previousProcessed !== undefined && processed >= previousProcessed
      ? processed - previousProcessed
      : input.tokens;
  if (measuredTokens <= 0) return state;
  const weighted = Math.round(measuredTokens * modelCostMultiplier(state.driver, input.model));
  const calls = [
    ...state.calls,
    { atMs: input.nowMs, weightedTokens: weighted, model: input.model, fast: input.fast ?? false },
  ];
  let turnCostByModel = bumpTurnCost(state.turnCostByModel, "*", measuredTokens);
  if (input.model !== null) turnCostByModel = bumpTurnCost(turnCostByModel, input.model, weighted);
  const creditLedger =
    state.driver === "codex" && input.usage && input.threadKey
      ? recordCreditTokens(state.creditLedger ?? emptyCreditLedger(), {
          usage: input.usage,
          threadKey: input.threadKey,
          model: input.model,
          nowMs: input.nowMs,
          fast: input.fast,
        })
      : (state.creditLedger ?? emptyCreditLedger());
  const costByEffort = { ...state.costByEffort };
  if (input.model && input.effort) {
    const key = effortCostKey(input.model, input.effort, input.fast ?? false);
    const previous = costByEffort[key];
    const spentCredits = creditLedger.spent - (state.creditLedger?.spent ?? 0);
    costByEffort[key] = {
      ewmaWeightedTokens: ewma(previous?.ewmaWeightedTokens ?? null, weighted, TURN_COST_ALPHA),
      samples: (previous?.samples ?? 0) + 1,
      credits:
        spentCredits > 0
          ? ewma(previous?.credits ?? null, spentCredits, TURN_COST_ALPHA)
          : (previous?.credits ?? null),
    };
  }
  const paidUsageActive = Object.values(state.windows).some(
    (window) =>
      window.scope === "account" &&
      window.reportedPercent >= 100 &&
      (window.resetsAtMs === null || window.resetsAtMs > input.nowMs),
  );
  // Included-quota calls teach the model's cost but do not consume paid credits.
  const credits =
    state.credits && !paidUsageActive
      ? {
          ...state.credits,
          spentAtReport:
            state.credits.spentAtReport + creditLedger.spent - (state.creditLedger?.spent ?? 0),
        }
      : (state.credits ?? null);
  const day = creditBudgetDay(input.nowMs);
  const dailyCredits = {
    startsAt: day.startsAt,
    spent:
      (state.dailyCredits?.startsAt === day.startsAt ? state.dailyCredits.spent : 0) +
      (paidUsageActive ? Math.max(0, creditLedger.spent - (state.creditLedger?.spent ?? 0)) : 0),
  };
  return {
    ...state,
    dailyCredits,
    creditLedger,
    credits,
    costByEffort: Object.fromEntries(Object.entries(costByEffort).slice(-256)),
    tokensTotal: state.tokensTotal + weighted,
    processedByThread:
      processed === undefined || input.threadKey === undefined
        ? (state.processedByThread ?? {})
        : Object.fromEntries([
            ...Object.entries(state.processedByThread ?? {})
              .filter(([key]) => key !== input.threadKey)
              .slice(-511),
            [input.threadKey, processed],
          ]),
    updatedAtMs: input.nowMs,
    calls: calls.length > MAX_CALL_SAMPLES ? calls.slice(calls.length - MAX_CALL_SAMPLES) : calls,
    turnCostByModel,
    activeThreadsEwma:
      input.activeThreads === undefined
        ? state.activeThreadsEwma
        : ewma(state.activeThreadsEwma, Math.max(1, input.activeThreads), ACTIVE_THREADS_ALPHA),
  };
}

function sameWindow(previous: UsageGuardWindowState, sample: UsageWindowSample): boolean {
  if (previous.resetsAtMs === null || sample.resetsAtMs === null) {
    return previous.resetsAtMs === sample.resetsAtMs;
  }
  return Math.abs(previous.resetsAtMs - sample.resetsAtMs) <= SAME_WINDOW_RESET_TOLERANCE_MS;
}

/**
 * Fold one account-usage report into the instance state.
 *
 * The burn rate takes a sample whenever at least `BURN_SAMPLE_MIN_MS` has
 * passed since its anchor: the climb over that span in points per hour,
 * smoothed. Idle spans sample as zero, so a pace decays once work stops.
 * Reports that arrive every call would otherwise turn one big call into a
 * fictitious 50%-an-hour pace.
 */
export function recordWindowsIntoState(
  state: UsageGuardInstanceState,
  samples: ReadonlyArray<UsageWindowSample>,
  nowMs: number,
): UsageGuardInstanceState {
  if (samples.length === 0) return state;
  const windows: Record<string, UsageGuardWindowState> = { ...state.windows };
  for (const sample of samples) {
    const previous = windows[sample.key];
    let burn = previous?.burnPercentPerHour ?? null;
    let burnAnchorPercent: number | null = sample.usedPercent;
    let burnAnchorAtMs: number | null = nowMs;
    const continues =
      previous !== undefined &&
      sameWindow(previous, sample) &&
      sample.usedPercent >= previous.reportedPercent;
    if (continues && previous.burnAnchorPercent !== null && previous.burnAnchorAtMs !== null) {
      const spanMs = nowMs - previous.burnAnchorAtMs;
      if (spanMs < BURN_SAMPLE_MIN_MS) {
        burnAnchorPercent = previous.burnAnchorPercent;
        burnAnchorAtMs = previous.burnAnchorAtMs;
      } else {
        const climb = Math.max(0, sample.usedPercent - previous.burnAnchorPercent);
        burn = ewma(burn, climb / (spanMs / HOUR_MS), BURN_ALPHA);
      }
    } else if (!continues) {
      // A new window (or a reset) starts a fresh pace.
      burn = null;
    }
    // What a point of THIS window costs, measured against the provider's own
    // reports. Only the account-wide scale is measured; the per-model cost
    // multipliers stay fixed constants, so the savings between two models is
    // still just the difference of two numbers.
    //
    // A fixed absolute scale cannot be right, because it is the plan's token
    // allowance and that varies per account. The shipped guess for Claude was
    // 2,000,000 weighted tokens per point; measured against 2,833 turns spent
    // to reach 66% of a weekly window (2026-09-07) the truth was ~380x larger,
    // and the guard priced a turn at 8.92% of the week. It held the user's own
    // queued messages behind a reserve that arithmetic could never free.
    //
    // Counting bias cancels here: if the token meter runs hot — Claude's
    // cache reads are counted at face value, which on a long session is most
    // of the number — the learned ratio absorbs it and the turn cost still
    // comes out right.
    let learnedTokensPerPercent = previous?.learnedTokensPerPercent ?? null;
    let calibrationSamples = previous?.calibrationSamples ?? 0;
    let anchorPercent = continues ? (previous?.anchorPercent ?? null) : null;
    let anchorTokens = continues ? (previous?.anchorTokens ?? null) : null;
    if (anchorPercent === null || anchorTokens === null) {
      anchorPercent = sample.usedPercent;
      anchorTokens = state.tokensTotal;
    } else {
      const climb = sample.usedPercent - anchorPercent;
      const spend = state.tokensTotal - anchorTokens;
      const minClimb =
        learnedTokensPerPercent === null
          ? FIRST_CALIBRATION_CLIMB_PERCENT
          : MIN_CALIBRATION_CLIMB_PERCENT;
      if (climb >= minClimb && spend > 0) {
        const observed = spend / climb;
        if (
          Number.isFinite(observed) &&
          observed >= defaultTokensPerPercent(state.driver) &&
          observed <= MAX_LEARNED_TOKENS_PER_PERCENT
        ) {
          const alpha =
            observed > (learnedTokensPerPercent ?? 0)
              ? // Also averages rather than decays over the first few, so a
                // noisy first reading — taken at a 2-point climb, where the
                // provider's rounding is worth the most — does not linger.
                Math.max(CALIBRATION_RISE_ALPHA, 1 / (calibrationSamples + 1))
              : CALIBRATION_FALL_ALPHA;
          learnedTokensPerPercent = ewma(learnedTokensPerPercent, observed, alpha);
          calibrationSamples += 1;
        }
        anchorPercent = sample.usedPercent;
        anchorTokens = state.tokensTotal;
      }
    }
    windows[sample.key] = {
      key: sample.key,
      label: sample.label,
      scope: sample.scope,
      family: sample.family,
      reportedPercent: sample.usedPercent,
      reportedAtMs: nowMs,
      resetsAtMs: sample.resetsAtMs,
      windowDurationMs: sample.windowDurationMs,
      tokensAtReport: state.tokensTotal,
      anchorPercent,
      anchorTokens,
      learnedTokensPerPercent,
      calibrationSamples,
      burnPercentPerHour: burn,
      burnAnchorPercent,
      burnAnchorAtMs,
    };
  }
  return { ...state, windows, updatedAtMs: nowMs };
}

export interface UsageGuardResolvedConfig extends UsageGuardProviderSettings {
  /** The global switch and this provider's own switch are both on. */
  readonly active: boolean;
}

export function resolveUsageGuardProviderConfig(
  settings: Pick<ServerSettings, "usageGuard">,
  instanceId: ProviderInstanceId | string,
): UsageGuardResolvedConfig {
  const guard = settings.usageGuard;
  // Settings patches merge field-by-field, so a provider entry written by an
  // older client can be partial. Defaults fill the gaps.
  const provider = {
    ...DEFAULT_USAGE_GUARD_PROVIDER_SETTINGS,
    ...guard.providers[instanceId as ProviderInstanceId],
  };
  return { ...provider, active: guard.enabled && provider.enabled };
}

export type UsageGuardTier = "none" | "optimize" | "extra-usage" | "pause";
export type UsageGuardEffortTarget = "medium" | "low";

export interface UsageGuardWindowEstimate {
  readonly key: string;
  readonly label: string;
  readonly scope: UsageWindowScope;
  readonly family: string | null;
  readonly reportedPercent: number;
  readonly estimatedPercent: number;
  readonly resetsAtMs: number | null;
  readonly expired: boolean;
  /** Whether this window binds the model being evaluated. */
  readonly applicable: boolean;
  readonly hoursLeft: number;
  readonly burnPercentPerHour: number;
  readonly projectedAtResetPercent: number;
  /**
   * How far through the window the clock is — the "time bar". Null when the
   * window's duration is unknown, which is the only case that still falls back
   * to burn-rate extrapolation.
   */
  readonly elapsedPercent: number | null;
  /** Points the usage bar sits ahead of the time bar; negative is under pace. */
  readonly aheadOfPacePercent: number | null;
  /** The window's full length, when known. */
  readonly windowDurationMs: number | null;
  /** Points left below 100 minus headroom. */
  readonly remainingPercent: number;
  /** Burn × hours left ÷ remaining: 1 is exactly on pace, above 1 overruns. */
  readonly pressure: number;
}

export interface UsageGuardEvaluation {
  readonly tier: UsageGuardTier;
  readonly observedTokens?: number;
  readonly summary: string;
  readonly windowKey: string | null;
  readonly windowLabel: string | null;
  readonly windowScope: UsageWindowScope | null;
  readonly reportedPercent: number | null;
  readonly estimatedPercent: number | null;
  /** How far through the governing window the clock is — the time bar. */
  readonly elapsedPercent: number | null;
  /** Points the usage bar sits ahead of the time bar; negative is under pace. */
  readonly aheadOfPacePercent: number | null;
  readonly resetsAtMs: number | null;
  readonly burnPercentPerHour: number | null;
  readonly projectedAtResetPercent: number | null;
  readonly turnCostPercent: number | null;
  readonly remainingPercent: number | null;
  readonly headroomPercent: number;
  readonly pressure: number;
  readonly effortTarget: UsageGuardEffortTarget | null;
  /** Threads the pace budget can carry at once; null when the pace is fine. */
  readonly backgroundBudget: number | null;
  readonly activeThreads: number;
  /** Whether one more piece of background work may start right now. */
  readonly admitBackground: boolean;
  /**
   * Account-wide spacing charged to the greater of the next call estimate
   * and all actual consumption since admission. Null while pacing is off.
   */
  readonly backgroundCooldownMs: number | null;
  /** When the cooldown next lets background work through; null when it is not the gate. */
  readonly nextBackgroundAdmitAtMs: number | null;
  readonly tokensPerPercent: number;
  /** Points one million tokens costs on the evaluated model. */
  readonly percentPerMillionTokens: number;
  /** Weighted tokens spent inside the person's own cap window, when one is set. */
  readonly tokenCapSpent: number | null;
  readonly tokensPerPercentSource: "configured" | "learned" | "default";
  readonly learnedTokensPerPercent: number | null;
  readonly tokensSinceReport: number;
  readonly model: string | null;
  readonly windows: ReadonlyArray<UsageGuardWindowEstimate>;
}

function effectiveTokensPerPercent(
  config: UsageGuardProviderSettings,
  driver: string,
  window: UsageGuardWindowState | undefined,
): { readonly value: number; readonly source: UsageGuardEvaluation["tokensPerPercentSource"] } {
  if (config.tokensPerPercent !== null) {
    return { value: config.tokensPerPercent, source: "configured" };
  }
  // What a point of this window costs is the plan's allowance, so it is
  // measured per window rather than guessed. `MODEL_COST_MULTIPLIERS` stays
  // fixed — this is the account's scale, not a model's relative price.
  const learned = config.autoCalibrate ? (window?.learnedTokensPerPercent ?? null) : null;
  // One measurement is enough. It is floored at the driver default, so it is never
  // a worse answer than the constant it replaces, and the constant is what produced
  // "weekly is at ~94%" fifteen seconds after Claude reported 66% — an inflated
  // estimate holds work all by itself, whatever the turn cost is believed to be.
  if (learned !== null && (window?.calibrationSamples ?? 0) > 0 && learned > 0) {
    return { value: learned, source: "learned" };
  }
  return { value: defaultTokensPerPercent(driver), source: "default" };
}

/** Weighted tokens recorded at or after `sinceMs`, from the per-call history. */
function weightedTokensSince(state: UsageGuardInstanceState, sinceMs: number): number {
  let spent = 0;
  for (const call of state.calls) if (call.atMs >= sinceMs) spent += call.weightedTokens;
  return spent;
}

/** When the rolling cap window frees up: the oldest call in it aging out. */
function oldestCallAtMs(state: UsageGuardInstanceState, sinceMs: number): number | null {
  let oldest: number | null = null;
  for (const call of state.calls) {
    if (call.atMs < sinceMs) continue;
    if (oldest === null || call.atMs < oldest) oldest = call.atMs;
  }
  return oldest;
}

/** Weighted tokens per hour over the recent calls, as a floor under the reported pace. */
function tokenPacePerHour(state: UsageGuardInstanceState, nowMs: number): number {
  return (
    weightedTokensSince(state, nowMs - TOKEN_PACE_WINDOW_MS) / (TOKEN_PACE_WINDOW_MS / HOUR_MS)
  );
}

function turnCostWeightedTokens(state: UsageGuardInstanceState, model: string | null): number {
  const own = model === null ? undefined : state.turnCostByModel[model];
  if (own !== undefined && own.samples > 0) return own.ewmaWeightedTokens;
  const any = state.turnCostByModel["*"];
  if (any !== undefined && any.samples > 0) {
    // Re-weight the all-model average to this model's tier.
    return any.ewmaWeightedTokens * modelCostMultiplier(state.driver, model);
  }
  return DEFAULT_TURN_TOKENS * modelCostMultiplier(state.driver, model);
}

export function formatRunway(ms: number | null): string {
  if (ms === null) return "an unknown time";
  if (ms <= 0) return "moments";
  const minutes = Math.round(ms / MINUTE_MS);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(ms / HOUR_MS);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(ms / DAY_MS)} d`;
}

/** Compact token counts for prose: 4.2M, 850k, 900. */
function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.round(value));
}

export function formatUsageGuardPercent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}%`;
}

/**
 * Where every window stands for a turn on `model`, and what the guard does
 * about it. See the module comment for the three questions this answers.
 */
export function resolveUsageGuardEvaluationModel(input: {
  readonly requested: string | null;
  readonly lastUsed: string | null;
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly isDefault?: boolean | undefined;
  }>;
}): string | null {
  return (
    input.requested ?? input.lastUsed ?? input.models.find((model) => model.isDefault)?.slug ?? null
  );
}

/** Samples are keyed by model, effort and service tier; never pool different prices. */
export function effortCostKey(model: string, effort: string, fast: boolean): string {
  return JSON.stringify([model, effort, fast]);
}

export function measuredEffortCost(
  state: UsageGuardInstanceState,
  model: string | null,
  effort: string | undefined,
  fast = false,
) {
  const cost =
    model && effort ? state.costByEffort?.[effortCostKey(model, effort, fast)] : undefined;
  return cost && cost.samples >= 3 ? cost : null;
}

/** Conservative starting assumptions, not provider price guarantees. Most call cost is context. */
export function defaultEffortCostFactor(effort: string | undefined): number {
  switch (effort?.toLowerCase()) {
    case "none":
    case "minimal":
      return 0.75;
    case "low":
      return 0.8;
    case "medium":
      return 0.9;
    case "xhigh":
      return 1.1;
    case "max":
      return 1.2;
    case "ultra":
    case "ultracode":
    case "ultrathink":
      return 1.3;
    default:
      return 1;
  }
}

export function evaluateUsageGuard(input: {
  readonly state: UsageGuardInstanceState;
  readonly config: UsageGuardProviderSettings;
  readonly nowMs: number;
  readonly model?: string | null;
  readonly activeThreads?: number;
  readonly fast?: boolean;
  readonly effort?: string | undefined;
}): UsageGuardEvaluation {
  const { state, config, nowMs } = input;
  const model = input.model ?? null;
  const effortCost = measuredEffortCost(state, model, input.effort, input.fast);
  const fallbackFactor = defaultEffortCostFactor(input.effort);
  const expectedTokens =
    effortCost?.ewmaWeightedTokens ?? turnCostWeightedTokens(state, model) * fallbackFactor;
  const activeThreads = Math.max(0, input.activeThreads ?? 0);
  const family = modelFamily(state.driver, model);
  const headroom = config.headroomPercent;
  const tokenPace = tokenPacePerHour(state, nowMs);

  const windows: UsageGuardWindowEstimate[] = [];
  let binding: UsageGuardWindowEstimate | null = null;
  let bindingState: UsageGuardWindowState | undefined;
  let extra: UsageGuardWindowEstimate | null = null;
  let extraState: UsageGuardWindowState | undefined;

  const ledger = state.creditLedger ?? emptyCreditLedger();
  const credits = state.credits;
  const baselinePaidTurnCost = creditTurnCost(ledger, model, input.fast ?? false);
  const paidTurnCost =
    effortCost?.credits ??
    (baselinePaidTurnCost === null ? null : baselinePaidTurnCost * fallbackFactor);
  const creditCapacity = Math.max(0.01, config.creditBalanceScaleUsd * config.creditsPerUsd);
  const paidRatio =
    paidTurnCost !== null && paidTurnCost > 0 && creditCapacity > 0
      ? ((expectedTokens / paidTurnCost) * creditCapacity) / 100
      : null;
  const creditSpentSinceReport = Math.max(0, ledger.spent - (credits?.spentAtReport ?? 0));
  const day = creditBudgetDay(nowMs);
  const dailySpent = state.dailyCredits?.startsAt === day.startsAt ? state.dailyCredits.spent : 0;
  const creditRemaining = Math.min(
    Math.max(0, config.creditBalanceScaleUsd * config.creditsPerUsd - dailySpent),
    Math.max(0, (credits?.balance ?? 0) - creditSpentSinceReport),
  );
  const paidWindow: UsageGuardWindowState | null =
    credits && credits.balance !== null && paidRatio !== null
      ? {
          key: "paid-credits",
          label: "paid credits",
          scope: "extra-usage",
          family: null,
          reportedPercent: 100 * (1 - creditRemaining / creditCapacity),
          reportedAtMs: nowMs,
          resetsAtMs: day.endsAt,
          windowDurationMs: day.endsAt - day.startsAt,
          tokensAtReport: state.tokensTotal,
          anchorPercent: null,
          anchorTokens: null,
          learnedTokensPerPercent: null,
          calibrationSamples: 0,
          burnPercentPerHour: null,
          burnAnchorPercent: null,
          burnAnchorAtMs: null,
        }
      : null;
  const ratioFor = (window: UsageGuardWindowState | undefined) =>
    window?.key === "paid-credits" && paidRatio !== null
      ? { value: paidRatio, source: "default" as const }
      : effectiveTokensPerPercent(config, state.driver, window);

  for (const window of [...Object.values(state.windows), ...(paidWindow ? [paidWindow] : [])]) {
    const expired = window.resetsAtMs !== null && nowMs >= window.resetsAtMs;
    const ratioInfo = ratioFor(window);
    const ratio = ratioInfo.value;
    const tokensSince = Math.max(0, state.tokensTotal - window.tokensAtReport);
    const extrapolated = expired ? 0 : tokensSince / ratio;
    const reported = expired ? 0 : window.reportedPercent;
    const estimated =
      window.key === "paid-credits"
        ? 100 * (1 - creditRemaining / creditCapacity)
        : expired
          ? 0
          : Math.min(100, reported + extrapolated);
    const hoursLeft =
      window.resetsAtMs !== null && !expired
        ? (window.resetsAtMs - nowMs) / HOUR_MS
        : (window.windowDurationMs ?? 5 * HOUR_MS) / 2 / HOUR_MS;
    const burn =
      window.key === "paid-credits"
        ? (ledger.calls
            .filter((call) => call.atMs >= nowMs - TOKEN_PACE_WINDOW_MS)
            .reduce((sum, call) => sum + call.credits, 0) /
            (TOKEN_PACE_WINDOW_MS / HOUR_MS) /
            creditCapacity) *
          100
        : expired
          ? 0
          : Math.max(
              window.burnPercentPerHour ?? 0,
              tokenPace / ratio,
              // A first report after restart still carries the account's spending
              // pace. Do not grant a fresh unrestricted burst while relearning it.
              window.windowDurationMs !== null && window.windowDurationMs > hoursLeft * HOUR_MS
                ? reported / ((window.windowDurationMs - hoursLeft * HOUR_MS) / HOUR_MS)
                : 0,
            );
    const projected = Math.min(300, estimated + burn * hoursLeft);
    const remaining = 100 - headroom - estimated;
    // Zero while this window's scale is still the driver's guess, so an
    // invented turn cost cannot declare the window exhausted and pin effort to
    // its floor. `remaining <= 0` — the window actually being full — still
    // trips the same branch, because that needs no turn cost at all.
    const nextCallCost =
      window.key === "paid-credits" && paidTurnCost !== null
        ? (paidTurnCost / creditCapacity) * 100
        : ratioInfo.source === "default"
          ? 0
          : expectedTokens / ratio;
    const balancePressure =
      1 - usageGuardPaceAllowance(estimated, { ...config, earlyOvershootPercent: 100 }) / 100;
    // The time bar: how far through the window the clock is. Usage below it is
    // under pace and costs nothing, however fast the recent burn looked.
    const msLeft = window.resetsAtMs !== null && !expired ? window.resetsAtMs - nowMs : null;
    const elapsedPercent =
      window.windowDurationMs !== null &&
      window.windowDurationMs > 0 &&
      msLeft !== null &&
      // A reset further out than the whole window means the two disagree; the
      // bar would be nonsense, so fall back rather than invent a position.
      msLeft <= window.windowDurationMs
        ? Math.min(
            100,
            Math.max(0, ((window.windowDurationMs - msLeft) / window.windowDurationMs) * 100),
          )
        : null;
    const aheadOfPacePercent = elapsedPercent === null ? null : estimated - elapsedPercent;
    // How far ahead of the bar is tolerated before limiting starts. Ten points
    // early on, shrinking toward nothing as the window fills.
    const paceTolerance = Math.max(0.5, usageGuardPaceAllowance(estimated, config));
    const pressure =
      window.key === "paid-credits"
        ? 1 / Math.max(0.01, 1 - balancePressure)
        : expired
          ? 0
          : remaining <= nextCallCost * Math.max(1, activeThreads)
            ? Number.POSITIVE_INFINITY
            : aheadOfPacePercent === null
              ? // No duration and no reset means no time bar, and the time bar
                // is the whole model. Extrapolating a burn instead is what
                // paced a 0%-used `nimbus quill` window — an unrecognised key,
                // so account-scoped and durationless — to a turn every 23
                // minutes, borrowing the account's token rate to do it. A
                // window we cannot place on a clock tells us nothing about
                // pace. Exhaustion is still caught above, by `fits`.
                0
              : // Behind the bar is free; past the tolerance it scales, so the
                // further ahead the harder the limit. Nothing else feeds this.
                Math.max(0, aheadOfPacePercent) / paceTolerance;
    const applicable =
      !expired &&
      (window.scope === "account" ||
        // Fail closed. An unknown family used to make EVERY model-family window
        // apply, so a spent Fable window governed background work on an opus
        // thread and paced it to a turn a day. If we cannot name the family, a
        // family window is not ours to answer to; the account windows still are.
        (window.scope === "model-family" && family !== null && window.family === family));
    const estimate: UsageGuardWindowEstimate = {
      key: window.key,
      label: window.label,
      scope: window.scope,
      family: window.family,
      reportedPercent: reported,
      estimatedPercent: estimated,
      resetsAtMs: window.resetsAtMs,
      expired,
      applicable,
      hoursLeft,
      burnPercentPerHour: burn,
      projectedAtResetPercent: projected,
      elapsedPercent,
      aheadOfPacePercent,
      windowDurationMs: window.windowDurationMs,
      remainingPercent: remaining,
      pressure,
    };
    windows.push(estimate);
    if (applicable) {
      if (
        binding === null ||
        estimate.pressure > binding.pressure ||
        (estimate.pressure === binding.pressure &&
          estimate.estimatedPercent > binding.estimatedPercent)
      ) {
        binding = estimate;
        bindingState = window;
      }
    } else if (window.scope === "extra-usage" && !expired) {
      if (extra === null || estimate.estimatedPercent > extra.estimatedPercent) {
        extra = estimate;
        extraState = window;
      }
    }
  }

  let ratio = ratioFor(bindingState ?? extraState);
  let turnCostPercent = expectedTokens / ratio.value;
  // Whether the price of a turn is something we measured or something we
  // guessed. The driver default is a stand-in for the plan's token allowance
  // and cannot be right for every plan — on a real account it was 380x off,
  // and holding work on the strength of it stalled threads that had ample
  // room. Until a window has taught us its own scale we only hold on what the
  // window itself reports, which needs no ratio at all. This is also the whole
  // of the time-bar model, so pacing is unaffected either way.
  let turnCostMeasured = ratio.source !== "default";

  const fits = (window: UsageGuardWindowEstimate | null) =>
    window !== null &&
    window.reportedPercent < 100 &&
    window.estimatedPercent +
      (window.key === "paid-credits" && paidTurnCost !== null
        ? (paidTurnCost / creditCapacity) * 100
        : turnCostMeasured
          ? turnCostPercent
          : 0) *
        Math.max(1, activeThreads) +
      headroom <
      100;

  // Credits the account could actually fall back on. Deliberately not the same
  // as "extra usage is allowed": a person who set extraUsage to avoid still has
  // credits and still means to wait for the reset.
  const creditsRemain =
    credits != null && (credits.unlimited || (credits.balance !== null && credits.balance > 0));
  // A window the provider itself calls spent, with no credits behind it, has
  // nothing to wait for but the reset, and a silent multi-hour hold is worse
  // than the provider's own refusal: let the turn go and surface the real
  // insufficient-credit error. A window that is merely too tight for one more
  // turn is a different thing — that reserve is still worth protecting.
  const bindingSpent = binding !== null && binding.reportedPercent >= 100;
  // Paid room the account still has, whether or not this person wants to spend
  // it. Someone who set extraUsage to avoid has somewhere to go and means to
  // wait for the reset instead; someone the provider has cut off does not.
  const fallbackAvailable = creditsRemain || (extra !== null && fits(extra));
  const holdWhenExhausted = config.pauseWhenExhausted && (fallbackAvailable || !bindingSpent);
  // Releasing the hold has to mean releasing it. Pacing a spent window to one
  // turn every 25 hours is the same hold wearing a different name, so the same
  // condition that declines to hold also declines to meter.
  const releasedExhausted = bindingSpent && !fallbackAvailable;

  let tier: UsageGuardTier = "none";
  let governing: UsageGuardWindowEstimate | null = binding;
  if (binding !== null && !fits(binding)) {
    if (credits?.unlimited && config.extraUsage === "allow") {
      tier = "extra-usage";
      governing = null;
    } else if (extra !== null && config.extraUsage === "allow") {
      tier = fits(extra) ? "extra-usage" : holdWhenExhausted ? "pause" : "optimize";
      governing = extra;
      ratio = ratioFor(extraState);
      turnCostPercent = expectedTokens / ratio.value;
      turnCostMeasured = ratio.source !== "default";
    } else {
      tier = holdWhenExhausted ? "pause" : "optimize";
    }
  } else if (binding !== null && binding.pressure > 1) {
    tier = "optimize";
  }

  const pressure = governing?.pressure ?? 0;
  const reduction =
    governing?.key === "paid-credits"
      ? 1 -
        usageGuardPaceAllowance(governing.estimatedPercent, {
          ...config,
          earlyOvershootPercent: 100,
        }) /
          100
      : tier === "none"
        ? 0
        : Number.isFinite(pressure) && pressure > 1
          ? 1 - 1 / pressure
          : tier === "optimize"
            ? 0
            : 0.35;
  const effortTarget: UsageGuardEffortTarget | null =
    tier === "none" ||
    !config.reduceEffort ||
    (governing?.key === "paid-credits" && reduction < 0.2)
      ? null
      : reduction > 0.35 || tier === "extra-usage" || tier === "pause"
        ? reduction > 0.35
          ? "low"
          : "medium"
        : "medium";
  // Reasoning changes do not create quota. Only measured consumption earns room.

  // Concurrency budget: how many threads the points left can carry to reset
  // at the per-thread pace, after the effort reduction. Unbounded while the
  // pace is fine — nothing is gained by throttling a window that will not
  // fill.
  let backgroundBudget: number | null = null;
  let admitBackground = true;
  let backgroundCooldownMs: number | null = null;
  let nextBackgroundAdmitAtMs: number | null = null;
  let tokenCapSpent: number | null = null;
  if (tier === "pause") {
    backgroundBudget = 0;
    admitBackground = false;
  } else if (governing?.key === "paid-credits") {
    if (config.holdBackgroundWork) {
      const spent = Math.max(0, ledger.spent - (state.creditsAtAdmission ?? ledger.spent));
      const remainingMs = Math.max(MINUTE_MS, day.endsAt - nowMs);
      const allowance = creditRemaining / (remainingMs / HOUR_MS);
      const cost = Math.max(paidTurnCost ?? 0, spent);
      backgroundCooldownMs = Math.round(
        Math.min(
          remainingMs,
          Math.max(MINUTE_MS, allowance > 0 ? (cost / allowance) * HOUR_MS : remainingMs),
        ),
      );
      const dueAt =
        state.lastBackgroundAdmitAtMs === null
          ? nowMs
          : state.lastBackgroundAdmitAtMs + backgroundCooldownMs;
      admitBackground = dueAt <= nowMs;
      if (!admitBackground) nextBackgroundAdmitAtMs = dueAt;
    }
  } else if (governing !== null && tier !== "none") {
    const hoursLeft = Math.max(governing.hoursLeft, 1 / 60);
    const allowedBurn =
      (Math.max(0, governing.remainingPercent) / hoursLeft) *
      (1 + usageGuardPaceAllowance(governing.estimatedPercent, config) / 100);
    const observed = governing.burnPercentPerHour;
    const perThread =
      observed > 0
        ? observed / Math.max(1, state.activeThreadsEwma ?? activeThreads)
        : // Nothing observed yet: assume a turn every twenty minutes.
          turnCostPercent * 3;
    backgroundBudget = perThread <= 0 ? null : Math.floor(allowedBurn / perThread);
    if (config.holdBackgroundWork && !releasedExhausted) {
      // Tokens against the clock, not turns against a stopwatch.
      //
      // This used to admit one turn per computed interval, so a 200k-token turn
      // and a 10M-token turn each consumed exactly one slot: the spacing was
      // derived from tokens but the gate counted turns. What matters is whether
      // the tokens already spent are ahead of where the clock is, and by how
      // much. When they are, the wait is how long the bar needs to catch up —
      // longer the further ahead the spend went, with no turn cadence, no
      // per-turn cost estimate and no admission stopwatch.
      const ahead = governing.aheadOfPacePercent;
      const tolerance = usageGuardPaceAllowance(governing.estimatedPercent, config);
      // What running this turn would put on the bar. Including it is what makes
      // a cheaper model or effort worth choosing: it needs less catch-up, so it
      // shows a shorter wait, which is the saving the comparison list quotes.
      const afterThisTurn =
        ahead === null ? null : ahead + turnCostPercent * Math.max(1, activeThreads);
      if (afterThisTurn === null || afterThisTurn <= tolerance) {
        admitBackground = true;
      } else {
        admitBackground = false;
        const catchUpMs =
          governing.windowDurationMs === null
            ? Math.max(hoursLeft * HOUR_MS, MINUTE_MS)
            : (governing.windowDurationMs * (afterThisTurn - tolerance)) / 100;
        backgroundCooldownMs = Math.round(
          Math.min(Math.max(catchUpMs, MINUTE_MS), Math.max(hoursLeft * HOUR_MS, MINUTE_MS)),
        );
        nextBackgroundAdmitAtMs = nowMs + backgroundCooldownMs;
      }
    }
  }

  // A ceiling the person set themselves, on top of everything above. It is
  // purely additive: with no cap the guard behaves exactly as it otherwise
  // would, and a cap can only ever withhold work, never admit work the window
  // maths already refused. It also bites when the provider's own windows are
  // perfectly healthy, which is the point of having it.
  const capTokens = config.tokenCapTokens;
  if (capTokens !== null && capTokens > 0) {
    const capWindowMs = Math.max(MINUTE_MS, config.tokenCapHours * HOUR_MS);
    const capSince = nowMs - capWindowMs;
    tokenCapSpent = weightedTokensSince(state, capSince);
    if (tokenCapSpent >= capTokens) {
      admitBackground = false;
      // The rolling window frees as its oldest call ages out of it.
      const oldest = oldestCallAtMs(state, capSince);
      const freesAt = oldest === null ? nowMs + capWindowMs : oldest + capWindowMs;
      nextBackgroundAdmitAtMs =
        nextBackgroundAdmitAtMs === null ? freesAt : Math.max(nextBackgroundAdmitAtMs, freesAt);
      backgroundCooldownMs = Math.max(MINUTE_MS, nextBackgroundAdmitAtMs - nowMs);
    }
  }

  const runway =
    governing?.resetsAtMs === null || governing === null ? null : governing.resetsAtMs - nowMs;
  const label = governing?.label ?? "usage";
  const modelLabel = model ?? "this model";
  const capHolding =
    config.tokenCapTokens !== null &&
    tokenCapSpent !== null &&
    tokenCapSpent >= config.tokenCapTokens;
  const summary = (() => {
    if (capHolding) {
      return `Holding new work · your own cap of ${formatTokens(config.tokenCapTokens ?? 0)} tokens per ${config.tokenCapHours} h is spent (${formatTokens(tokenCapSpent ?? 0)} used).`;
    }
    switch (tier) {
      case "pause": {
        if (credits && config.extraUsage === "allow" && credits.balance !== null) {
          return paidTurnCost === null
            ? `Holding new work · ${creditRemaining.toFixed(1)} credits reported, but the credit rate for ${modelLabel} is unknown.`
            : `Holding new work · ${creditRemaining.toFixed(1)} credits remain; an estimated ${paidTurnCost.toFixed(2)} credits per turn on ${modelLabel} does not fit with the reserve. Add credits or change the budget settings to make room.`;
        }
        // `fits` refuses for two independent reasons and they need different
        // sentences. Narrating the turn-cost arithmetic for a window the
        // provider already calls spent produced the nonsense a person reads as
        // incoherent: "is at ~100% and one more turn costs ~0.1%, which does
        // not fit with 3% headroom" — 0.1 does fit in 3; the real problem is
        // that nothing is left. The reset time is deliberately absent: the
        // card that renders this appends a live one, and the copy baked in
        // here freezes at hold time and drifts minutes away from it.
        if (governing !== null && governing.reportedPercent >= 100) {
          return `Holding new work · the ${label} window is spent. New turns wait for it to reset.`;
        }
        const usable = Math.max(0, governing?.remainingPercent ?? 0);
        const needed = turnCostPercent * Math.max(1, activeThreads);
        const needClause =
          activeThreads > 1
            ? `a turn on each of the ${activeThreads} active threads needs ~${needed.toFixed(1)}%`
            : `one more turn on ${modelLabel} needs ~${needed.toFixed(1)}%`;
        return `Holding new work · ${label} is at ~${formatUsageGuardPercent(governing?.estimatedPercent ?? null)}, which leaves ~${usable.toFixed(1)}% before the ${headroom}% reserve, and ${needClause}.`;
      }
      case "extra-usage":
        if (credits?.unlimited && governing === null)
          return "On extra usage · the provider reports unlimited credits.";
        return `On extra usage · the included ${binding?.label ?? "window"} is spent; paid credits fund future work. ${backgroundCooldownMs !== null ? `Shared allowance: approximately one model call every ${formatRunway(backgroundCooldownMs)}.` : ""}${governing?.key === "paid-credits" ? ` ~$${(creditRemaining / config.creditsPerUsd).toFixed(2)} remaining in today’s $${config.creditBalanceScaleUsd} budget (${creditRemaining.toFixed(1)} credits); estimated ${paidTurnCost?.toFixed(2)} credits per model call on ${modelLabel}.` : ""}`;
      case "optimize":
        return `Optimizing · ${label} is ~${formatUsageGuardPercent(governing?.estimatedPercent ?? null)} used${governing?.aheadOfPacePercent != null ? ` at ~${formatUsageGuardPercent(governing.elapsedPercent)} of the way through, ~${Math.abs(governing.aheadOfPacePercent).toFixed(0)} points ${governing.aheadOfPacePercent <= 0 ? "behind" : "ahead of"} pace` : ""}${backgroundBudget !== null && config.holdBackgroundWork ? (backgroundCooldownMs !== null ? `; background work paced to one turn every ~${formatRunway(backgroundCooldownMs)}` : `; background work limited to ${backgroundBudget} thread${backgroundBudget === 1 ? "" : "s"}`) : ""}.`;
      default:
        return governing === null
          ? "No usage report yet."
          : governing.aheadOfPacePercent == null
            ? `Under budget · ${label} at ~${formatUsageGuardPercent(governing.estimatedPercent)}, resetting in ${formatRunway(runway)}.`
            : `Under budget · ${label} is ~${formatUsageGuardPercent(governing.estimatedPercent)} used at ~${formatUsageGuardPercent(governing.elapsedPercent)} of the way through — ~${Math.abs(governing.aheadOfPacePercent).toFixed(0)} points ${governing.aheadOfPacePercent <= 0 ? "behind" : "ahead of"} pace.`;
    }
  })();

  return {
    tier,
    observedTokens: state.tokensTotal,
    summary,
    windowKey: governing?.key ?? null,
    windowLabel: governing?.label ?? null,
    windowScope: governing?.scope ?? null,
    reportedPercent: governing?.reportedPercent ?? null,
    estimatedPercent: governing?.estimatedPercent ?? null,
    elapsedPercent: governing?.elapsedPercent ?? null,
    aheadOfPacePercent: governing?.aheadOfPacePercent ?? null,
    resetsAtMs: governing?.resetsAtMs ?? null,
    burnPercentPerHour: governing?.burnPercentPerHour ?? null,
    projectedAtResetPercent: governing?.projectedAtResetPercent ?? null,
    turnCostPercent: governing === null ? null : turnCostPercent,
    remainingPercent: governing?.remainingPercent ?? null,
    headroomPercent: headroom,
    pressure,
    effortTarget,
    backgroundBudget,
    activeThreads,
    admitBackground,
    backgroundCooldownMs,
    nextBackgroundAdmitAtMs,
    tokensPerPercent: ratio.value,
    percentPerMillionTokens: modelPercentPerMillionTokens(state.driver, model),
    tokenCapSpent,
    tokensPerPercentSource: ratio.source,
    learnedTokensPerPercent: (bindingState ?? extraState)?.learnedTokensPerPercent ?? null,
    tokensSinceReport:
      bindingState === undefined ? 0 : Math.max(0, state.tokensTotal - bindingState.tokensAtReport),
    model,
    windows,
  };
}

/**
 * When held work should be looked at again on its own: shortly after the
 * reset if that is close, otherwise in five minutes. Holds are also lifted
 * early by the guard whenever a report or a thread going idle makes room, so
 * this is the ceiling on how long a hold outlives its cause, not the norm.
 */
export const USAGE_GUARD_RECHECK_MS = 5 * MINUTE_MS;
/**
 * Does the provider's own latest report say the account cannot run a turn at
 * all? True when an applicable included window is reported at 100% and no
 * paid credit remains to fund the turn instead. This is the provider's word,
 * not the guard's pacing math — the one case a person's Resume is refused,
 * because the turn would only fail.
 */
export function providerReportsExhausted(
  evaluation: UsageGuardEvaluation,
  state: UsageGuardInstanceState,
): boolean {
  const includedExhausted = evaluation.windows.some(
    (window) =>
      window.applicable &&
      !window.expired &&
      window.key !== "paid-credits" &&
      window.reportedPercent >= 100,
  );
  if (!includedExhausted) return false;
  const credits = state.credits;
  const creditsRemain =
    credits != null && (credits.unlimited || (credits.balance !== null && credits.balance > 0));
  return !creditsRemain;
}

export function usageGuardWakeAtMs(evaluation: UsageGuardEvaluation, nowMs: number): number {
  const recheck = nowMs + USAGE_GUARD_RECHECK_MS;
  const due = evaluation.nextBackgroundAdmitAtMs;
  // A cooldown names its own end. Sleeping to it (never less than a minute,
  // never past the reset) beats waking every five minutes to learn it has
  // not elapsed - but a report can still lift the hold early.
  const target =
    due !== null && due > nowMs
      ? Math.max(nowMs + MINUTE_MS, Math.min(due, recheck * 12))
      : recheck;
  if (evaluation.resetsAtMs !== null && evaluation.resetsAtMs > nowMs) {
    return Math.min(target, evaluation.resetsAtMs + 30_000);
  }
  return target;
}

export function toServerProviderUsageGuardState(input: {
  readonly evaluation: UsageGuardEvaluation;
  readonly config: UsageGuardResolvedConfig;
  readonly nowIso: string;
}): ServerProviderUsageGuardState {
  const { evaluation, config } = input;
  return {
    enabled: config.active,
    tier: config.active ? evaluation.tier : "none",
    summary: config.active ? evaluation.summary : "Off",
    windowKey: evaluation.windowKey,
    windowLabel: evaluation.windowLabel,
    windowScope: evaluation.windowScope,
    reportedPercent: evaluation.reportedPercent,
    estimatedPercent: evaluation.estimatedPercent,
    resetsAt: evaluation.resetsAtMs,
    burnPercentPerHour: evaluation.burnPercentPerHour,
    projectedAtResetPercent: evaluation.projectedAtResetPercent,
    turnCostPercent: evaluation.turnCostPercent,
    headroomPercent: evaluation.headroomPercent,
    effortTarget: config.active ? evaluation.effortTarget : null,
    backgroundBudget: evaluation.backgroundBudget,
    activeThreads: evaluation.activeThreads,
    holdingBackgroundWork: config.active && !evaluation.admitBackground,
    backgroundCooldownMs: evaluation.backgroundCooldownMs,
    tokensPerPercent: evaluation.tokensPerPercent,
    tokensPerPercentSource: evaluation.tokensPerPercentSource,
    learnedTokensPerPercent: evaluation.learnedTokensPerPercent,
    tokensSinceReport: evaluation.tokensSinceReport,
    updatedAt: input.nowIso,
  };
}

const EFFORT_OPTION_IDS = new Set(["effort", "reasoningEffort"]);

/** Canonical rank of reasoning-effort values across drivers; unknown = leave alone. */
const EFFORT_RANK: Readonly<Record<string, number>> = {
  none: 0,
  minimal: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
  ultracode: 6,
  ultrathink: 6,
};

export function findEffortDescriptor(
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
): Extract<ProviderOptionDescriptor, { type: "select" }> | null {
  for (const descriptor of descriptors ?? []) {
    if (descriptor.type === "select" && EFFORT_OPTION_IDS.has(descriptor.id)) {
      return descriptor;
    }
  }
  return null;
}

export function providerModelOptionDescriptors(
  provider: ServerProvider | undefined,
  model: string,
): ReadonlyArray<ProviderOptionDescriptor> {
  if (!provider) return [];
  const entry = provider.models.find((candidate) => candidate.slug === model);
  const own = entry?.capabilities?.optionDescriptors;
  if (own && own.length > 0) return own;
  for (const candidate of provider.models) {
    const descriptors = candidate.capabilities?.optionDescriptors;
    if (descriptors && findEffortDescriptor(descriptors) !== null) return descriptors;
  }
  return [];
}

export interface UsageGuardOptimizationResult {
  readonly modelSelection: ModelSelection;
  readonly applied: {
    readonly optionId: string;
    readonly from: string;
    readonly to: string;
  } | null;
}

/**
 * Lower the selection's reasoning effort to `targetEffort` (or the nearest
 * lower level the model offers). Never raises effort, never touches a model
 * that exposes no effort control, and never invents a value the catalog does
 * not list. Returns the same selection instance when nothing changes.
 */
/**
 * Did the person pick an effort on the usage-guard chip during the current
 * hold? The chip appends `usage-guard.effort-selected`; a later
 * `usage-guard.paused` starts a new hold and the chip is offered again, so a
 * pick only stands until then. While it stands, the optimizer must not lower it
 * back to its own target — that made Apply revert on resume.
 */
export function userPinnedEffortDuringHold(
  activities: ReadonlyArray<{ readonly kind: string; readonly createdAt: string }>,
): boolean {
  let pausedAt: string | null = null;
  let selectedAt: string | null = null;
  for (const activity of activities) {
    if (activity.kind === "usage-guard.paused") {
      if (pausedAt === null || activity.createdAt >= pausedAt) pausedAt = activity.createdAt;
    } else if (activity.kind === "usage-guard.effort-selected") {
      if (selectedAt === null || activity.createdAt >= selectedAt) selectedAt = activity.createdAt;
    }
  }
  return selectedAt !== null && (pausedAt === null || selectedAt >= pausedAt);
}

export function applyUsageGuardOptimization(input: {
  readonly modelSelection: ModelSelection;
  readonly descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly targetEffort: UsageGuardEffortTarget;
}): UsageGuardOptimizationResult {
  const descriptor = findEffortDescriptor(input.descriptors);
  if (descriptor === null || descriptor.options.length === 0) {
    return { modelSelection: input.modelSelection, applied: null };
  }
  const options = input.modelSelection.options ?? [];
  const selected = options.find((option) => option.id === descriptor.id);
  const currentValue =
    typeof selected?.value === "string"
      ? selected.value
      : (descriptor.currentValue ??
        descriptor.options.find((option) => option.isDefault === true)?.id ??
        null);
  if (currentValue === null) {
    return { modelSelection: input.modelSelection, applied: null };
  }
  const currentRank = EFFORT_RANK[currentValue.toLowerCase()];
  const targetRank = EFFORT_RANK[input.targetEffort];
  if (currentRank === undefined || targetRank === undefined || currentRank <= targetRank) {
    return { modelSelection: input.modelSelection, applied: null };
  }
  let best: { readonly id: string; readonly rank: number } | null = null;
  for (const option of descriptor.options) {
    const rank = EFFORT_RANK[option.id.toLowerCase()];
    if (rank === undefined || rank > targetRank) continue;
    if (best === null || rank > best.rank) best = { id: option.id, rank };
  }
  if (best === null || best.id === currentValue) {
    return { modelSelection: input.modelSelection, applied: null };
  }
  const chosen = best.id;
  const nextOptions = selected
    ? options.map((option) => (option.id === descriptor.id ? { ...option, value: chosen } : option))
    : [...options, { id: descriptor.id, value: chosen }];
  return {
    modelSelection: { ...input.modelSelection, options: nextOptions },
    applied: { optionId: descriptor.id, from: currentValue, to: chosen },
  };
}

/**
 * Whether two guard readings differ in anything a client would render.
 *
 * `updatedAt` is excluded on purpose: it moves on every recomputation, and
 * publishing on it alone re-broadcasts the entire provider list for no visible
 * change.
 */
export function usageGuardStatesEqual(
  a: ServerProviderUsageGuardState,
  b: ServerProviderUsageGuardState,
): boolean {
  const keys = Object.keys(a) as ReadonlyArray<keyof ServerProviderUsageGuardState>;
  for (const key of keys) {
    if (key === "updatedAt") continue;
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/** Only select-valued effort controls can be calibrated. */
export function selectedUsageGuardEffort(
  selection: ModelSelection | undefined,
): string | undefined {
  const value = selection?.options?.find(
    (option) => option.id === "effort" || option.id === "reasoningEffort",
  )?.value;
  return typeof value === "string" ? value : undefined;
}
