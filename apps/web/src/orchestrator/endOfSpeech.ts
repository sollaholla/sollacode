/**
 * Deciding whether the user has actually finished talking.
 *
 * Server voice-activity detection measures silence, and silence is a poor proxy
 * for a finished thought. Someone reaching for a name, or pausing before the
 * important half of a sentence, produces exactly the same signal as someone who
 * has stopped — so the model answers a half-question, and the rest of the
 * sentence lands as a second turn nobody wanted.
 *
 * The transcriber knows something the VAD does not. When speech trails off
 * unfinished it ends the transcript with an ellipsis; when a thought closes it
 * punctuates. That is a far better end-of-turn signal than a stopwatch, and it
 * costs nothing — the transcript is already being produced.
 *
 * Pure and clock-injected so the timing is testable without speaking.
 */

/**
 * How long to wait for the user to carry on after an unfinished-sounding
 * utterance before answering anyway.
 *
 * A ceiling, not a target: it only matters when someone trails off and then
 * says nothing at all. Long enough to cover drawing breath mid-thought, short
 * enough that a genuine trailing-off does not feel ignored.
 */
export const CONTINUATION_GRACE_MS = 2_500;

/** Trailing ellipsis, as a real character or as three or more dots. */
const TRAILING_ELLIPSIS = /(?:…|\.{3,})\s*$/u;

/**
 * Whether a transcript reads as a finished utterance.
 *
 * A trailing ellipsis is the *only* thing treated as unfinished. Requiring a
 * closing full stop instead would be stricter and much worse: transcribers do
 * not reliably punctuate short commands, so "stop that thread" would be held
 * back like a half-sentence and every single turn would pay the grace period.
 * A rule that adds two seconds to normal speech to catch an occasional trail-off
 * is not worth having.
 *
 * Empty or blank counts as finished too: there is nothing to wait for, and
 * holding a turn open on silence is how a session hangs.
 */
export function isUtteranceComplete(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  return !TRAILING_ELLIPSIS.test(trimmed);
}

/**
 * Bracketed markers a transcriber emits for audio that is not speech, e.g.
 * `[BLANK_AUDIO]`, `(silence)`, `[ Music ]`.
 */
const NON_SPEECH_MARKER = /^[[(][^\])]*[\])]$/;
/** Any letter or digit, in any script — the evidence that words were said. */
const CARRIES_WORDS = /[\p{L}\p{N}]/u;

/**
 * Whether a committed turn actually contained speech.
 *
 * Voice activity detection fires on energy, not on language, so a door, a
 * cough or a keyboard opens a turn; the server then generates a reply to it
 * because `create_response` cannot read the transcript either. What came back
 * was the assistant saying "I didn't catch that" every time anything happened
 * in the room — the most irritating possible response to a noise, because it
 * demands the user answer something they never started.
 *
 * Deliberately conservative: only a transcript with no letters or digits at
 * all, or a bare non-speech marker, counts as noise. A genuine one-word answer
 * ("yes", "no", a name) carries letters and is always answered.
 */
export function isNoiseTranscript(text: string): boolean {
  const trimmed = text.trim();
  // An empty transcript is NOT evidence of noise, and treating it as such broke
  // the feature outright: transcription lags, fails, and returns nothing for
  // short or quiet speech, so "empty" covers both a door closing and someone
  // saying "yes". Discarding it silently meant the session stopped answering
  // after the first turn and looked like it had given up.
  //
  // The costs are wildly asymmetric. A spurious "I didn't catch that" is
  // irritating; being ignored is the feature not working. So this now requires
  // positive evidence that a turn contained no speech, and the instruction
  // telling the model to stay quiet on an unintelligible turn covers the rest.
  if (trimmed.length === 0) return false;
  if (NON_SPEECH_MARKER.test(trimmed)) return true;
  return !CARRIES_WORDS.test(trimmed);
}

export type EndOfSpeechDecision =
  /** Let the reply proceed. */
  | { readonly kind: "answer" }
  /** Hold the reply and wait for the user to carry on. */
  | { readonly kind: "wait-for-continuation"; readonly graceMs: number }
  /** Nothing was said. Cancel the reply and keep listening, silently. */
  | { readonly kind: "discard" };

/**
 * What to do with a completed user transcript.
 *
 * `waitedAlready` stops a second hold: once the grace has elapsed and the reply
 * was released, a further ellipsis must not restart the wait, or someone who
 * habitually trails off would never be answered at all.
 */
export function decideEndOfSpeech(input: {
  readonly text: string;
  readonly waitedAlready: boolean;
  readonly graceMs?: number;
}): EndOfSpeechDecision {
  // Checked before `waitedAlready`: a turn that turned out to be noise is noise
  // whether or not something was held for it.
  if (isNoiseTranscript(input.text)) return { kind: "discard" };
  if (input.waitedAlready) return { kind: "answer" };
  if (isUtteranceComplete(input.text)) return { kind: "answer" };
  return { kind: "wait-for-continuation", graceMs: input.graceMs ?? CONTINUATION_GRACE_MS };
}
