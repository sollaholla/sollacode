/**
 * Reconcile terminal input while an input method owns the textarea.
 *
 * xterm decides what to emit for IME/dictation input in
 * `_handleAnyTextareaChanges`, which diffs the textarea with a string replace:
 *
 * ```js
 * const i = t.replace(e, "");
 * t.length > e.length ? trigger(i)
 *   : t.length < e.length ? trigger(DEL)
 *   : t !== e && trigger(t);
 * ```
 *
 * That holds only while the buffer grows by appending. iOS keyboard dictation
 * does not append: it commits words as you speak and then makes a
 * post-processing pass that rewrites earlier ones. Once an earlier word
 * changes, the old value is no longer a substring of the new one, `replace`
 * returns the new value untouched, and xterm sends the ENTIRE buffer again -
 * so every following word re-sends a longer copy of the whole message. The
 * other two branches fail the same way: a shrink emits exactly one delete no
 * matter how much was removed, and an equal-length rewrite emits the whole
 * buffer without deleting anything.
 *
 * The textarea itself is not ambiguous - it holds exactly what has been
 * dictated so far. So while it is non-empty we ignore xterm's payload, keep
 * our own record of what the PTY has already received from this buffer, and
 * send the minimal correction between the two.
 */

/** ASCII DEL: what xterm sends for a backspace, and what shells read as one. */
const DEL = "\u007F";

const CONTROL_CHARACTER = /[\u0000-\u001F]/;

/**
 * Payloads a textarea cannot explain - Enter, arrows, Ctrl chords, mouse
 * reports - are real key events rather than edits to the dictated text, so
 * they pass through untouched. A lone DEL is the exception: it is xterm's
 * under-counted shrink, and the textarea knows the true extent.
 */
export function isTextareaExplicablePayload(payload: string): boolean {
  if (payload === DEL) return true;
  return payload.length > 0 && !CONTROL_CHARACTER.test(payload);
}

/**
 * Minimal edit that turns `previous` into `next`: delete back to the common
 * prefix, then type the rest.
 *
 * Counted in code points rather than UTF-16 units, so deleting an emoji or a
 * combining accent removes one character in the shell rather than half of one.
 */
export function reconcileDictatedBuffer(previous: string, next: string): string {
  if (previous === next) return "";
  const previousChars = Array.from(previous);
  const nextChars = Array.from(next);
  let shared = 0;
  while (
    shared < previousChars.length &&
    shared < nextChars.length &&
    previousChars[shared] === nextChars[shared]
  ) {
    shared += 1;
  }
  return DEL.repeat(previousChars.length - shared) + nextChars.slice(shared).join("");
}

export type TerminalDictationState = {
  /** Text this textarea buffer has already contributed to the PTY. */
  readonly forwarded: string;
};

export type TerminalDictationResolution = {
  /** Exactly what to write to the PTY; empty means write nothing. */
  readonly payload: string;
  readonly state: TerminalDictationState;
};

export const emptyTerminalDictationState: TerminalDictationState = { forwarded: "" };

/**
 * Decide what to write for one `onData` payload.
 *
 * `textareaValue` is `terminal.textarea.value` read at the moment the payload
 * arrived. Empty means no input method is holding text, so the payload is an
 * ordinary keystroke and passes straight through.
 */
export function resolveTerminalDictationInput(input: {
  readonly payload: string;
  readonly textareaValue: string;
  readonly state: TerminalDictationState;
}): TerminalDictationResolution {
  if (input.textareaValue.length === 0) {
    return { payload: input.payload, state: emptyTerminalDictationState };
  }
  if (input.textareaValue === input.state.forwarded && input.payload !== input.textareaValue) {
    // The textarea has not moved since we last forwarded it, and this payload
    // is not a resend of it, so it cannot be an edit to the dictated text.
    //
    // This is ordinary typing. xterm serves normal keys from `keydown` and
    // emits them without ever touching the textarea, so a buffer left sitting
    // there - by dictation, an IME, or a press-and-hold accent menu - stays
    // non-empty behind every subsequent keystroke. Reconciling those against
    // an unchanged buffer produced an empty payload every time, which the
    // caller drops: typing died completely until something happened to clear
    // the textarea. A resend of the whole buffer still falls through to the
    // reconciliation below, so it is still collapsed rather than duplicated.
    return { payload: input.payload, state: input.state };
  }
  if (!isTextareaExplicablePayload(input.payload)) {
    // A control payload does not change the dictated text, so what we have
    // already forwarded still stands.
    return { payload: input.payload, state: input.state };
  }
  return {
    payload: reconcileDictatedBuffer(input.state.forwarded, input.textareaValue),
    state: { forwarded: input.textareaValue },
  };
}
