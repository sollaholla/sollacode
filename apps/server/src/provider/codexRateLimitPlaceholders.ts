/**
 * Codex's app-server answers `account/rateLimits/read` — and can emit
 * `account/rateLimits/updated` — before it has a real reading from the
 * backend. The stand-in it sends is not marked as such: every window reads
 * `usedPercent: 0` with `resetsAt` sitting exactly one window-length after
 * the moment of the request, and it drifts with the clock on every call.
 *
 * Seen 2026-09-12: a fresh app-server said the weekly limit was at 0% with
 * seven days to go while the account was at 100% until Sep 14. Rendered as a
 * fresh window, that reads as "your quota just reset". It has not. This
 * module recognises the stand-in so callers can keep their last real reading
 * instead of publishing a fiction.
 */

export interface CodexRateLimitWindowLike {
  readonly usedPercent: number;
  readonly windowDurationMins?: number | null;
  readonly resetsAt?: number | null;
}

export interface CodexRateLimitSnapshotLike {
  readonly primary?: CodexRateLimitWindowLike | null;
  readonly secondary?: CodexRateLimitWindowLike | null;
  readonly individualLimit?: unknown;
  readonly credits?: { readonly hasCredits?: boolean; readonly unlimited?: boolean } | null;
  readonly rateLimitReachedType?: string | null;
}

/**
 * How far `resetsAt` may sit from `now + window` and still count as the
 * stand-in. A real window that reset at the very second of the request looks
 * the same for that one reading; the next probe, a minute later, tells them
 * apart, so a short tolerance costs at most one delayed report.
 */
export const CODEX_PLACEHOLDER_TOLERANCE_MS = 90_000;

/**
 * The drift is the ONLY tell. 0.1.546 briefly also remembered every reset it
 * had judged synthetic and kept stripping that window once it showed usage.
 * That was wrong: on 2026-09-12 the weekly limit really reset at the first
 * request after a cold start, so the first real reading (0%, reset exactly one
 * week out) matched the stand-in's shape for that one probe, and the memory
 * then hid the genuine window -- "Weekly 4% used, resets Sep 19", confirmed by
 * `account/rateLimits/updated` after every completed turn -- for the life of
 * the process. A window that stops drifting and accrues usage is real.
 */
export function isSyntheticCodexRateLimitWindow(
  window: CodexRateLimitWindowLike,
  nowMs: number,
): boolean {
  if (typeof window.windowDurationMins !== "number" || typeof window.resetsAt !== "number") {
    return false;
  }
  if (!Number.isFinite(window.windowDurationMins) || !Number.isFinite(window.resetsAt)) {
    return false;
  }
  if (window.usedPercent !== 0) return false;
  const expectedResetMs = nowMs + window.windowDurationMins * 60_000;
  return Math.abs(window.resetsAt * 1000 - expectedResetMs) <= CODEX_PLACEHOLDER_TOLERANCE_MS;
}

/**
 * The snapshot with its stand-in windows removed, or null when nothing real
 * is left: no window, no spend limit, no credit balance, no exhaustion flag.
 */
export function stripSyntheticCodexRateLimitSnapshot<S extends CodexRateLimitSnapshotLike>(
  snapshot: S,
  nowMs: number,
): S | null {
  const primary =
    snapshot.primary && !isSyntheticCodexRateLimitWindow(snapshot.primary, nowMs)
      ? snapshot.primary
      : null;
  const secondary =
    snapshot.secondary && !isSyntheticCodexRateLimitWindow(snapshot.secondary, nowMs)
      ? snapshot.secondary
      : null;
  const hasCredits = snapshot.credits?.hasCredits === true || snapshot.credits?.unlimited === true;
  const hasOtherSignal =
    Boolean(snapshot.individualLimit) ||
    hasCredits ||
    (typeof snapshot.rateLimitReachedType === "string" && snapshot.rateLimitReachedType.length > 0);
  if (primary === null && secondary === null && !hasOtherSignal) return null;
  if (primary === (snapshot.primary ?? null) && secondary === (snapshot.secondary ?? null)) {
    return snapshot;
  }
  return { ...snapshot, primary, secondary };
}

export interface CodexRateLimitsResponseLike<S extends CodexRateLimitSnapshotLike> {
  readonly rateLimits: S;
  readonly rateLimitsByLimitId?: { readonly [limitId: string]: S } | null;
  readonly rateLimitResetCredits?: { readonly availableCount: number } | null;
}

/**
 * The whole `account/rateLimits/read` answer with stand-ins removed, or null
 * when it carried nothing real — not even a redeemable reset credit.
 */
export function stripSyntheticCodexRateLimits<
  S extends CodexRateLimitSnapshotLike,
  R extends CodexRateLimitsResponseLike<S>,
>(response: R, nowMs: number): R | null {
  const rateLimits = stripSyntheticCodexRateLimitSnapshot(response.rateLimits, nowMs);
  let byLimitId: { [limitId: string]: S } | null | undefined = response.rateLimitsByLimitId;
  if (byLimitId) {
    const kept: { [limitId: string]: S } = {};
    for (const [limitId, snapshot] of Object.entries(byLimitId)) {
      const stripped = stripSyntheticCodexRateLimitSnapshot(snapshot, nowMs);
      if (stripped !== null) kept[limitId] = stripped;
    }
    byLimitId = kept;
  }
  const hasResetCredit = (response.rateLimitResetCredits?.availableCount ?? 0) > 0;
  const hasAnyLimit = rateLimits !== null || Object.keys(byLimitId ?? {}).length > 0;
  if (!hasAnyLimit && !hasResetCredit) return null;
  if (rateLimits === response.rateLimits && byLimitId === response.rateLimitsByLimitId) {
    return response;
  }
  return {
    ...response,
    // A stripped account snapshot keeps its shape so consumers that read
    // `rateLimits.primary` see "no window" rather than a missing object.
    rateLimits: rateLimits ?? { ...response.rateLimits, primary: null, secondary: null },
    ...(byLimitId === undefined ? {} : { rateLimitsByLimitId: byLimitId }),
  };
}
