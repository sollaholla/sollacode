/**
 * Grok Voice (and some Realtime revisions) emit several transcription events
 * for one spoken turn: a partial ("How's."), then the same finished line two
 * or three times. Each one used to become a user message and a new model
 * turn, so one "hello" looked like the user hammering the same sentence.
 *
 * Buffer the latest text while they are speaking, and commit once the
 * utterance has settled. A second "yes" after a real pause is still a new turn.
 */

export interface BufferedUtterance {
  readonly text: string;
  readonly itemId?: string;
}

export interface FlushedUtterance extends BufferedUtterance {
  readonly atMs: number;
}

/** Wait for a late `completed` after VAD says they stopped. */
export const UTTERANCE_SETTLE_MS = 250;
/**
 * Grok Voice reports `speech_stopped` earlier than OpenAI. Committing — and
 * playing the "accepted" cue — on that signal made people think the floor
 * was closed while they were still talking. Hold the utterance open long
 * enough that a mid-thought pause can resume before the cue.
 */
export const GROK_UTTERANCE_SETTLE_MS = 1_200;

/**
 * Same words arriving this close together are one utterance, not two.
 *
 * Grok Voice has been seen to emit the finished line again 3s+ after the
 * first commit. Two seconds was too tight and let "Hey, what's up?" land
 * three times. A second deliberate "yes" after the assistant has spoken
 * still commits, because that path sees an assistant line in between.
 */
export const DUPLICATE_UTTERANCE_MS = 8_000;

export function normalizeUtterance(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[.!?…,]+$/u, "")
    .replace(/\s+/g, " ");
}

/**
 * Whether `next` is the same line as `previous`, or the previous line growing
 * as the transcriber catches up ("How's." → "How's it going?").
 */
export function isTranscriptRefinement(previous: string, next: string): boolean {
  const from = normalizeUtterance(previous);
  const to = normalizeUtterance(next);
  if (from.length === 0 || to.length === 0) return false;
  if (from === to) return true;
  return to.startsWith(from) || from.startsWith(to);
}

export function shouldCommitUtterance(input: {
  readonly pending: BufferedUtterance;
  readonly lastCommitted: FlushedUtterance | null;
  readonly nowMs: number;
}): boolean {
  const last = input.lastCommitted;
  if (last === null) return true;
  if (
    input.pending.itemId !== undefined &&
    last.itemId !== undefined &&
    input.pending.itemId === last.itemId
  ) {
    return false;
  }
  if (input.nowMs - last.atMs > DUPLICATE_UTTERANCE_MS) return true;
  if (input.pending.itemId !== undefined && last.itemId !== undefined) {
    // Different VAD items are different turns. Only an exact repeated line is
    // a duplicate here; prefix growth belongs to cumulative updates within one
    // item. Without this, "no" followed by "not that one" was discarded.
    return normalizeUtterance(last.text) !== normalizeUtterance(input.pending.text);
  }
  return !isTranscriptRefinement(last.text, input.pending.text);
}
