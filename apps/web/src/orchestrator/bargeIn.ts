/**
 * Deciding whether the user actually started talking, or just put a cup down.
 *
 * Barge-in used to be entirely the server's decision: `turn_detection` defaults
 * to `interrupt_response: true`, so the moment input energy crossed the VAD
 * threshold the in-flight response was cancelled. A mug on a desk, a keyboard,
 * a door — each one cut the orchestrator off mid-sentence, and because the
 * server had already truncated what it "said", the next reply carried on past
 * the part the user never heard. From the outside that reads as skipping ahead.
 *
 * Raising the VAD threshold cannot fix this. A cup landing is *louder* than
 * speech; what separates them is not level but shape. A knock is a transient —
 * one or two loud frames and then decay. Speech sustains: it stays active
 * across hundreds of milliseconds and is still going when you look again.
 *
 * So the server is told not to interrupt on its own, and this decides instead,
 * from the microphone levels the meter is already sampling. Pure and
 * frame-based, so noisy-room behaviour is testable without an audio stack.
 */

/**
 * How long to watch before deciding. Long enough to outlast a knock, short
 * enough that a real interruption still feels immediate — a person barging in
 * is still talking well past this, and only notices the delay as the assistant
 * finishing a word.
 */
export const BARGE_IN_SUSTAIN_MS = 420;

/**
 * Level (0..1, as the meter reports it) at or above which a frame counts as
 * active. Below normal speech so a quiet talker still registers, above room
 * tone and the tail of a decaying thump.
 */
export const BARGE_IN_ACTIVE_LEVEL = 0.16;

/** Fraction of the window that must be active for it to count as speech. */
export const BARGE_IN_MIN_ACTIVE_RATIO = 0.5;

/** Frames needed before a verdict is meaningful at all. */
export const BARGE_IN_MIN_SAMPLES = 6;

/**
 * How much louder than the assistant's own playback the microphone has to be
 * for a frame to count as a person.
 *
 * Sustain alone cannot separate a talker from an echo: the assistant's voice
 * coming back through a speaker is *perfectly* sustained, so it passed every
 * test below and the orchestrator interrupted itself. Laptops hide this behind
 * good acoustic echo cancellation; a phone held in the hand, or headphones
 * leaking, does not — which is why it showed up first on mobile, as the model
 * cutting itself off after a word or two.
 *
 * On a device whose echo cancellation works the assistant barely registers on
 * the microphone at all, so this ratio never binds and behaviour is unchanged.
 */
export const BARGE_IN_ECHO_MARGIN = 1.6;

export interface BargeInThresholds {
  readonly activeLevel: number;
  readonly minActiveRatio: number;
  readonly minSamples: number;
  readonly echoMargin: number;
}

export const DEFAULT_BARGE_IN_THRESHOLDS: BargeInThresholds = {
  activeLevel: BARGE_IN_ACTIVE_LEVEL,
  minActiveRatio: BARGE_IN_MIN_ACTIVE_RATIO,
  minSamples: BARGE_IN_MIN_SAMPLES,
  echoMargin: BARGE_IN_ECHO_MARGIN,
};

/** One metered frame: what the microphone heard, and what was playing. */
export interface BargeInSample {
  readonly mic: number;
  /** Assistant playback level at the same instant. */
  readonly assistant: number;
}

/**
 * Whether a window of microphone levels is someone talking.
 *
 * Two conditions, and a transient fails both in different ways:
 *
 * - *Enough of the window is active.* A knock is loud for a frame or two out of
 *   a couple of dozen, so its ratio is tiny however high its peak was.
 * - *It is still active at the end.* This is what a decaying sound cannot fake.
 *   A sustained hum could pass the ratio test, but the tail check is what
 *   separates "a noise happened" from "a noise is happening".
 *
 * Peak level is deliberately not consulted. It is the one measure on which a
 * cup beats a voice, and treating loudness as evidence is exactly what made
 * the old behaviour so easy to trip.
 */
export function isSustainedSpeech(
  samples: ReadonlyArray<BargeInSample>,
  thresholds: BargeInThresholds = DEFAULT_BARGE_IN_THRESHOLDS,
): boolean {
  if (samples.length < thresholds.minSamples) return false;

  // Loud enough to be speech, and louder than what the speaker is emitting —
  // otherwise the microphone is just hearing the assistant come back at it.
  const isActive = (sample: BargeInSample): boolean =>
    sample.mic >= thresholds.activeLevel && sample.mic >= sample.assistant * thresholds.echoMargin;

  const active = samples.filter(isActive).length;
  if (active / samples.length < thresholds.minActiveRatio) return false;

  // The last third has to still be carrying signal.
  const tailStart = Math.floor((samples.length * 2) / 3);
  const tail = samples.slice(tailStart);
  const tailActive = tail.filter(isActive).length;
  return tail.length > 0 && tailActive / tail.length >= 0.5;
}

/**
 * Collects levels for one decision window.
 *
 * Kept as a tiny object rather than inline state because the session already
 * has more mutable flags than is comfortable, and this one has to be reset
 * from three different places.
 */
export interface BargeInWindow {
  /** Feed one metered frame. */
  readonly push: (sample: BargeInSample) => void;
  /** Verdict over everything collected so far. */
  readonly verdict: () => boolean;
  readonly sampleCount: () => number;
}

export function createBargeInWindow(
  thresholds: BargeInThresholds = DEFAULT_BARGE_IN_THRESHOLDS,
): BargeInWindow {
  const samples: Array<BargeInSample> = [];
  return {
    push: (sample) => {
      // Bounded: at ~60fps a 420ms window is ~25 frames, but a slow tab can
      // stretch that, and an unbounded array behind a stuck timer would grow.
      if (samples.length < 240) samples.push(sample);
    },
    verdict: () => isSustainedSpeech(samples, thresholds),
    sampleCount: () => samples.length,
  };
}
