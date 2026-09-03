import { ExternalLinkIcon, LoaderIcon, RefreshCwIcon } from "lucide-react";
import { useMemo } from "react";
import type {
  ProviderDriverKind,
  ProviderUsageResetOutcome,
  ServerProvider,
} from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { formatTokens, formatUsd } from "../../orchestrator/usageTracking";
import {
  digestProviderUsage,
  totalTokens,
  type UsageDayBucket,
  type UsageTotals,
} from "../../providerUsageLedger";
import { useProviderUsageLedgerStore } from "../../providerUsageLedgerStore";
import { useProviderUsageStore } from "../../providerUsageStore";
import {
  ProviderUsageDetails,
  providerUsageExternalLink,
  titleCaseUsageLabel,
  type ProviderUsageResetCredit,
  type ProviderUsageSummary,
  type ProviderUsageWindow,
} from "../chat/ProviderUsageBar";
import { Button } from "../ui/button";
import { isProviderUsageRefreshEligible } from "./providerUsageRefresh";
import { useRelativeTimeTick } from "./settingsLayout";

export type ProviderUsageRefreshState =
  | { readonly status: "idle"; readonly error: null }
  | { readonly status: "loading"; readonly error: null }
  | { readonly status: "error"; readonly error: string };

export const IDLE_PROVIDER_USAGE_REFRESH_STATE: ProviderUsageRefreshState = {
  status: "idle",
  error: null,
};

export function shouldShowProviderSettingsUsage(
  driverKind: ProviderDriverKind,
  summary: ProviderUsageSummary | undefined,
): boolean {
  const supportedDriver =
    driverKind === "codex" || driverKind === "claudeAgent" || driverKind === "grok";
  return supportedDriver && summary?.state !== "unsupported";
}

// ── Formatting ───────────────────────────────────────────────────

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const dayFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});

function formatAt(value: string | number | null): string | null {
  if (value === null) return null;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? timeFormatter.format(ms) : null;
}

function formatDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) return day;
  return dayFormatter.format(new Date(year, month - 1, date));
}

function formatCountdown(resetAt: number | null, nowMs: number): string | null {
  if (resetAt === null) return null;
  const remainingMs = resetAt - nowMs;
  if (remainingMs <= 0) return "resetting now";
  const minutes = Math.round(remainingMs / 60_000);
  if (minutes < 60) return `resets in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `resets in ${hours} h`;
  return `resets in ${Math.round(hours / 24)} d`;
}

/** The headline window: whichever quota is closest to its limit. */
export function pickHeadlineWindow(
  windows: ReadonlyArray<ProviderUsageWindow>,
): ProviderUsageWindow | null {
  let best: ProviderUsageWindow | null = null;
  for (const window of windows) {
    if (window.usedPercent === null) continue;
    if (best === null || (best.usedPercent ?? 0) < window.usedPercent) best = window;
  }
  return best;
}

function usageTone(usedPercent: number): "calm" | "warm" | "hot" {
  if (usedPercent >= 90) return "hot";
  if (usedPercent >= 70) return "warm";
  return "calm";
}

const TONE_BAR: Record<ReturnType<typeof usageTone>, string> = {
  calm: "bg-gold-500",
  warm: "bg-amber-400",
  hot: "bg-red-400",
};
const TONE_TEXT: Record<ReturnType<typeof usageTone>, string> = {
  calm: "text-gold-700 dark:text-gold-300",
  warm: "text-amber-700 dark:text-amber-300",
  hot: "text-red-700 dark:text-red-300",
};

// ── Header badge ────────────────────────────────────────────────

/** Ring plus percentage for the provider card header: the quota nearest its limit. */
export function ProviderUsageBadge({
  summary,
}: {
  readonly summary: ProviderUsageSummary | undefined;
}) {
  const headline = summary ? pickHeadlineWindow(summary.windows) : null;
  if (!headline || headline.usedPercent === null) {
    return <span>Usage</span>;
  }
  const percent = Math.min(100, Math.max(0, Math.round(headline.usedPercent)));
  const tone = usageTone(percent);
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  return (
    <span className="inline-flex items-center gap-1.5" data-testid="provider-usage-badge">
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="-rotate-90">
        <circle
          cx="8"
          cy="8"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.18"
          strokeWidth="2"
        />
        <circle
          cx="8"
          cy="8"
          r={radius}
          fill="none"
          className={TONE_TEXT[tone]}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - percent / 100)}
        />
      </svg>
      <span className="tabular-nums">
        {percent}%{" "}
        <span className="font-normal text-muted-foreground">
          {titleCaseUsageLabel(headline.label)}
        </span>
      </span>
    </span>
  );
}

// ── Quota windows ───────────────────────────────────────────────

function QuotaWindow({ window, nowMs }: { window: ProviderUsageWindow; nowMs: number }) {
  const used = window.usedPercent === null ? null : Math.min(100, Math.max(0, window.usedPercent));
  const tone = used === null ? "calm" : usageTone(used);
  const elapsed =
    window.resetAt !== null && window.windowDurationMs
      ? Math.min(100, Math.max(0, (1 - (window.resetAt - nowMs) / window.windowDurationMs) * 100))
      : null;
  const countdown = formatCountdown(window.resetAt, nowMs);
  const resetLabel = formatAt(window.resetAt);
  return (
    <li className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-medium text-foreground">
          {titleCaseUsageLabel(window.label)}
        </span>
        <span
          className={cn(
            "font-mono text-[12px] tabular-nums",
            used === null ? "text-muted-foreground" : TONE_TEXT[tone],
          )}
        >
          {used === null ? (window.detail ?? "—") : `${Math.round(used)}% used`}
        </span>
      </div>
      {used !== null ? (
        <div
          role="progressbar"
          aria-label={`${window.label} usage`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(used)}
          className="relative h-1.5 overflow-hidden rounded-full bg-foreground/8"
        >
          <div
            className={cn("h-full rounded-full transition-[width] duration-300", TONE_BAR[tone])}
            style={{ width: `${used}%` }}
          />
          {elapsed !== null ? (
            <div
              aria-hidden
              title={`${Math.round(elapsed)}% of the window elapsed`}
              className="absolute inset-y-0 w-px bg-foreground/60"
              style={{ left: `${elapsed}%` }}
            />
          ) : null}
        </div>
      ) : null}
      {countdown || resetLabel ? (
        <div className="flex justify-between text-[11px] text-muted-foreground">
          <span>{countdown ? countdown.charAt(0).toUpperCase() + countdown.slice(1) : ""}</span>
          <span>{resetLabel ? `Resets ${resetLabel}` : ""}</span>
        </div>
      ) : null}
    </li>
  );
}

// ── Activity on this device ─────────────────────────────────────

function StatCard({ label, totals }: { label: string; totals: UsageTotals }) {
  return (
    <div className="rounded-[10px] border border-[var(--line)] bg-surface-row px-3 py-2.5">
      <div className="text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </div>
      <div className="mt-1 font-mono text-[17px] leading-none tabular-nums text-foreground">
        {formatTokens(totalTokens(totals))}
        <span className="ml-1 text-[11px] text-muted-foreground">tokens</span>
      </div>
      <div className="mt-1.5 text-[11px] tabular-nums text-muted-foreground">
        {totals.turns} {totals.turns === 1 ? "turn" : "turns"} · {formatUsd(totals.costUsd)}
      </div>
    </div>
  );
}

function DailyChart({ days }: { days: ReadonlyArray<UsageDayBucket> }) {
  const ordered = days.toReversed();
  const peak = Math.max(1, ...ordered.map((day) => totalTokens(day)));
  return (
    <div className="flex h-16 items-end gap-1" role="img" aria-label="Tokens per day, last 14 days">
      {ordered.map((day) => {
        const value = totalTokens(day);
        const height = value === 0 ? 2 : Math.max(3, Math.round((value / peak) * 60));
        return (
          <div
            key={day.day}
            title={`${formatDay(day.day)} · ${formatTokens(value)} tokens · ${day.turns} turns`}
            className="flex flex-1 flex-col justify-end"
          >
            <div
              className={cn("rounded-t-[3px]", value === 0 ? "bg-foreground/10" : "bg-gold-500/85")}
              style={{ height: `${height}px` }}
            />
          </div>
        );
      })}
    </div>
  );
}

function DailyTable({ days }: { days: ReadonlyArray<UsageDayBucket> }) {
  const rows = days.filter((day) => day.turns > 0);
  if (rows.length === 0) return null;
  return (
    <table className="w-full border-collapse text-[12px]">
      <thead>
        <tr className="border-b border-[var(--line)] text-[10.5px] tracking-wide text-muted-foreground uppercase">
          <th className="py-1.5 pr-3 text-left font-medium">Day</th>
          <th className="py-1.5 pr-3 text-right font-medium">Turns</th>
          <th className="py-1.5 pr-3 text-right font-medium">Input</th>
          <th className="py-1.5 pr-3 text-right font-medium">Cached</th>
          <th className="py-1.5 pr-3 text-right font-medium">Output</th>
          <th className="py-1.5 text-right font-medium">Cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((day) => (
          <tr key={day.day} className="border-b border-[var(--line)] last:border-0">
            <td className="py-1.5 pr-3 whitespace-nowrap text-foreground">{formatDay(day.day)}</td>
            <td className="py-1.5 pr-3 text-right font-mono tabular-nums text-muted-foreground">
              {day.turns}
            </td>
            <td className="py-1.5 pr-3 text-right font-mono tabular-nums text-muted-foreground">
              {formatTokens(day.inputTokens)}
            </td>
            <td className="py-1.5 pr-3 text-right font-mono tabular-nums text-muted-foreground">
              {formatTokens(day.cachedInputTokens)}
            </td>
            <td className="py-1.5 pr-3 text-right font-mono tabular-nums text-muted-foreground">
              {formatTokens(day.outputTokens + day.reasoningTokens)}
            </td>
            <td className="py-1.5 text-right font-mono tabular-nums text-foreground">
              {formatUsd(day.costUsd)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Panel ───────────────────────────────────────────────────────

export function ProviderSettingsUsage(props: {
  readonly displayName: string;
  readonly driverKind: ProviderDriverKind;
  readonly provider: ServerProvider | undefined;
  readonly summary: ProviderUsageSummary | undefined;
  readonly refreshState: ProviderUsageRefreshState;
  readonly onRefresh: (() => void) | undefined;
  readonly onUseReset?: (
    creditId: string | undefined,
    idempotencyKey: string,
  ) => Promise<ProviderUsageResetOutcome>;
}) {
  const { displayName, driverKind, provider, summary, refreshState, onRefresh, onUseReset } = props;
  const dismissResetCredit = useProviderUsageStore((state) => state.dismissResetCredit);
  const ledger = useProviderUsageLedgerStore((state) => state.ledger);
  const clearDriver = useProviderUsageLedgerStore((state) => state.clearDriver);
  const nowMs = useRelativeTimeTick(30_000);
  const digest = useMemo(
    () => digestProviderUsage(ledger, driverKind, nowMs),
    [driverKind, ledger, nowMs],
  );
  const canRefresh =
    provider !== undefined && isProviderUsageRefreshEligible(provider) && onRefresh !== undefined;
  const refreshing = refreshState.status === "loading";
  const externalLink = providerUsageExternalLink(driverKind);

  if (!shouldShowProviderSettingsUsage(driverKind, summary)) return null;

  const statusLabel = refreshing
    ? "Loading"
    : summary?.state === "stale"
      ? "Stale"
      : summary?.state === "unavailable"
        ? "Unavailable"
        : null;
  const reportedAt = summary?.reportedAt ? formatAt(summary.reportedAt) : null;
  const hasActivity = digest.allTime.turns > 0;

  return (
    <section
      aria-label={`${displayName} account usage`}
      data-provider-usage-state={refreshing ? "loading" : (summary?.state ?? "loading")}
      className="space-y-5 rounded-[14px] border border-[var(--line)] bg-[var(--card)] p-4"
    >
      <div>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h4 className="text-[13px] font-semibold text-foreground">Account limits</h4>
            <p className="text-[11.5px] text-muted-foreground">
              {reportedAt
                ? `${summary?.state === "stale" ? "Last reported" : "Reported"} ${reportedAt}`
                : refreshing
                  ? "Waiting for provider usage"
                  : "Quotas reported by the provider account"}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {statusLabel ? (
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[11px] font-medium",
                  summary?.state === "stale" && !refreshing
                    ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                    : "bg-surface-hover text-muted-foreground",
                )}
              >
                {statusLabel}
              </span>
            ) : null}
            {canRefresh ? (
              <button
                type="button"
                onClick={onRefresh}
                disabled={refreshing}
                aria-label={`Refresh ${displayName} usage`}
                aria-busy={refreshing}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[var(--line)] px-2 text-[12px] font-medium text-foreground transition-colors hover:bg-surface-hover disabled:opacity-60"
              >
                <RefreshCwIcon className={cn("size-3", refreshing && "animate-spin")} aria-hidden />
                {refreshing ? "Refreshing…" : "Refresh"}
              </button>
            ) : null}
          </div>
        </div>

        {!provider || !summary ? (
          <p className="mt-3 text-[12px] text-muted-foreground">
            Waiting for provider status before account usage can be requested.
          </p>
        ) : summary.windows.length > 0 ? (
          <ul className="mt-3 space-y-3.5" aria-label={`${displayName} usage windows`}>
            {summary.windows.map((window) => (
              <QuotaWindow key={window.key} window={window} nowMs={nowMs} />
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-[12px] text-muted-foreground">
            {refreshing
              ? "Loading usage…"
              : "Usage has not been reported for this provider account yet."}
          </p>
        )}

        {refreshing ? (
          <p
            className="mt-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            <LoaderIcon className="size-3 animate-spin" aria-hidden />
            Refreshing {displayName} usage
          </p>
        ) : null}
        {provider && !canRefresh ? (
          <p className="mt-2 text-[11px] text-muted-foreground">
            {provider.auth.status === "unauthenticated"
              ? `Sign in to ${displayName} to refresh usage.`
              : `${displayName} does not expose refreshable account usage.`}
          </p>
        ) : null}
        {refreshState.status === "error" ? (
          <div
            role="alert"
            className="mt-3 flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs text-destructive"
          >
            <span>{refreshState.error}</span>
            {canRefresh ? (
              <Button type="button" size="xs" variant="outline" onClick={onRefresh}>
                Try again
              </Button>
            ) : null}
          </div>
        ) : null}

        {summary && (summary.resetCredits || externalLink) ? (
          <ProviderUsageDetails
            creditsOnly
            name={displayName}
            state={summary.state}
            windows={summary.windows}
            reportedAt={summary.reportedAt}
            resetCredits={summary.resetCredits ?? null}
            externalUsageLink={externalLink}
            {...(onUseReset ? { onUseReset } : {})}
            {...(summary.accountKey
              ? {
                  onDismissResetCredit: (credit: ProviderUsageResetCredit) => {
                    if (summary.accountKey) dismissResetCredit(summary.accountKey, credit);
                  },
                }
              : {})}
          />
        ) : null}
      </div>

      <div className="border-t border-[var(--line)] pt-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="text-[13px] font-semibold text-foreground">Activity on this device</h4>
            <p className="text-[11.5px] text-muted-foreground">
              Tokens and reported cost from every {displayName} turn observed here.
            </p>
          </div>
          {hasActivity ? (
            <Button type="button" size="xs" variant="ghost" onClick={() => clearDriver(driverKind)}>
              Clear history
            </Button>
          ) : null}
        </div>
        {hasActivity ? (
          <div className="mt-3 space-y-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatCard label="Today" totals={digest.today} />
              <StatCard label="7 days" totals={digest.last7Days} />
              <StatCard label="30 days" totals={digest.last30Days} />
              <StatCard label="All time" totals={digest.allTime} />
            </div>
            <DailyChart days={digest.recentDays} />
            <DailyTable days={digest.recentDays} />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Counts come from each turn's own usage report, so they are exact for the threads
              opened on this device. Cost shows only what the provider itself reported; a dash means
              it reported none. Subscription plans bill by quota, not by these figures.
            </p>
          </div>
        ) : (
          <p className="mt-3 rounded-[10px] border border-dashed border-[var(--line)] px-3 py-2.5 text-[12px] text-muted-foreground">
            No {displayName} turns observed on this device yet. Usage appears after the first
            response in any thread you open here.
          </p>
        )}
        {externalLink ? (
          <a
            href={externalLink.href}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {externalLink.label}
            <ExternalLinkIcon className="size-3" aria-hidden />
          </a>
        ) : null}
      </div>
    </section>
  );
}
