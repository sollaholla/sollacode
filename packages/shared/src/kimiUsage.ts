// @effect-diagnostics globalDate:off - parses timestamps Kimi sent; the one clock read is passed in.
import * as Predicate from "effect/Predicate";

/**
 * Kimi Code's plan quota, read from `GET {base}/usages` — the endpoint Kimi's
 * own `/usage` reads (`fetchManagedUsage` in kimi 0.28). Parsed on the server
 * into this envelope, which is what `accountUsage` and usage events carry.
 */
export const KIMI_USAGE_SOURCE = "kimi-usages";

const MINUTE_MS = 60_000;
const WEEK_MS = 7 * 24 * 60 * MINUTE_MS;
/** Kimi's booster wallet stores money as fixed point: this many units per cent. */
const FIXED_POINT_PER_CENT = 1e6;

export interface KimiUsageWindow {
  readonly key: string;
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsAt: string | null;
  readonly windowDurationMs: number | null;
}

export interface KimiExtraUsage {
  readonly balanceCents: number;
  readonly totalCents: number;
  readonly currency: string;
}

export interface KimiAccountUsage {
  readonly source: typeof KIMI_USAGE_SOURCE;
  readonly windows: ReadonlyArray<KimiUsageWindow>;
  readonly extraUsage?: KimiExtraUsage;
}

function toInt(value: unknown): number | null {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? Math.trunc(number) : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/** Kimi's timestamps can carry nanoseconds, which `Date.parse` does not accept. */
function isoFromTimestamp(value: string): string | null {
  const normalized = value.replace(/(\.\d{3})\d+(Z|[+-]\d{2}:?\d{2})$/u, "$1$2");
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function resetsAtFrom(row: Record<string, unknown>, nowMs: number): string | null {
  for (const key of ["reset_at", "resetAt", "reset_time", "resetTime"]) {
    const value = text(row[key]);
    if (value) return isoFromTimestamp(value);
  }
  for (const key of ["reset_in", "resetIn"]) {
    const seconds = toInt(row[key]);
    if (seconds !== null && seconds > 0) return new Date(nowMs + seconds * 1000).toISOString();
  }
  return null;
}

/** A row's used percent, or null when it has no limit to be a fraction of. */
function usedPercentFrom(row: Record<string, unknown>): number | null {
  const limit = toInt(row.limit);
  if (limit === null || limit <= 0) return null;
  const remaining = toInt(row.remaining);
  const used = toInt(row.used) ?? (remaining === null ? null : limit - remaining);
  return used === null ? null : clampPercent((used / limit) * 100);
}

/** `5h`, `30m`, `1d` — or null for a window Kimi describes in a unit we do not know. */
function windowMinutes(window: Record<string, unknown>): number | null {
  const duration = toInt(window.duration);
  const unit = text(window.timeUnit) ?? "";
  if (duration === null || duration <= 0) return null;
  if (unit.includes("MINUTE")) return duration;
  if (unit.includes("HOUR")) return duration * 60;
  if (unit.includes("DAY")) return duration * 24 * 60;
  return null;
}

function windowName(minutes: number): string {
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d limit`;
  if (minutes % 60 === 0) return `${minutes / 60}h limit`;
  return `${minutes}m limit`;
}

function extraUsageFrom(raw: unknown): KimiExtraUsage | undefined {
  if (!Predicate.isObject(raw) || !Predicate.isObject(raw.balance)) return undefined;
  const balance = raw.balance;
  if (balance.type !== "BOOSTER") return undefined;
  const amount = toInt(balance.amount);
  if (amount === null || amount <= 0) return undefined;
  const left = toInt(balance.amountLeft) ?? 0;
  const currency =
    (Predicate.isObject(raw.monthlyChargeLimit) && text(raw.monthlyChargeLimit.currency)) ||
    (Predicate.isObject(raw.monthlyUsed) && text(raw.monthlyUsed.currency)) ||
    "USD";
  return {
    balanceCents: Math.round(left / FIXED_POINT_PER_CENT),
    totalCents: Math.round(amount / FIXED_POINT_PER_CENT),
    currency,
  };
}

/**
 * Parses a `/usages` response. The account-wide `usage` row is Kimi's weekly
 * limit; each `limits` entry is a rolling window. A row without a limit, or a
 * window in a unit Kimi has not used before, is dropped rather than shown as a
 * guess. Returns null when nothing usable came back.
 */
export function parseKimiUsagesResponse(payload: unknown, nowMs: number): KimiAccountUsage | null {
  if (!Predicate.isObject(payload)) return null;
  const windows: KimiUsageWindow[] = [];

  if (Predicate.isObject(payload.usage)) {
    const usedPercent = usedPercentFrom(payload.usage);
    if (usedPercent !== null) {
      windows.push({
        key: "weekly",
        label: "Weekly",
        usedPercent,
        resetsAt: resetsAtFrom(payload.usage, nowMs),
        windowDurationMs: WEEK_MS,
      });
    }
  }

  const seen = new Set(windows.map((window) => window.key));
  for (const item of Array.isArray(payload.limits) ? payload.limits : []) {
    if (!Predicate.isObject(item)) continue;
    const detail = Predicate.isObject(item.detail) ? item.detail : item;
    const window = Predicate.isObject(item.window) ? item.window : {};
    const minutes = windowMinutes({
      duration: window.duration ?? item.duration ?? detail.duration,
      timeUnit: window.timeUnit ?? item.timeUnit ?? detail.timeUnit,
    });
    const usedPercent = usedPercentFrom(detail);
    if (minutes === null || usedPercent === null) continue;
    const key = `${minutes}m`;
    if (seen.has(key)) continue;
    seen.add(key);
    windows.push({
      key,
      label: text(item.title) ?? text(detail.title) ?? windowName(minutes),
      usedPercent,
      resetsAt: resetsAtFrom(detail, nowMs),
      windowDurationMs: minutes * MINUTE_MS,
    });
  }

  const extraUsage = extraUsageFrom(payload.boosterWallet);
  if (windows.length === 0 && extraUsage === undefined) return null;
  return {
    source: KIMI_USAGE_SOURCE,
    windows,
    ...(extraUsage ? { extraUsage } : {}),
  };
}

/** Reads the envelope back out of `accountUsage`; anything else yields nothing. */
export function kimiAccountUsageFrom(raw: unknown): KimiAccountUsage | null {
  if (!Predicate.isObject(raw) || raw.source !== KIMI_USAGE_SOURCE) return null;
  const windows: KimiUsageWindow[] = [];
  for (const row of Array.isArray(raw.windows) ? raw.windows : []) {
    if (!Predicate.isObject(row)) continue;
    const key = text(row.key);
    const label = text(row.label);
    const usedPercent =
      typeof row.usedPercent === "number" && Number.isFinite(row.usedPercent)
        ? clampPercent(row.usedPercent)
        : null;
    if (!key || !label || usedPercent === null) continue;
    const resetsAt = typeof row.resetsAt === "string" ? isoFromTimestamp(row.resetsAt) : null;
    const windowDurationMs =
      typeof row.windowDurationMs === "number" && row.windowDurationMs > 0
        ? row.windowDurationMs
        : null;
    windows.push({ key, label, usedPercent, resetsAt, windowDurationMs });
  }
  const extra = raw.extraUsage;
  const extraUsage =
    Predicate.isObject(extra) &&
    typeof extra.balanceCents === "number" &&
    typeof extra.totalCents === "number" &&
    typeof extra.currency === "string"
      ? { balanceCents: extra.balanceCents, totalCents: extra.totalCents, currency: extra.currency }
      : undefined;
  return { source: KIMI_USAGE_SOURCE, windows, ...(extraUsage ? { extraUsage } : {}) };
}

export function formatKimiMoney(cents: number, currency: string): string {
  const amount = (cents / 100).toFixed(2);
  return currency === "USD" ? `$${amount}` : `${amount} ${currency}`;
}

/** The usage bar's rows: each limit as a percent, extra usage as a balance. */
export function kimiUsageWindows(raw: unknown) {
  const usage = kimiAccountUsageFrom(raw);
  if (!usage) return [];
  return [
    ...usage.windows.map((window) => ({
      key: window.key,
      label: window.label,
      usedPercent: window.usedPercent,
      resetAt: window.resetsAt === null ? null : Date.parse(window.resetsAt),
      windowDurationMs: window.windowDurationMs,
    })),
    ...(usage.extraUsage
      ? [
          {
            key: "extra-usage",
            label: "Extra usage",
            usedPercent: null,
            resetAt: null,
            detail: `${formatKimiMoney(usage.extraUsage.balanceCents, usage.extraUsage.currency)} left`,
            description: `Booster balance of ${formatKimiMoney(usage.extraUsage.totalCents, usage.extraUsage.currency)}, spent after the plan limits run out.`,
          },
        ]
      : []),
  ];
}
