/**
 * Retry policy for structured transient upstream failures (5xx, socket
 * errors, a provider's own `isRetryable`). The first attempt is the user's
 * turn; every later attempt is a silent retry with exponential backoff capped
 * at 15 s. The error the provider reported is never surfaced by this path.
 *
 * The budget is unbounded on purpose (2026-09-17): a provider that stays
 * overloaded for an hour is still the same provider the user chose, and every
 * bounded budget tried so far (5, then 15) ended with a paused thread and an
 * error card the user had to dismiss and Resume by hand. Stop, a provider
 * switch, or a new message from the user are the ways out of the loop.
 */
export const MAX_TRANSIENT_UPSTREAM_RETRIES = Number.POSITIVE_INFINITY;

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 15_000;

/** `attempt` is the attempt that just failed, 1-based. Always retries. */
export function shouldRetryTransientUpstream(attempt: number): boolean {
  return Number.isFinite(attempt) || attempt > 0;
}

/** Backoff before the attempt that follows the failed `attempt`: 1s, 2s, 4s, 8s, then 15s forever. */
export function transientUpstreamRetryDelayMs(attempt: number): number {
  const step = Math.max(0, Math.trunc(attempt) - 1);
  if (step >= 4) return MAX_DELAY_MS;
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** step);
}
