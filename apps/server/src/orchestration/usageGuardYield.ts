/** A durable yield is distinct from a user's Stop. Only its exact turn may resume. */
export const USAGE_GUARD_YIELD_PREFIX = "usage-guard-yield:";
export const usageGuardYieldReason = (turnId: string) => `${USAGE_GUARD_YIELD_PREFIX}${turnId}`;
export const isUsageGuardYield = (reason: string | null | undefined) =>
  reason?.startsWith(USAGE_GUARD_YIELD_PREFIX) === true;
export const canResumeUsageGuardYield = (reason: string | null | undefined, turnId: string) =>
  reason === usageGuardYieldReason(turnId);

/** Never interrupt a tool, child agent, compaction, or a human's pending answer. */
/**
 * When the minimum-work clock for a running turn started. The turn's own
 * start wins over the supervisor's: a supervisor that (re)attaches to a turn
 * already minutes into its work — after a restart, or when recovery claims a
 * live session — must not grant it a fresh two minutes before the guard may
 * yield it. Falls back to the supervisor start when the turn carries no time.
 */
export function usageGuardWorkStartedAtMs(input: {
  readonly supervisorStartedAtMs: number;
  readonly turnStartedAt: string | null | undefined;
  readonly turnRequestedAt: string | null | undefined;
  readonly sessionUpdatedAt: string | null | undefined;
}): number {
  const candidates = [input.turnStartedAt, input.turnRequestedAt, input.sessionUpdatedAt]
    .map((value) => (value == null ? Number.NaN : Date.parse(value)))
    .filter((value) => Number.isFinite(value));
  const turnStartedAtMs = candidates.length === 0 ? Number.NaN : candidates[0]!;
  return Number.isFinite(turnStartedAtMs)
    ? Math.min(input.supervisorStartedAtMs, turnStartedAtMs)
    : input.supervisorStartedAtMs;
}

export function shouldYieldUsageGuardTurn(input: {
  readonly action: string;
  readonly phase: string | undefined;
  readonly awaitingHuman: boolean;
  readonly observedTokens: number;
  readonly startingTokens: number;
  readonly elapsedMs: number;
}): boolean {
  return (
    input.action === "pause" &&
    input.elapsedMs >= 120_000 &&
    !input.awaitingHuman &&
    input.phase === "provider-running" &&
    input.observedTokens > input.startingTokens
  );
}
