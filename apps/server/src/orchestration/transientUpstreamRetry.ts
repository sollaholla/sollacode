/**
 * Retry policy for structured transient upstream failures (5xx, socket
 * errors, a provider's own `isRetryable`). The first attempt is the user's
 * turn; every later attempt is a silent retry with exponential backoff capped
 * at 15 s. The error the provider reported is never surfaced by this path.
 *
 * The budget covers a blip, about two minutes. A provider down for longer is
 * the person's call: the thread pauses and offers resume, another model or
 * another account, and nothing moves it for them.
 */
export const MAX_TRANSIENT_UPSTREAM_RETRIES = 12;

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 15_000;

/** `attempt` is the attempt that just failed, 1-based. */
export function shouldRetryTransientUpstream(attempt: number): boolean {
  return attempt < MAX_TRANSIENT_UPSTREAM_RETRIES;
}

/** Backoff before the attempt that follows the failed `attempt`: 1s, 2s, 4s, 8s, then 15s. */
export function transientUpstreamRetryDelayMs(attempt: number): number {
  const step = Math.max(0, Math.trunc(attempt) - 1);
  if (step >= 4) return MAX_DELAY_MS;
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** step);
}
