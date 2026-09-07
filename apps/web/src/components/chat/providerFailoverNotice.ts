import type { OrchestrationThreadActivity } from "@t3tools/contracts";

export const PROVIDER_FAILOVER_COMPLETED_ACTIVITY_KIND = "provider.failover.completed";
export const PROVIDER_FAILOVER_RESTORED_ACTIVITY_KIND = "provider.failover.restored";
/** A deliberate provider change by the user; ends any failover the thread was under. */
export const PROVIDER_HANDOFF_COMPLETED_ACTIVITY_KIND = "provider.handoff.completed";

export interface ProviderFailoverNotice {
  readonly activityId: string;
  readonly createdAt: string;
  readonly summary: string;
  readonly sourceLabel: string | null;
  readonly sourceModel: string | null;
  readonly targetLabel: string | null;
  readonly targetModel: string | null;
  readonly reason: string | null;
  /** Epoch milliseconds the exhausted window resets, when the provider said. */
  readonly resetsAt: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function epochMsOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value < 1_000_000_000_000 ? value * 1_000 : value;
}

/**
 * The failover this thread is currently living under: the newest
 * `provider.failover.completed` that no later restore or deliberate provider
 * change has ended. The server moved the thread off its chosen model because
 * the provider refused a request; the only evidence in the transcript was a
 * muted divider row, which is how a Fable→Opus drop went unnoticed on
 * 2026-09-06. This feeds a banner that stays until the switch is undone.
 */
export function findProviderFailoverNotice(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ProviderFailoverNotice | null {
  let failover: OrchestrationThreadActivity | null = null;
  for (const activity of activities) {
    if (
      activity.kind === PROVIDER_FAILOVER_RESTORED_ACTIVITY_KIND ||
      activity.kind === PROVIDER_HANDOFF_COMPLETED_ACTIVITY_KIND
    ) {
      if (failover === null || activity.createdAt >= failover.createdAt) failover = null;
      continue;
    }
    if (activity.kind !== PROVIDER_FAILOVER_COMPLETED_ACTIVITY_KIND) continue;
    if (failover === null || activity.createdAt >= failover.createdAt) failover = activity;
  }
  if (failover === null) return null;
  const payload = asRecord(failover.payload);
  return {
    activityId: failover.id,
    createdAt: failover.createdAt,
    summary: failover.summary,
    sourceLabel: stringOrNull(payload?.sourceLabel),
    sourceModel: stringOrNull(payload?.sourceModel),
    targetLabel: stringOrNull(payload?.targetLabel),
    targetModel: stringOrNull(payload?.targetModel),
    reason: stringOrNull(payload?.reason),
    resetsAt: epochMsOrNull(payload?.resetsAt),
  };
}

/**
 * Whether the banner should still show: the thread is on the failover
 * target. Once the user (or the restore) puts the thread back on another
 * model, the notice is history even without a restore row.
 */
export function isProviderFailoverActive(input: {
  readonly notice: ProviderFailoverNotice | null;
  readonly currentModel: string | null;
}): boolean {
  if (input.notice === null) return false;
  if (input.notice.targetModel === null || input.currentModel === null) return true;
  return input.notice.targetModel === input.currentModel;
}

export function describeProviderFailover(notice: ProviderFailoverNotice, nowMs: number): string {
  const from = notice.sourceModel ?? notice.sourceLabel ?? "the chosen model";
  const to = notice.targetModel ?? notice.targetLabel ?? "another model";
  const why =
    notice.reason === null
      ? "the provider refused a request for it"
      : notice.reason.includes("rejected") || notice.reason.includes("rate_limit")
        ? "the provider refused a request for it (usage limit)"
        : notice.reason.includes("spend")
          ? "the provider's spend control refused it"
          : notice.reason.replaceAll("_", " ");
  const back =
    notice.resetsAt === null
      ? "It switches back when the window resets."
      : notice.resetsAt <= nowMs
        ? "The window has reset; it switches back on the next idle turn."
        : `It switches back after the window resets in ${formatRemaining(notice.resetsAt - nowMs)}.`;
  return `Running on ${to} instead of ${from} because ${why}. ${back}`;
}

function formatRemaining(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}
