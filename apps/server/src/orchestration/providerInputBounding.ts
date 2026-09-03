import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";

/**
 * Bounding a turn's prompt to what `ProviderSendTurnInput` accepts.
 *
 * The composer persists whatever the user typed or pasted, but
 * `ProviderSendTurnInput.input` caps at
 * `PROVIDER_SEND_TURN_MAX_INPUT_CHARS`. A message past that ceiling used to
 * fail schema decoding inside `ProviderService.sendTurn`, which fails the turn
 * itself: the message sits in the thread, every retry re-fails, and the thread
 * cannot make progress. A single pasted crash report is enough to do it.
 *
 * So the ceiling is enforced here, before the request is built, and enforced
 * by *shrinking* rather than by failing. The full text is spilled to a file the
 * provider can open, and the prompt keeps its head and tail plus a notice
 * naming that file. Nothing the user wrote is lost, and the turn always runs.
 *
 * Pure on purpose — the reactor owns the file write, this owns the text.
 */

/** Leading slice kept verbatim: the ask itself is almost always up front. */
export const PROVIDER_INPUT_BOUND_HEAD_CHARS = 60_000;
/** Trailing slice kept verbatim: a paste's closing instructions live here. */
export const PROVIDER_INPUT_BOUND_TAIL_CHARS = 40_000;
/** Room set aside for the notice so head + tail can be sized before writing it. */
const NOTICE_RESERVED_CHARS = 1_000;

export interface BoundedProviderInput {
  /** Text safe to put in `ProviderSendTurnInput.input`. */
  readonly text: string;
  /** Whether anything was removed. False means `text` is the original. */
  readonly bounded: boolean;
  readonly originalChars: number;
  readonly omittedChars: number;
}

const notice = (input: {
  readonly originalChars: number;
  readonly omittedChars: number;
  readonly maxChars: number;
  readonly spillPath: string | null;
}): string => {
  const scale = `${input.originalChars.toLocaleString("en-US")} characters, past this provider's ${input.maxChars.toLocaleString("en-US")}-character limit for one turn`;
  const omitted = `${input.omittedChars.toLocaleString("en-US")} characters`;
  return input.spillPath === null
    ? `[Solla Code: the message was ${scale}. ${omitted} from the middle were dropped and could not be written to disk, so they are unrecoverable — ask for the missing part if you need it.]`
    : `[Solla Code: the message was ${scale}. The complete text is on disk at ${input.spillPath} — read that file to see the ${omitted} omitted here.]`;
};

/**
 * Fit `text` inside the provider's per-turn ceiling.
 *
 * Returns the original text unchanged when it already fits, so the common path
 * costs one length comparison.
 */
export function boundProviderTurnInput(input: {
  readonly text: string;
  /** Absolute path the full text was written to, or null if the write failed. */
  readonly spillPath: string | null;
  readonly maxChars?: number;
}): BoundedProviderInput {
  const maxChars = input.maxChars ?? PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
  const originalChars = input.text.length;
  if (originalChars <= maxChars) {
    return { text: input.text, bounded: false, originalChars, omittedChars: 0 };
  }

  const available = Math.max(0, maxChars - NOTICE_RESERVED_CHARS - 4);
  const headChars = Math.min(PROVIDER_INPUT_BOUND_HEAD_CHARS, Math.floor(available * 0.6));
  const tailChars = Math.max(0, Math.min(PROVIDER_INPUT_BOUND_TAIL_CHARS, available - headChars));
  const omittedChars = originalChars - headChars - tailChars;
  const head = input.text.slice(0, headChars);
  const tail = tailChars > 0 ? input.text.slice(originalChars - tailChars) : "";
  const marker = notice({ originalChars, omittedChars, maxChars, spillPath: input.spillPath });

  const assembled = `${head}\n\n${marker}\n\n${tail}`;
  // The notice is written from counts that are already fixed, so it cannot
  // normally overrun its reservation; clamp anyway rather than hand the schema
  // a string one boundary change away from failing again.
  const text = assembled.length <= maxChars ? assembled : assembled.slice(0, maxChars);
  return { text, bounded: true, originalChars, omittedChars };
}
