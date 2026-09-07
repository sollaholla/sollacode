import type { ServerProvider, ServerProviderAuthStatus } from "@t3tools/contracts";
import { isProviderAuthenticationFailure } from "@t3tools/shared/agentMode";

/**
 * Whether this thread is genuinely waiting on a provider login.
 *
 * The only evidence the thread itself carries is its session's `lastError`,
 * which is a record of a failure that already happened. Nothing rewrites it
 * when the user signs back in - a new session row is written by the next
 * turn - so on its own it latches the pause forever. And because the pause
 * also gates sending, the one action that would clear it is the action it
 * blocks: reported 2026-09-06 as "this shows even after I've already signed
 * back in" and "because of it I can't send a message".
 *
 * The provider snapshot's `auth.status` is the live signal, refreshed by the
 * health probe and by the sign-in flow the banner's own button starts. An
 * explicit `authenticated` retires the pause. `unauthenticated` keeps it,
 * and so does an absent or `unknown` status: without a live answer the stale
 * error is still the best evidence there is.
 */
export function isProviderAuthenticationPauseActive(input: {
  readonly sessionStatus: string | null | undefined;
  readonly sessionLastError: string | null | undefined;
  readonly providerAuthStatus: ServerProviderAuthStatus | null;
}): boolean {
  if (input.sessionStatus !== "error") return false;
  if (!isProviderAuthenticationFailure(input.sessionLastError ?? "")) return false;
  return input.providerAuthStatus !== "authenticated";
}

/** The live auth status of the provider a thread is bound to, when known. */
export function resolveThreadProviderAuthStatus(input: {
  readonly instanceId: string | null | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
}): ServerProviderAuthStatus | null {
  if (!input.instanceId) return null;
  const provider = input.providers.find(
    (candidate) => String(candidate.instanceId) === String(input.instanceId),
  );
  return provider?.auth.status ?? null;
}
