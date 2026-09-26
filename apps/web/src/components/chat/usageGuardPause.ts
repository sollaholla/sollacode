import type {
  OrchestrationThreadActivity,
  OrchestrationThreadPendingWork,
} from "@t3tools/contracts";

export const USAGE_GUARD_PAUSED_ACTIVITY_KIND = "usage-guard.paused";
export const USAGE_GUARD_RESUMED_ACTIVITY_KIND = "usage-guard.resumed";
export const USAGE_GUARD_OPTIMIZED_ACTIVITY_KIND = "usage-guard.optimized";

export interface UsageGuardEffortEstimate {
  readonly effort: string;
  readonly optionId?: string | undefined;
  readonly windowLabel?: string | null;
  readonly model: string;
  readonly resumeAt: number | null;
  readonly samples: number;
}

export interface UsageGuardPauseNotice {
  readonly effortEstimates?: ReadonlyArray<UsageGuardEffortEstimate>;
  readonly activityId: string;
  readonly createdAt: string;
  readonly providerLabel: string;
  readonly summary: string;
  readonly detail: string | null;
  readonly retryAt: string | null;
  readonly estimatedPercent: number | null;
  readonly windowLabel: string | null;
  readonly resetsAt: number | null;
  /** "pause" = one more turn no longer fits; anything else = waiting for pace room. */
  readonly tier: string | null;
  readonly backgroundBudget: number | null;
  readonly activeThreads: number | null;
  /** ISO time of the usage report the hold was computed from; null when unknown. */
  readonly reportedAt: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * The pause the thread is currently under, if any: the newest `usage-guard.paused`
 * activity that no later `usage-guard.resumed` has lifted. Whether the pause
 * is still *in force* is decided by the server's pending work (see
 * {@link isUsageGuardPauseActive}); this only finds the notice to show.
 */
export function findUsageGuardPauseNotice(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  /**
   * The provider instance the thread runs on now. A hold names the instance
   * it was computed for; one left behind by a provider the thread has since
   * moved away from is not this thread's hold. A Muse thread showed "Waiting
   * for usage room · resumes in 2h" from a Claude weekly hold two days old
   * (2026-09-12) because nothing here asked whose hold it was.
   */
  currentInstanceId: string | null = null,
): UsageGuardPauseNotice | null {
  let paused: OrchestrationThreadActivity | null = null;
  for (const activity of activities) {
    if (activity.kind === USAGE_GUARD_RESUMED_ACTIVITY_KIND) {
      if (paused === null || activity.createdAt >= paused.createdAt) paused = null;
      continue;
    }
    if (activity.kind !== USAGE_GUARD_PAUSED_ACTIVITY_KIND) continue;
    const noticeInstanceId = stringOrNull(asRecord(activity.payload)?.instanceId);
    if (
      currentInstanceId !== null &&
      noticeInstanceId !== null &&
      noticeInstanceId !== currentInstanceId
    ) {
      continue;
    }
    if (paused === null || activity.createdAt >= paused.createdAt) paused = activity;
  }
  if (paused === null) return null;
  const payload = asRecord(paused.payload);
  const effortEstimates: UsageGuardEffortEstimate[] = [];
  if (Array.isArray(payload?.effortEstimates))
    for (const raw of payload.effortEstimates) {
      const entry = asRecord(raw);
      const effort = stringOrNull(entry?.effort);
      const model = stringOrNull(entry?.model);
      if (effort && model)
        effortEstimates.push({
          effort,
          optionId: stringOrNull(entry?.optionId) ?? undefined,
          windowLabel: stringOrNull(entry?.windowLabel),
          model,
          resumeAt: finiteNumber(entry?.resumeAt),
          samples: finiteNumber(entry?.samples) ?? 0,
        });
    }
  return {
    effortEstimates,
    activityId: paused.id,
    createdAt: paused.createdAt,
    providerLabel: stringOrNull(payload?.providerLabel) ?? "The provider",
    summary: paused.summary,
    detail: stringOrNull(payload?.detail),
    retryAt: stringOrNull(payload?.resumeAt) ?? stringOrNull(payload?.retryAt),
    estimatedPercent: finiteNumber(payload?.estimatedPercent),
    windowLabel: stringOrNull(payload?.windowLabel),
    resetsAt: finiteNumber(payload?.resetsAt),
    tier: stringOrNull(payload?.tier),
    reportedAt: stringOrNull(payload?.reportedAt),
    backgroundBudget: finiteNumber(payload?.backgroundBudget),
    activeThreads: finiteNumber(payload?.activeThreads),
  };
}

const PAUSED_PENDING_WORK_STATES: ReadonlySet<string> = new Set(["sleeping", "pending", "claimed"]);

/**
 * A pause is active while the thread still has queued work the scheduler is
 * holding. Once the delivery runs (the obligation leaves the queue) the notice
 * is history, even without a resume row.
 */
export function isUsageGuardPauseActive(input: {
  readonly notice: UsageGuardPauseNotice | null;
  readonly pendingWork: OrchestrationThreadPendingWork | null | undefined;
  readonly isWorking: boolean;
}): boolean {
  if (input.notice === null || input.isWorking) return false;
  if (input.pendingWork == null) return false;
  return PAUSED_PENDING_WORK_STATES.has(input.pendingWork.state);
}

export function formatUsageGuardResetsAt(resetsAt: number | null, nowMs: number): string | null {
  if (resetsAt === null) return null;
  const remainingMs = resetsAt - nowMs;
  if (remainingMs <= 0) return "resets any moment now";
  const minutes = Math.round(remainingMs / 60_000);
  if (minutes < 60) return `resets in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `resets in ${hours} h`;
  return `resets in ${Math.round(hours / 24)} d`;
}
export function formatCooldownDuration(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${total % 60}s`;
  return `${total}s`;
}
