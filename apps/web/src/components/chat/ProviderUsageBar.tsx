import type {
  EnvironmentId,
  ModelSelection,
  OrchestrationThreadActivity,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderUsageResetOutcome,
  ServerProvider,
} from "@t3tools/contracts";
import { ExternalLinkIcon, RefreshCwIcon, UserRoundIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { randomUUID } from "../../lib/utils";
import {
  activeResetCredits,
  mergeProviderUsageEntry,
  providerUsageAccountKey,
  PROVIDER_USAGE_STALE_AFTER_MS,
  type PersistedProviderUsageEntry,
  type PersistedProviderUsageResetCredit,
  type PersistedProviderUsageResetCredits,
  type PersistedProviderUsageWindow,
  useProviderUsageStore,
} from "../../providerUsageStore";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

export type ProviderUsageWindow = PersistedProviderUsageWindow;

export type ProviderUsagePlacement = "draft-pane-top" | "active-footer";

export function resolveProviderUsagePlacement(isDraftHeroState: boolean): ProviderUsagePlacement {
  return isDraftHeroState ? "draft-pane-top" : "active-footer";
}

export function ProviderUsagePlacementRow(props: {
  readonly placement: ProviderUsagePlacement;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  if (props.placement === "draft-pane-top") {
    return (
      <div
        data-chat-draft-provider-usage="true"
        className={`pointer-events-none relative z-10 flex shrink-0 justify-center px-2 pt-3 sm:pt-4${
          props.className ? ` ${props.className}` : ""
        }`}
      >
        {props.children}
      </div>
    );
  }

  return (
    <div
      data-chat-footer-provider-usage="true"
      className="pointer-events-none relative z-20 flex justify-center px-2 pb-1"
    >
      {props.children}
    </div>
  );
}

export function providerUsageDetailsSide(isDraftHeroState: boolean): "top" | "bottom" {
  // In the New Thread view, the usage badge sits at the top of the main pane.
  // Opening downward keeps the shared details popup inside the viewport.
  return isDraftHeroState ? "bottom" : "top";
}

/**
 * Providers name their windows inconsistently ("weekly", "nimbus quill",
 * "seven day overage included"); show every word capitalised so the list
 * reads as one voice.
 */
export function titleCaseUsageLabel(label: string): string {
  return label
    .trim()
    .split(/\s+/)
    .map((word) => (word.length === 0 ? word : word.charAt(0).toLocaleUpperCase() + word.slice(1)))
    .join(" ");
}

export interface ProviderUsageSummary {
  provider: ServerProvider;
  accountKey?: string | null;
  state: "available" | "stale" | "unavailable" | "unsupported";
  windows: ProviderUsageWindow[];
  reportedAt: string | null;
  resetCredits?: ProviderUsageResetCredits | null;
}

export type ProviderUsageResetCredit = PersistedProviderUsageResetCredit;
export type ProviderUsageResetCredits = PersistedProviderUsageResetCredits;

export interface ProviderUsageExternalLink {
  href: string;
  label: string;
}

export function providerUsageExternalLink(
  driver: ProviderDriverKind,
): ProviderUsageExternalLink | null {
  if (driver !== "grok") return null;
  return {
    href: "https://grok.com/automations?_s=usage",
    label: "View Grok usage and resets",
  };
}

const SUPPORTED_USAGE_DRIVERS = new Set(["codex", "claudeAgent", "grok"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clampPercentage(value: number): number {
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
  if (durationMinutes >= 9_000 && durationMinutes <= 11_000) return "Weekly";
  if (durationMinutes >= 270 && durationMinutes <= 330) return "5 hour";
  if (durationMinutes % 1_440 === 0) return `${durationMinutes / 1_440} day`;
  if (durationMinutes % 60 === 0) return `${durationMinutes / 60} hour`;
  return `${durationMinutes} min`;
}

function isRetiredCodexFiveHourWindow(window: ProviderUsageWindow): boolean {
  return window.label.trim().toLowerCase() === "5 hour";
}

function codexWindows(raw: unknown): ProviderUsageWindow[] {
  const envelope = asRecord(raw);
  const snapshot = asRecord(envelope?.rateLimits) ?? envelope;
  if (!snapshot) return [];

  const windows: ProviderUsageWindow[] = [];
  for (const [key, fallback] of [
    ["primary", "Primary"],
    ["secondary", "Secondary"],
  ] as const) {
    const value = asRecord(snapshot[key]);
    const usedPercent = finiteNumber(value?.usedPercent);
    if (!value || usedPercent === null) continue;
    const durationMinutes = finiteNumber(value.windowDurationMins);
    // Codex retired its five-hour limit. Older cached/provider payloads can still
    // contain the former primary window, but presenting it would be misleading.
    if (durationMinutes !== null && durationMinutes >= 270 && durationMinutes <= 330) continue;
    windows.push({
      // Codex has moved the weekly quota between `primary` and `secondary`
      // across app-server versions. Use the semantic window as the identity so
      // the same quota cannot duplicate or appear to reset during an upgrade.
      key:
        durationMinutes !== null && durationMinutes >= 9_000 && durationMinutes <= 11_000
          ? "weekly"
          : key,
      label: durationLabel(durationMinutes, fallback),
      usedPercent: clampPercentage(usedPercent),
      resetAt: epochMilliseconds(value.resetsAt),
      windowDurationMs: durationMinutes === null ? null : durationMinutes * MINUTE_MS,
    });
  }

  const individualLimit = asRecord(snapshot.individualLimit);
  const remainingPercent = finiteNumber(individualLimit?.remainingPercent);
  if (individualLimit && remainingPercent !== null) {
    const limit = typeof individualLimit.limit === "string" ? individualLimit.limit : null;
    const used = typeof individualLimit.used === "string" ? individualLimit.used : null;
    windows.push({
      key: "individual-limit",
      label: "Spend limit",
      usedPercent: clampPercentage(100 - remainingPercent),
      resetAt: epochMilliseconds(individualLimit.resetsAt),
      ...(limit && used ? { detail: `${used} of ${limit}` } : {}),
    });
  }

  const credits = asRecord(snapshot.credits);
  const creditBalance = typeof credits?.balance === "string" ? credits.balance.trim() : "";
  if (credits && (credits.unlimited === true || creditBalance)) {
    windows.push({
      key: "credits",
      label: "Credits",
      usedPercent: null,
      resetAt: null,
      detail: credits.unlimited === true ? "Unlimited" : creditBalance,
    });
  }
  return windows;
}

function codexResetCredits(raw: unknown): ProviderUsageResetCredits | null {
  const envelope = asRecord(raw);
  const summary = asRecord(envelope?.rateLimitResetCredits);
  const availableCount = finiteNumber(summary?.availableCount);
  if (!summary || availableCount === null || availableCount <= 0) return null;

  const credits = Array.isArray(summary.credits)
    ? summary.credits.flatMap((rawCredit): ProviderUsageResetCredit[] => {
        const credit = asRecord(rawCredit);
        if (!credit || credit.status !== "available" || typeof credit.id !== "string") return [];
        const title = typeof credit.title === "string" ? credit.title.trim() : "";
        const description =
          typeof credit.description === "string" && credit.description.trim()
            ? credit.description.trim()
            : null;
        return [
          {
            id: credit.id,
            title: title || "Full reset",
            description,
            expiresAt: epochMilliseconds(credit.expiresAt),
          },
        ];
      })
    : [];

  // The backend may report only the count, or cap the detail rows. Codex's
  // consume RPC intentionally accepts no credit id and selects the next one.
  if (credits.length === 0) {
    credits.push({
      id: null,
      title: availableCount === 1 ? "Full reset" : `${availableCount} full resets`,
      description: null,
      expiresAt: null,
    });
  }

  return {
    availableCount: Math.floor(availableCount),
    credits,
  };
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Quota windows are fixed-length, but providers only report when one *resets* —
 * so a window's start is recovered as `resetAt - duration`. Codex sends its
 * length outright; Claude never does, and instead the window key implies it.
 *
 * A key absent from this map has no known length, and the elapsed overlay is
 * omitted rather than guessed — a bar drawn from a wrong start would misreport
 * pace, which is the one thing it exists to show.
 */
const CLAUDE_WINDOW_DURATIONS_MS: Record<string, number> = {
  current_session: 5 * HOUR_MS,
  one_day: DAY_MS,
  daily: DAY_MS,
  seven_day: 7 * DAY_MS,
  seven_day_oauth_apps: 7 * DAY_MS,
  seven_day_opus: 7 * DAY_MS,
  seven_day_sonnet: 7 * DAY_MS,
  // Every Fable alias normalizes to this key, and all of them are weekly.
  fable: 7 * DAY_MS,
};

/**
 * How far through its window a quota is, by wall clock rather than consumption.
 *
 * Paired with `usedPercent` this is the pace read: usage ahead of elapsed time
 * means the quota is burning faster than it refills. Returns null when the
 * window length is unknown, which callers render as no overlay at all.
 */
export function resolveUsageWindowElapsedPercent({
  resetAt,
  windowDurationMs,
  nowMs,
}: {
  readonly resetAt: number | null | undefined;
  readonly windowDurationMs: number | null | undefined;
  readonly nowMs: number;
}): number | null {
  if (resetAt === null || resetAt === undefined) return null;
  if (windowDurationMs === null || windowDurationMs === undefined) return null;
  if (!Number.isFinite(resetAt) || !Number.isFinite(windowDurationMs)) return null;
  if (!Number.isFinite(nowMs) || windowDurationMs <= 0) return null;
  const elapsed = nowMs - (resetAt - windowDurationMs);
  // A stale reset time (or a clock skewed past it) must not overshoot the track.
  if (elapsed <= 0) return 0;
  if (elapsed >= windowDurationMs) return 100;
  return (elapsed / windowDurationMs) * 100;
}

/**
 * Signed wall-clock distance between the elapsed-time overlay and the current
 * usage fill. Positive means the overlay has not reached usage yet; negative
 * means it passed that point already.
 */
export function resolveUsageWindowPaceDeltaMs({
  usedPercent,
  resetAt,
  windowDurationMs,
  nowMs,
}: {
  readonly usedPercent: number | null | undefined;
  readonly resetAt: number | null | undefined;
  readonly windowDurationMs: number | null | undefined;
  readonly nowMs: number;
}): number | null {
  if (usedPercent === null || usedPercent === undefined) return null;
  if (resetAt === null || resetAt === undefined) return null;
  if (windowDurationMs === null || windowDurationMs === undefined) return null;
  if (
    !Number.isFinite(usedPercent) ||
    !Number.isFinite(resetAt) ||
    !Number.isFinite(windowDurationMs) ||
    !Number.isFinite(nowMs) ||
    windowDurationMs <= 0
  ) {
    return null;
  }

  const boundedUsedPercent = Math.max(0, Math.min(100, usedPercent));
  const windowStartAt = resetAt - windowDurationMs;
  const usagePositionAt = windowStartAt + (boundedUsedPercent / 100) * windowDurationMs;
  return usagePositionAt - nowMs;
}

export function formatUsageWindowPaceDelta(deltaMs: number | null): string | null {
  if (deltaMs === null || !Number.isFinite(deltaMs)) return null;

  const absoluteSeconds = Math.round(Math.abs(deltaMs) / 1_000);
  if (absoluteSeconds === 0) {
    return "±0s — time and usage bars meet now";
  }

  const sign = deltaMs > 0 ? "+" : "−";
  let duration: string;
  if (absoluteSeconds < 60) {
    duration = `${absoluteSeconds}s`;
  } else {
    const absoluteMinutes = Math.round(absoluteSeconds / 60);
    if (absoluteMinutes < 60) {
      duration = `${absoluteMinutes}m`;
    } else {
      const hours = Math.floor(absoluteMinutes / 60);
      const minutes = absoluteMinutes % 60;
      duration = `${hours}h${minutes === 0 ? "" : ` ${minutes}m`}`;
    }
  }

  return deltaMs > 0
    ? `${sign}${duration} until time bar reaches usage`
    : `${sign}${duration} since time bar passed usage`;
}

/**
 * Re-render on a slow cadence so the elapsed overlay keeps advancing while the
 * app sits idle. Windows run hours to days, so a minute is already far finer
 * than the bar can show and costs a single render.
 */
function useMinuteTick(): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), MINUTE_MS);
    return () => clearInterval(timer);
  }, []);
  return nowMs;
}

/**
 * The animated dotted marker showing how much of the quota window has elapsed.
 *
 * It shares the usage track so their endpoints remain directly comparable,
 * while the moving dot pattern stays visually distinct from the solid usage
 * fill. CSS disables the movement when reduced motion is requested.
 */
function UsageWindowElapsedOverlay({ elapsedPercent }: { elapsedPercent: number }) {
  return (
    <span
      aria-hidden="true"
      data-usage-window-elapsed-marker="dots"
      className="provider-usage-elapsed-dots pointer-events-none absolute inset-y-0 left-0 rounded-full"
      style={{ width: `${elapsedPercent}%` }}
    />
  );
}

function UsageWindowProgressLine({
  name,
  window,
  elapsedPercent,
  paceDelta,
  paceDescription,
}: {
  readonly name: string;
  readonly window: ProviderUsageWindow & { readonly usedPercent: number };
  readonly elapsedPercent: number | null;
  readonly paceDelta: string | null;
  readonly paceDescription: string | null;
}) {
  const line = (
    <span
      role="progressbar"
      aria-label={`${name} ${window.label} used`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(window.usedPercent)}
      {...(paceDescription === null
        ? {}
        : // aria-valuetext only — a native `title` here doubles up with the
          // custom Tooltip below and both render at once.
          { "aria-valuetext": paceDescription })}
      className="relative block h-1.5 overflow-hidden rounded-full bg-foreground/8"
    >
      <span
        className={`block h-full rounded-full ${usageProgressClass(window.usedPercent)}`}
        style={{ width: `${window.usedPercent}%` }}
      />
      {elapsedPercent === null ? null : (
        <UsageWindowElapsedOverlay elapsedPercent={elapsedPercent} />
      )}
    </span>
  );

  if (paceDelta === null) return line;

  return (
    <Tooltip>
      <TooltipTrigger render={line} />
      <TooltipPopup side="top" sideOffset={6}>
        {paceDelta}
      </TooltipPopup>
    </Tooltip>
  );
}

const CLAUDE_WINDOW_LABELS: Record<string, string> = {
  one_day: "Day",
  daily: "Day",
  current_session: "Current session",
  seven_day: "Weekly",
  seven_day_oauth_apps: "OAuth apps weekly",
  seven_day_opus: "Opus weekly",
  seven_day_sonnet: "Sonnet weekly",
  seven_day_fable: "Fable",
  model_scoped: "Fable",
  fable: "Fable",
  fable_usage: "Fable",
  overage: "Overage",
};

function normalizeClaudeWindowKey(key: string): string {
  const normalized = key
    .trim()
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .replaceAll(/[\s-]+/g, "_")
    .toLowerCase();
  // Claude has used both names for the same short account-usage window. The
  // interactive /usage UI calls it "Current session", so use that user-facing
  // terminology while retaining compatibility with older typed events.
  if (normalized === "five_hour") return "current_session";
  if (
    normalized === "seven_day_fable" ||
    normalized === "model_scoped" ||
    normalized === "fable" ||
    normalized === "fable_usage"
  ) {
    return "fable";
  }
  return normalized;
}

function claudeWindowLabel(key: string): string {
  if (CLAUDE_WINDOW_LABELS[key]) return CLAUDE_WINDOW_LABELS[key];
  if (key.toLowerCase().includes("fable")) return "Fable";
  return key.replaceAll("_", " ");
}

function claudeWindows(raw: unknown): ProviderUsageWindow[] {
  const envelope = asRecord(raw);
  const structuredRateLimits = asRecord(envelope?.rate_limits);
  if (structuredRateLimits) {
    const windows: ProviderUsageWindow[] = [];
    for (const [rawKey, rawWindow] of Object.entries(structuredRateLimits)) {
      const window = asRecord(rawWindow);
      if (!window) continue;
      const key = normalizeClaudeWindowKey(rawKey);
      const utilization = finiteNumber(window.utilization);
      const rejected = window.status === "rejected";
      if (utilization === null && !rejected) continue;
      windows.push({
        key,
        label: claudeWindowLabel(key),
        usedPercent: utilization === null ? 100 : clampPercentage(utilization),
        resetAt: epochMilliseconds(window.resets_at),
        windowDurationMs: CLAUDE_WINDOW_DURATIONS_MS[key] ?? null,
      });
    }
    const hasFableWindow = () => windows.some((window) => window.key === "fable");
    const modelScoped = structuredRateLimits.model_scoped;
    if (Array.isArray(modelScoped)) {
      for (const rawWindow of modelScoped) {
        const window = asRecord(rawWindow);
        const displayName =
          typeof window?.display_name === "string" ? window.display_name.trim() : "";
        if (!window || !/fable/i.test(displayName) || hasFableWindow()) continue;
        const utilization = finiteNumber(window.utilization);
        if (utilization === null) continue;
        windows.push({
          key: "fable",
          label: "Fable",
          usedPercent: clampPercentage(utilization),
          resetAt: epochMilliseconds(window.resets_at),
          windowDurationMs: CLAUDE_WINDOW_DURATIONS_MS.fable ?? null,
        });
      }
    }
    // Claude Code 2.1.220 also reports model-scoped limits through a generic
    // `limits` array. Keep this as a fallback because the experimental usage
    // response can expose one representation before the other.
    const limits = structuredRateLimits.limits;
    if (Array.isArray(limits) && !hasFableWindow()) {
      for (const rawLimit of limits) {
        const limit = asRecord(rawLimit);
        const scope = asRecord(limit?.scope);
        const model = asRecord(scope?.model);
        const displayName =
          typeof model?.display_name === "string" ? model.display_name.trim() : "";
        if (!limit || !/fable/i.test(displayName)) continue;
        const percent = finiteNumber(limit.percent);
        if (percent === null) continue;
        windows.push({
          key: "fable",
          label: "Fable",
          usedPercent: clampPercentage(percent),
          resetAt: epochMilliseconds(limit.resets_at),
          windowDurationMs: CLAUDE_WINDOW_DURATIONS_MS.fable ?? null,
        });
        break;
      }
    }
    return windows;
  }
  const info = asRecord(envelope?.rate_limit_info);
  const key =
    typeof info?.rateLimitType === "string" ? normalizeClaudeWindowKey(info.rateLimitType) : null;
  const utilization = finiteNumber(info?.utilization);
  const rejected = info?.status === "rejected";
  if (!key || (utilization === null && !rejected)) return [];
  const normalizedUtilization =
    utilization === null ? 100 : utilization <= 1 ? utilization * 100 : utilization;
  return [
    {
      key,
      label: claudeWindowLabel(key),
      usedPercent: clampPercentage(normalizedUtilization),
      resetAt: epochMilliseconds(info?.resetsAt ?? info?.overageResetsAt),
      windowDurationMs: CLAUDE_WINDOW_DURATIONS_MS[key] ?? null,
    },
  ];
}

function grokMoneyValue(value: unknown): number | null {
  const record = asRecord(value);
  return finiteNumber(record?.val) ?? finiteNumber(value);
}

function grokBillingConfig(raw: unknown): Record<string, unknown> | null {
  const envelope = asRecord(raw);
  if (!envelope) return null;
  return asRecord(envelope.config) ?? envelope;
}

function grokPeriodDurationMs(period: Record<string, unknown> | null): number | null {
  if (!period) return null;
  const start = epochMilliseconds(period.start);
  const end = epochMilliseconds(period.end);
  if (start === null || end === null || end <= start) return null;
  return end - start;
}

function grokPeriodLabel(period: Record<string, unknown> | null): string {
  const type = typeof period?.type === "string" ? period.type.toLowerCase() : "";
  if (type.includes("month")) return "Monthly";
  return "Weekly";
}

function grokWindows(raw: unknown): ProviderUsageWindow[] {
  const config = grokBillingConfig(raw);
  if (!config) return [];

  const windows: ProviderUsageWindow[] = [];
  const period = asRecord(config.currentPeriod);
  const reportedUsedPercent = finiteNumber(config.creditUsagePercent);
  // Grok omits protobuf scalar defaults from JSON. During a real current
  // period, a missing percentage therefore means 0% used; treating it as no
  // snapshot leaves the previous billing period stuck in persisted UI state.
  const usedPercent = reportedUsedPercent ?? (period === null ? null : 0);
  const resetAt =
    epochMilliseconds(period?.end) ??
    epochMilliseconds(config.billingPeriodEnd) ??
    epochMilliseconds(config.billingPeriodStart);
  if (usedPercent !== null) {
    windows.push({
      key: "weekly",
      label: grokPeriodLabel(period),
      usedPercent: clampPercentage(usedPercent),
      resetAt,
      windowDurationMs: grokPeriodDurationMs(period) ?? 7 * DAY_MS,
    });
  }

  const prepaid = grokMoneyValue(config.prepaidBalance);
  if (prepaid !== null && prepaid > 0) {
    windows.push({
      key: "credits",
      label: "Credits",
      usedPercent: null,
      resetAt: null,
      detail: `$${prepaid}`,
    });
  }

  const onDemandUsed = grokMoneyValue(config.onDemandUsed);
  const onDemandCap = grokMoneyValue(config.onDemandCap);
  if (onDemandUsed !== null && onDemandCap !== null && onDemandCap > 0) {
    windows.push({
      key: "on-demand",
      label: "Pay as you go",
      usedPercent: clampPercentage((onDemandUsed / onDemandCap) * 100),
      resetAt: null,
      detail: `$${onDemandUsed} of $${onDemandCap}`,
    });
  }

  return windows;
}

function usageWindowsForDriver(driver: ProviderDriverKind, raw: unknown): ProviderUsageWindow[] {
  if (driver === "codex") return codexWindows(raw);
  if (driver === "claudeAgent") return claudeWindows(raw);
  if (driver === "grok") return grokWindows(raw);
  return [];
}

export function deriveProviderUsageSummaries(
  providers: ReadonlyArray<ServerProvider>,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  persistedByAccountKey: Readonly<Record<string, PersistedProviderUsageEntry>> = {},
  now = Date.now(),
  environmentId?: EnvironmentId,
): ProviderUsageSummary[] {
  const enabledProviders = providers.filter((provider) => provider.enabled);
  const reportsByAccountKey = deriveProviderUsageReports(
    enabledProviders,
    activities,
    environmentId,
  );

  return enabledProviders.map((provider) => {
    const accountKey = providerUsageAccountKey(provider, environmentId);
    const currentReport = accountKey === null ? undefined : reportsByAccountKey[accountKey];
    const effectiveReports =
      currentReport === undefined
        ? persistedByAccountKey
        : mergeProviderUsageEntry(persistedByAccountKey, currentReport);
    const report = accountKey === null ? undefined : effectiveReports[accountKey];
    const windows = [...(report?.windows ?? [])].filter(
      (window) => provider.driver !== "codex" || !isRetiredCodexFiveHourWindow(window),
    );
    const supported = SUPPORTED_USAGE_DRIVERS.has(provider.driver);
    const stale =
      report !== undefined && now - Date.parse(report.reportedAt) > PROVIDER_USAGE_STALE_AFTER_MS;
    const resetCredits = activeResetCredits(report?.resetCredits, now);
    return {
      provider,
      accountKey,
      state:
        windows.length > 0 || resetCredits !== null
          ? stale
            ? "stale"
            : "available"
          : supported
            ? "unavailable"
            : "unsupported",
      windows,
      reportedAt: report?.reportedAt ?? null,
      resetCredits,
    };
  });
}

export function deriveProviderUsageReports(
  providers: ReadonlyArray<ServerProvider>,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  environmentId?: EnvironmentId,
): Readonly<Record<string, PersistedProviderUsageEntry>> {
  const enabledProviders = providers.filter((provider) => provider.enabled);
  let reports: Readonly<Record<string, PersistedProviderUsageEntry>> = {};
  const record = (provider: ServerProvider, raw: unknown, reportedAt: string) => {
    const accountKey = providerUsageAccountKey(provider, environmentId);
    if (accountKey === null) return;
    const windows = usageWindowsForDriver(provider.driver, raw);
    const resetCredits = provider.driver === "codex" ? codexResetCredits(raw) : null;
    if (windows.length === 0 && resetCredits === null) return;
    reports = mergeProviderUsageEntry(reports, {
      accountKey,
      driver: provider.driver,
      windows,
      reportedAt,
      // Codex is the only driver that has resets, so its `null` is the
      // provider answering "none" and must be sent through. Omitting the key
      // for every other driver keeps "no reset data in this report" distinct
      // from "there are no resets", which is what the merge keys its
      // hysteresis on.
      ...(provider.driver === "codex" ? { resetCredits } : {}),
    });
  };

  for (const provider of enabledProviders) {
    if (provider.accountUsage !== undefined && provider.accountUsageReportedAt !== undefined) {
      record(provider, provider.accountUsage, provider.accountUsageReportedAt);
    }
  }

  const sortedActivities = activities
    .filter((activity) => activity.kind === "provider.usage.updated")
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));

  for (const activity of sortedActivities) {
    const payload = asRecord(activity.payload);
    if (!payload) continue;
    const rawDriver = payload?.provider;
    if (typeof rawDriver !== "string") continue;
    const explicitInstanceId =
      typeof payload.providerInstanceId === "string"
        ? (payload.providerInstanceId as ProviderInstanceId)
        : null;
    const matchingDriverProviders = enabledProviders.filter(
      (candidate) => candidate.driver === rawDriver,
    );
    const provider = explicitInstanceId
      ? matchingDriverProviders.find((candidate) => candidate.instanceId === explicitInstanceId)
      : matchingDriverProviders.length === 1
        ? matchingDriverProviders[0]
        : undefined;
    if (!provider) continue;
    record(provider, payload.rateLimits, activity.createdAt);
  }

  return reports;
}

const USAGE_CARD_ACTION_CLASS =
  "inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-[var(--line)] bg-surface-row px-2.5 font-medium text-[11px] text-foreground/80 transition-[background-color,border-color,color] duration-150 hover:border-gold-500/50 hover:bg-gold-500/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-500/40 disabled:cursor-wait disabled:opacity-60";

function formatRemaining(resetAt: number | null, nowMs: number): string | null {
  if (resetAt === null) return null;
  const remainingMs = resetAt - nowMs;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h left`;
  if (hours > 0) return `${hours}h ${minutes}m left`;
  return `${minutes}m left`;
}

function formatReset(resetAt: number | null): string | null {
  if (resetAt === null) return null;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(resetAt));
}

function usageResetOutcomeResult(outcome: ProviderUsageResetOutcome): {
  readonly status: "success" | "error";
  readonly message: string;
} {
  switch (outcome) {
    case "reset":
      return { status: "success", message: "Usage limits reset successfully." };
    case "nothingToReset":
      return {
        status: "success",
        message: "Your usage is already available, so the reset was not spent.",
      };
    case "noCredit":
      return { status: "error", message: "No usage reset is currently available." };
    case "alreadyRedeemed":
      return { status: "error", message: "That usage reset was already redeemed." };
  }
}

function formatReportedAt(reportedAt: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(reportedAt));
}

export type UsageThreshold = "neutral" | "warning" | "critical";

export function usageThreshold(usedPercent: number): UsageThreshold {
  if (usedPercent >= 75) return "critical";
  if (usedPercent >= 50) return "warning";
  return "neutral";
}

function usageProgressClass(usedPercent: number): string {
  switch (usageThreshold(usedPercent)) {
    case "critical":
      return "bg-red-600 dark:bg-red-400";
    case "warning":
      return "bg-amber-500 dark:bg-amber-400";
    case "neutral":
      return "bg-gold-500";
  }
}

function usageValueClass(usedPercent: number): string {
  switch (usageThreshold(usedPercent)) {
    case "critical":
      return "text-red-700 dark:text-red-300";
    case "warning":
      return "text-amber-700 dark:text-amber-300";
    case "neutral":
      return "text-foreground/80";
  }
}

function usageDetail(window: ProviderUsageWindow): string {
  return window.usedPercent === null
    ? (window.detail ?? "Available")
    : `${Math.round(window.usedPercent)}% used`;
}

interface CompactProviderUsageMetric {
  label: string;
  window: ProviderUsageWindow | null;
}

function maxReportedUsageWindow(
  left: ProviderUsageWindow | null,
  right: ProviderUsageWindow | null,
): ProviderUsageWindow | null {
  if (left === null || left.usedPercent === null) {
    return right === null || right.usedPercent === null ? null : right;
  }
  if (right === null || right.usedPercent === null) return left;
  return right.usedPercent > left.usedPercent ? right : left;
}

export function compactProviderUsageMetric(
  summary: ProviderUsageSummary,
  selectedModelSelection: ModelSelection | null = null,
): CompactProviderUsageMetric | null {
  if (
    summary.provider.driver !== "claudeAgent" &&
    summary.provider.driver !== "codex" &&
    summary.provider.driver !== "grok"
  ) {
    return null;
  }

  if (summary.provider.driver === "claudeAgent") {
    const [currentSession, weekly, fable] = claudePopupWindows(summary.windows);
    const fableSelected =
      selectedModelSelection?.instanceId === summary.provider.instanceId &&
      isClaudeFableModel(selectedModelSelection.model);
    // Current-session and weekly limits apply to every Claude model. Fable
    // adds a model-scoped limit; it never replaces the account-wide weekly
    // limit. Show whichever applicable quota is closest to exhaustion.
    const highestAccountWindow = maxReportedUsageWindow(currentSession ?? null, weekly ?? null);
    const highestClaudeWindow = fableSelected
      ? maxReportedUsageWindow(highestAccountWindow, fable ?? null)
      : highestAccountWindow;
    return {
      label: highestClaudeWindow?.label ?? "Current session",
      window: highestClaudeWindow,
    };
  }

  const highestReportedWindow = summary.windows.reduce<ProviderUsageWindow | null>(
    (highest, candidate) => maxReportedUsageWindow(highest, candidate),
    null,
  );
  if (highestReportedWindow) {
    return {
      label: highestReportedWindow.label,
      window: highestReportedWindow,
    };
  }

  const weekly =
    summary.windows.find((window) => window.label.trim().toLowerCase() === "weekly") ?? null;
  return {
    label: "Weekly",
    window: weekly,
  };
}

/** Exported so the voice orchestrator names a provider the same way this does. */
export function providerUsageName(provider: ServerProvider): string {
  if (provider.driver === "claudeAgent") return "Claude";
  return provider.displayName?.trim() || String(provider.driver);
}

/**
 * Claude meters the Fable family (`claude-fable-5`, `claude-fable-5-1`, and a
 * hand-typed custom id such as `fable-5.1`) against its own quota window.
 */
export function isClaudeFableModel(model: string): boolean {
  return model.trim().toLowerCase().includes("fable");
}

export function claudePopupWindows(
  windows: ReadonlyArray<ProviderUsageWindow>,
): ProviderUsageWindow[] {
  const currentSession = windows.find((window) => window.key === "current_session");
  const weekly = windows.find(
    (window) => window.key === "seven_day" || window.label.trim().toLowerCase() === "weekly",
  );
  const fable = windows.find(
    (window) => window.key === "fable" || window.label.trim().toLowerCase() === "fable",
  );
  return [
    currentSession ?? {
      key: "current_session",
      label: "Current session",
      usedPercent: null,
      resetAt: null,
      detail: "Not reported",
    },
    weekly ?? {
      key: "seven_day",
      label: "Weekly",
      usedPercent: null,
      resetAt: null,
      detail: "Not reported",
    },
    fable ?? {
      key: "fable",
      label: "Fable",
      usedPercent: null,
      resetAt: null,
      detail: "Not reported",
    },
  ];
}

export function ProviderUsageDetails({
  name,
  state,
  windows,
  reportedAt,
  onRefresh,
  isRefreshing = false,
  refreshError = null,
  onSwitchUser,
  resetCredits = null,
  onUseReset,
  onDismissResetCredit,
  externalUsageLink = null,
  creditsOnly = false,
}: Pick<ProviderUsageSummary, "state" | "windows" | "reportedAt"> & {
  name: string;
  /** Skip the header and window bars; render only reset credits and the external link. */
  creditsOnly?: boolean;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  refreshError?: string | null;
  onSwitchUser?: () => void;
  resetCredits?: ProviderUsageResetCredits | null;
  externalUsageLink?: ProviderUsageExternalLink | null;
  onUseReset?: (
    creditId: string | undefined,
    idempotencyKey: string,
  ) => Promise<ProviderUsageResetOutcome>;
  onDismissResetCredit?: (credit: ProviderUsageResetCredit) => void;
}) {
  const nowMs = useMinuteTick();
  const [pendingResetAttempt, setPendingResetAttempt] = useState<{
    readonly credit: ProviderUsageResetCredit;
    readonly idempotencyKey: string;
  } | null>(null);
  const [resetRequestState, setResetRequestState] = useState<
    | { readonly status: "idle"; readonly message: null }
    | { readonly status: "loading"; readonly message: null }
    | { readonly status: "success" | "error"; readonly message: string }
  >({ status: "idle", message: null });
  const confirmUsageReset = () => {
    if (!onUseReset || !pendingResetAttempt || resetRequestState.status === "loading") return;
    setResetRequestState({ status: "loading", message: null });
    void onUseReset(
      pendingResetAttempt.credit.id ?? undefined,
      pendingResetAttempt.idempotencyKey,
    ).then(
      (outcome) => {
        onDismissResetCredit?.(pendingResetAttempt.credit);
        setResetRequestState(usageResetOutcomeResult(outcome));
        setPendingResetAttempt(null);
      },
      () => {
        setResetRequestState({
          status: "error",
          message: "Usage reset was not confirmed. Retry to safely check the same request.",
        });
      },
    );
  };
  const hasUsage = windows.length > 0;
  const visibleState = isRefreshing ? "loading" : state;
  // Deliberately read `state`, not `visibleState`: a refresh must not add,
  // remove or relabel this badge. Every one of those reflows the header and
  // shoves the numbers underneath it around, which is the whole reason the
  // refresh lives in a corner instead of over the figures it is updating.
  const statusLabel =
    state === "stale"
      ? "Stale"
      : state === "unavailable"
        ? "Unavailable"
        : state === "unsupported"
          ? "Unsupported"
          : null;
  return (
    <div
      // Fills whichever container it is placed in rather than carrying its own
      // fixed width. The popover wrapper is `w-80`, so a `w-72` here left 32px
      // of dead space down the right-hand side on top of the viewport padding,
      // making the card look badly misaligned. In settings it was likewise
      // narrower than the section holding it.
      className="w-full"
      data-provider-usage-state={visibleState}
      aria-busy={isRefreshing || undefined}
    >
      {creditsOnly ? null : (
        <>
          <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
            <div className="min-w-0 flex-1">
              <h3 className="font-semibold text-[13px] text-foreground leading-tight tracking-[-0.01em]">
                {name} usage
              </h3>
              <p className="mt-0.5 text-[11px] text-muted-foreground leading-snug">
                {reportedAt
                  ? `${state === "stale" ? "Last reported" : "Reported"} ${formatReportedAt(reportedAt)}`
                  : "Account-level provider usage"}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              {statusLabel ? (
                <span
                  className={`inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-full px-2 font-medium text-[11px] ${
                    state === "stale"
                      ? "bg-amber-500/12 text-amber-700 dark:text-amber-300"
                      : "bg-foreground/6 text-muted-foreground"
                  }`}
                >
                  {statusLabel}
                </span>
              ) : null}
              {onRefresh ? (
                <button
                  type="button"
                  onClick={onRefresh}
                  disabled={isRefreshing}
                  aria-label={`Refresh ${name} usage`}
                  aria-busy={isRefreshing}
                  className={USAGE_CARD_ACTION_CLASS}
                >
                  <RefreshCwIcon
                    className={`size-3 ${isRefreshing ? "animate-spin" : ""}`}
                    aria-hidden
                  />
                  <span>Refresh</span>
                </button>
              ) : null}
              {onSwitchUser ? (
                <button type="button" onClick={onSwitchUser} className={USAGE_CARD_ACTION_CLASS}>
                  <UserRoundIcon className="size-3" aria-hidden />
                  <span>Switch user</span>
                </button>
              ) : null}
            </div>
          </header>
          {refreshError ? (
            <p
              className="mt-2 rounded-[8px] border border-red-500/30 bg-red-500/8 px-2.5 py-1.5 text-[11px] text-red-700 leading-snug dark:text-red-300"
              role="alert"
            >
              {refreshError}
            </p>
          ) : null}
          {hasUsage ? (
            <ul className="mt-3 space-y-2" aria-label={`${name} usage windows`}>
              {windows.map((window) => {
                const reset = formatReset(window.resetAt);
                const remaining = formatRemaining(window.resetAt, nowMs);
                const detail = usageDetail(window);
                const elapsedPercent = resolveUsageWindowElapsedPercent({
                  resetAt: window.resetAt,
                  windowDurationMs: window.windowDurationMs,
                  nowMs,
                });
                const paceDelta = formatUsageWindowPaceDelta(
                  resolveUsageWindowPaceDeltaMs({
                    usedPercent: window.usedPercent,
                    resetAt: window.resetAt,
                    windowDurationMs: window.windowDurationMs,
                    nowMs,
                  }),
                );
                const paceDescription =
                  elapsedPercent === null
                    ? null
                    : `${Math.round(window.usedPercent ?? 0)}% used · ${Math.round(elapsedPercent)}% of the window elapsed${paceDelta === null ? "" : ` · ${paceDelta}`}`;
                return (
                  <li
                    key={window.key}
                    className="rounded-[10px] border border-[var(--line)] bg-surface-row/60 px-3 py-2.5"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 break-words font-medium text-[12.5px] text-foreground leading-snug">
                        {titleCaseUsageLabel(window.label)}
                      </span>
                      <span
                        className={`shrink-0 whitespace-nowrap font-mono text-[12px] tabular-nums ${
                          window.usedPercent === null
                            ? "text-muted-foreground"
                            : usageValueClass(window.usedPercent)
                        }`}
                      >
                        {detail}
                      </span>
                    </div>
                    {window.usedPercent !== null ? (
                      <div className="mt-2">
                        <UsageWindowProgressLine
                          name={name}
                          window={{ ...window, usedPercent: window.usedPercent }}
                          elapsedPercent={elapsedPercent}
                          paceDelta={paceDelta}
                          paceDescription={paceDescription}
                        />
                      </div>
                    ) : null}
                    {reset ? (
                      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground tabular-nums">
                        <span>{remaining ?? ""}</span>
                        <span className="whitespace-nowrap">Resets {reset}</span>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-3 rounded-[10px] border border-[var(--line)] border-dashed px-3 py-3 text-center text-[11.5px] text-muted-foreground leading-snug">
              {state === "unsupported"
                ? "This provider does not expose account usage."
                : "Usage has not been reported for this provider account yet."}
            </p>
          )}
        </>
      )}
      {resetCredits ? (
        <section
          className="mt-4 border-[var(--line)] border-t pt-3"
          aria-label={`${name} usage resets`}
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <h4 className="font-medium text-[12.5px] text-foreground">Usage limit resets</h4>
              <p className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
                {resetCredits.availableCount} available
              </p>
            </div>
          </div>
          <ul className="mt-2 space-y-2">
            {resetCredits.credits.map((credit, index) => {
              const expires = formatReset(credit.expiresAt);
              return (
                <li
                  key={credit.id ?? `next-reset-${index}`}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-[10px] border border-[var(--line)] bg-surface-row/60 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-foreground text-xs">
                      {credit.title}
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {expires ? `Expires ${expires}` : (credit.description ?? "Ready to redeem")}
                    </div>
                  </div>
                  {onUseReset ? (
                    pendingResetAttempt?.credit === credit ? (
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          disabled={resetRequestState.status === "loading"}
                          onClick={() => setPendingResetAttempt(null)}
                        >
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={resetRequestState.status === "loading"}
                          onClick={confirmUsageReset}
                        >
                          {resetRequestState.status === "loading" ? "Using…" : "Confirm"}
                        </Button>
                      </div>
                    ) : (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={resetRequestState.status === "loading"}
                        onClick={() => {
                          setPendingResetAttempt({ credit, idempotencyKey: randomUUID() });
                          setResetRequestState({ status: "idle", message: null });
                        }}
                      >
                        Use reset
                      </Button>
                    )
                  ) : null}
                </li>
              );
            })}
          </ul>
          {resetRequestState.message ? (
            <p
              className={`mt-2 text-xs ${
                resetRequestState.status === "error"
                  ? "text-red-700 dark:text-red-300"
                  : "text-emerald-700 dark:text-emerald-300"
              }`}
              role={resetRequestState.status === "error" ? "alert" : "status"}
            >
              {resetRequestState.message}
            </p>
          ) : null}
        </section>
      ) : null}
      {externalUsageLink ? (
        <Button
          size="xs"
          variant="link"
          className="mt-3 h-auto justify-start px-0 text-[11.5px] text-gold-700 hover:text-gold-800 dark:text-gold-300 dark:hover:text-gold-200"
          render={
            <a
              href={externalUsageLink.href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${externalUsageLink.label} (opens in a new tab)`}
            />
          }
        >
          {externalUsageLink.label}
          <ExternalLinkIcon className="size-3" aria-hidden />
        </Button>
      ) : null}
    </div>
  );
}

export function ProviderUsageBadgeDetails(props: {
  readonly summary: ProviderUsageSummary;
  readonly onRefreshProvider?: (provider: ServerProvider) => Promise<void>;
  readonly onSwitchUser?: (instanceId: ProviderInstanceId) => void;
  readonly onUseReset?: (
    provider: ServerProvider,
    creditId: string | undefined,
    idempotencyKey: string,
  ) => Promise<ProviderUsageResetOutcome>;
  readonly onDismissResetCredit?: (credit: ProviderUsageResetCredit) => void;
}) {
  const { summary, onRefreshProvider, onSwitchUser, onUseReset, onDismissResetCredit } = props;
  const { provider } = summary;
  const name = providerUsageName(provider);
  const windows =
    provider.driver === "claudeAgent" ? claudePopupWindows(summary.windows) : summary.windows;
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refreshInFlightRef = useRef(false);
  const canRefresh = onRefreshProvider !== undefined;
  useEffect(() => {
    setRefreshError(null);
  }, [summary.reportedAt]);
  const refreshUsage = async () => {
    if (!onRefreshProvider || !canRefresh || refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    setIsRefreshing(true);
    setRefreshError(null);
    try {
      await onRefreshProvider(provider);
    } catch {
      setRefreshError("Usage refresh failed. Try again shortly.");
    } finally {
      refreshInFlightRef.current = false;
      setIsRefreshing(false);
    }
  };

  return (
    <div
      data-provider-usage-card-count="1"
      className="max-h-[min(36rem,calc(100vh-2rem))] w-80 max-w-[calc(100vw-1rem)] overflow-y-auto"
    >
      <section data-provider-usage-card={name} data-provider-instance-id={provider.instanceId}>
        <ProviderUsageDetails
          name={name}
          state={summary.state}
          windows={[...windows]}
          reportedAt={summary.reportedAt}
          resetCredits={summary.resetCredits ?? null}
          externalUsageLink={providerUsageExternalLink(provider.driver)}
          isRefreshing={isRefreshing}
          refreshError={refreshError}
          {...(canRefresh ? { onRefresh: () => void refreshUsage() } : {})}
          {...(onSwitchUser ? { onSwitchUser: () => onSwitchUser(provider.instanceId) } : {})}
          {...(onUseReset
            ? {
                onUseReset: (creditId: string | undefined, idempotencyKey: string) =>
                  onUseReset(provider, creditId, idempotencyKey),
              }
            : {})}
          {...(onDismissResetCredit ? { onDismissResetCredit } : {})}
        />
      </section>
    </div>
  );
}

/**
 * Desktop may open the usage popup on hover. It must not open on focus:
 * dismissing it returns focus to the chip, which would immediately reopen
 * the popup until the chip is clicked again. Coarse pointers stay tap-to-toggle.
 */
export function providerUsageBadgeTriggerOpen(hoverCapable: boolean): {
  readonly openOnHover: boolean;
} {
  return { openOnHover: hoverCapable };
}

function ProviderUsageBadge({
  summary,
  compactMetric,
  detailsSide,
  onRefreshProvider,
  onSwitchUser,
  onUseReset,
  onDismissResetCredit,
}: {
  summary: ProviderUsageSummary;
  compactMetric: CompactProviderUsageMetric;
  detailsSide: "top" | "bottom";
  onRefreshProvider?: (provider: ServerProvider) => Promise<void>;
  onSwitchUser?: (instanceId: ProviderInstanceId) => void;
  onUseReset?: (
    provider: ServerProvider,
    creditId: string | undefined,
    idempotencyKey: string,
  ) => Promise<ProviderUsageResetOutcome>;
  onDismissResetCredit?: (credit: ProviderUsageResetCredit) => void;
}) {
  const nowMs = useMinuteTick();
  const [open, setOpen] = useState(false);
  const hoverCapable = useMediaQuery("(hover: hover) and (pointer: fine)");
  const triggerOpen = providerUsageBadgeTriggerOpen(hoverCapable);
  const { provider } = summary;
  const name = providerUsageName(provider);
  const usageDetailsLabel =
    provider.driver === "claudeAgent" ? "Claude usage details" : `${name} account usage details`;
  const compactUsedPercent = compactMetric.window?.usedPercent ?? null;
  const compactRoundedUsedPercent =
    compactUsedPercent === null ? null : Math.round(compactUsedPercent);
  const compactElapsedPercent = resolveUsageWindowElapsedPercent({
    resetAt: compactMetric.window?.resetAt ?? null,
    windowDurationMs: compactMetric.window?.windowDurationMs ?? null,
    nowMs,
  });
  const compactPaceDelta = formatUsageWindowPaceDelta(
    resolveUsageWindowPaceDeltaMs({
      usedPercent: compactUsedPercent,
      resetAt: compactMetric.window?.resetAt ?? null,
      windowDurationMs: compactMetric.window?.windowDurationMs ?? null,
      nowMs,
    }),
  );
  const compactUsageLabel = `${name} ${compactMetric.label}`;
  const compactStatus =
    compactRoundedUsedPercent === null ? "not reported" : `${compactRoundedUsedPercent}% used`;
  // The overlay encodes pace visually; state it in text too, so the comparison
  // is available to screen readers and on hover rather than by color alone.
  const compactStatusWithPace =
    compactElapsedPercent === null
      ? compactStatus
      : `${compactStatus}, ${Math.round(compactElapsedPercent)}% of the window elapsed${
          compactPaceDelta === null ? "" : `, ${compactPaceDelta}`
        }`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        openOnHover={triggerOpen.openOnHover}
        delay={150}
        closeDelay={150}
        aria-label={`Show ${usageDetailsLabel}; ${compactUsageLabel}: ${compactStatusWithPace}`}
        data-provider-usage-compact-driver={provider.driver}
        className="flex min-h-6 shrink-0 items-center gap-1.5 rounded-full px-1 outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ProviderInstanceIcon
          driverKind={provider.driver}
          displayName={name}
          accentColor={provider.accentColor}
          className="size-4"
          iconClassName="size-3.5"
        />
        <span
          className={`font-medium tabular-nums ${
            compactUsedPercent === null
              ? "text-muted-foreground/70"
              : usageValueClass(compactUsedPercent)
          }`}
        >
          {compactRoundedUsedPercent === null ? "—" : `${compactRoundedUsedPercent}%`}
        </span>
        {compactUsedPercent !== null && compactRoundedUsedPercent !== null ? (
          <span
            role="progressbar"
            aria-label={`${compactUsageLabel} used`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(compactUsedPercent)}
            className="relative h-1 w-7 overflow-hidden rounded-full bg-foreground/10 sm:w-8"
          >
            <span
              className={`block h-full rounded-full ${usageProgressClass(compactUsedPercent)}`}
              style={{ width: `${compactUsedPercent}%` }}
            />
            {compactElapsedPercent === null ? null : (
              <UsageWindowElapsedOverlay elapsedPercent={compactElapsedPercent} />
            )}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        side={detailsSide}
        sideOffset={8}
        aria-label={usageDetailsLabel}
        className="border border-gold-500/30 bg-popover shadow-[0_24px_64px_-24px_rgba(0,0,0,0.75),0_0_0_1px_rgba(217,169,58,0.06)]"
      >
        <ProviderUsageBadgeDetails
          summary={summary}
          {...(onRefreshProvider ? { onRefreshProvider } : {})}
          {...(onSwitchUser ? { onSwitchUser } : {})}
          {...(onUseReset ? { onUseReset } : {})}
          {...(onDismissResetCredit ? { onDismissResetCredit } : {})}
        />
      </PopoverPopup>
    </Popover>
  );
}

export function ProviderUsageBar(props: {
  environmentId: EnvironmentId;
  providers: ReadonlyArray<ServerProvider>;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  selectedModelSelection?: ModelSelection | null;
  detailsSide?: "top" | "bottom";
  onRefreshProvider?: (provider: ServerProvider) => Promise<void>;
  onSwitchUser?: (instanceId: ProviderInstanceId) => void;
  onUseReset?: (
    provider: ServerProvider,
    creditId: string | undefined,
    idempotencyKey: string,
  ) => Promise<ProviderUsageResetOutcome>;
}) {
  const persistedByAccountKey = useProviderUsageStore((state) => state.byAccountKey);
  const recordUsage = useProviderUsageStore((state) => state.record);
  const dismissResetCredit = useProviderUsageStore((state) => state.dismissResetCredit);
  const reports = useMemo(
    () => deriveProviderUsageReports(props.providers, props.activities, props.environmentId),
    [props.activities, props.environmentId, props.providers],
  );
  useEffect(() => {
    for (const report of Object.values(reports)) recordUsage(report);
  }, [recordUsage, reports]);
  const summaries = deriveProviderUsageSummaries(
    props.providers,
    props.activities,
    persistedByAccountKey,
    Date.now(),
    props.environmentId,
  );
  const compactEntries = summaries.flatMap((summary) => {
    const compactMetric = compactProviderUsageMetric(summary, props.selectedModelSelection ?? null);
    return compactMetric ? [{ summary, compactMetric }] : [];
  });
  if (compactEntries.length === 0) return null;

  return (
    <section
      aria-label="Provider usage"
      data-chat-composer-provider-usage="true"
      className="pointer-events-auto mx-auto flex w-fit shrink-0 items-center gap-1.5 rounded-full border border-border/65 bg-background/95 px-2 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur"
    >
      {compactEntries.map(({ summary, compactMetric }) => (
        <ProviderUsageBadge
          key={summary.provider.instanceId}
          summary={summary}
          compactMetric={compactMetric}
          detailsSide={props.detailsSide ?? "top"}
          {...(props.onRefreshProvider ? { onRefreshProvider: props.onRefreshProvider } : {})}
          {...(props.onSwitchUser ? { onSwitchUser: props.onSwitchUser } : {})}
          {...(props.onUseReset ? { onUseReset: props.onUseReset } : {})}
          {...(summary.accountKey
            ? {
                onDismissResetCredit: (credit: ProviderUsageResetCredit) => {
                  if (summary.accountKey) dismissResetCredit(summary.accountKey, credit);
                },
              }
            : {})}
        />
      ))}
    </section>
  );
}
