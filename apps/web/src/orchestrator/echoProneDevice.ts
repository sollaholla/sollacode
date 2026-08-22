/**
 * Whether this device will hear the orchestrator's own voice.
 *
 * On a phone the speaker is a few centimetres from the microphone, so the
 * assistant's output comes straight back in. The server transcribes it as the
 * user, answers it, and the conversation runs away on its own — the reported
 * symptom was saying "hi, can you hear me?" once and watching a transcript fill
 * with turns nobody spoke.
 *
 * Browser echo cancellation is requested and still loses on a phone speaker,
 * and every client-side filter can only judge the echo *after* it has been
 * uploaded and turned into a user turn. Closing the microphone while the
 * assistant speaks is the only thing that actually works, so on these devices
 * that is the default rather than a setting to find.
 *
 * Deliberately conservative: a laptop with a touchscreen is not echo-prone (its
 * speakers are far enough away and its microphone is better), so this requires
 * a *coarse* pointer — no mouse — as well as a small screen.
 */

/** Widest viewport still treated as a handheld device, in CSS pixels. */
export const ECHO_PRONE_MAX_VIEWPORT = 900;

export function isEchoProneDevice(
  input: {
    readonly coarsePointer?: boolean;
    readonly viewportWidth?: number;
  } = {},
): boolean {
  const coarsePointer =
    input.coarsePointer ??
    (typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches);
  if (coarsePointer !== true) return false;

  const viewportWidth =
    input.viewportWidth ?? (typeof window === "undefined" ? Number.NaN : window.innerWidth);
  // An unknown width with a coarse pointer is still a phone or tablet; treating
  // it as a desktop would reintroduce the runaway conversation.
  if (!Number.isFinite(viewportWidth)) return true;
  return viewportWidth <= ECHO_PRONE_MAX_VIEWPORT;
}

/**
 * Resolves the effective barge-in setting for this device.
 *
 * The user's preference still wins where it is safe to honour it; it is only
 * overridden where honouring it would break the conversation outright.
 */
export function resolveInterruptWhileSpeaking(input: {
  readonly setting: boolean;
  readonly echoProne: boolean;
}): boolean {
  return input.echoProne ? false : input.setting;
}
