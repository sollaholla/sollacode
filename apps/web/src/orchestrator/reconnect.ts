/**
 * Getting the conversation back after the network drops.
 *
 * A WebRTC session does not survive losing Wi-Fi. The peer connection fails, the
 * data channel closes, and nothing arrives again — but from the user's side the
 * microphone is still open and they are still talking, so the failure is silent
 * and total. Until now that ended the conversation and left them to work out
 * that they had to start it again by hand.
 *
 * A dropped session cannot be resumed — the token is spent and the transport is
 * gone — so "reconnect" means minting a new session and carrying on. That is
 * cheap and nearly invisible, which is why it is worth doing automatically for
 * a brief drop and worth refusing for a sustained one: retrying into a dead
 * network forever would hold the microphone open with nothing listening.
 *
 * Pure and clock-injected so the policy is testable without a network.
 */

/** Attempts before giving up and leaving it to the user. */
export const MAX_RECONNECT_ATTEMPTS = 4;

/**
 * Backoff between attempts, in milliseconds.
 *
 * The first is deliberately short: most drops are a handover between access
 * points and are over before a second has passed, and reconnecting inside that
 * window means the user barely notices. Later attempts back off so a real
 * outage is not hammered.
 */
export const RECONNECT_DELAYS_MS: ReadonlyArray<number> = [600, 1_500, 3_000, 6_000];

export type ReconnectDecision =
  | { readonly kind: "retry"; readonly delayMs: number; readonly attempt: number }
  | { readonly kind: "give-up"; readonly reason: "attempts-exhausted" | "stopped-by-user" };

export function decideReconnect(input: {
  /** How many attempts have already been made for this drop. */
  readonly attemptsMade: number;
  /** False once the user has deliberately stopped the session. */
  readonly wanted: boolean;
}): ReconnectDecision {
  if (!input.wanted) return { kind: "give-up", reason: "stopped-by-user" };
  if (input.attemptsMade >= MAX_RECONNECT_ATTEMPTS) {
    return { kind: "give-up", reason: "attempts-exhausted" };
  }
  const delayMs =
    RECONNECT_DELAYS_MS[input.attemptsMade] ??
    RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1] ??
    0;
  return { kind: "retry", delayMs, attempt: input.attemptsMade + 1 };
}

/**
 * Peer states that mean the transport is really gone.
 *
 * `disconnected` used to be in here, on the reasoning that on a phone it is
 * what a Wi-Fi handover looks like and waiting for `failed` costs seconds of a
 * conversation nobody can hear. That was wrong, and it broke starting a session
 * outright. `disconnected` is transient *by specification* — ICE reports it
 * whenever connectivity checks lapse, which on a phone, and especially over a
 * VPN interface, happens routinely during setup on a connection that is about
 * to succeed. Treating it as death tore down sessions mid-negotiation.
 *
 * It is still worth reacting to, just not immediately: see
 * {@link isConnectionUnstableState} and {@link DISCONNECTED_GRACE_MS}.
 */
export function isConnectionLostState(state: string): boolean {
  return state === "failed" || state === "closed";
}

/**
 * Peer states that might be a drop, and might be nothing.
 *
 * Watched rather than acted on. If the connection is still in one of these
 * after {@link DISCONNECTED_GRACE_MS} it is treated as lost; if it recovers
 * first — which is the common case — nothing happened.
 */
export function isConnectionUnstableState(state: string): boolean {
  return state === "disconnected";
}

/**
 * How long `disconnected` is given to come back on its own.
 *
 * Long enough to cover an access-point handover, short enough that a real drop
 * is still caught inside a sentence.
 */
export const DISCONNECTED_GRACE_MS = 4_000;
