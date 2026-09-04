import { describe, expect, it } from "vite-plus/test";

import {
  emptyTerminalDictationState,
  isTextareaExplicablePayload,
  reconcileDictatedBuffer,
  resolveTerminalDictationInput,
  type TerminalDictationState,
} from "./dictationInput.ts";

const DEL = "\u007F";
const ENTER = "\r";

/**
 * xterm 6.0.0's `_handleAnyTextareaChanges`, transcribed from the shipped
 * bundle. Driving the real thing needs a laid-out terminal and a real IME, so
 * the model stands in for it: everything this file claims about xterm is a
 * claim about these five lines.
 */
function xtermEmitForTextareaChange(before: string, after: string): string | null {
  const diff = after.replace(before, "");
  if (after.length > before.length) return diff;
  if (after.length < before.length) return DEL;
  if (after !== before) return after;
  return null;
}

/** What iOS keyboard dictation puts in the textarea, word by word. */
const IOS_DICTATION_TRANSCRIPT = [
  "run the",
  "run the test",
  // The post-processing pass rewrites "test" to "tests" and "the" to "these".
  "run these tests",
  "run these tests now",
] as const;

/** Replay a transcript through xterm's diff, then through our reconciliation. */
function replay(transcript: readonly string[]): {
  readonly xtermSent: readonly string[];
  readonly reconciledSent: readonly string[];
} {
  const xtermSent: string[] = [];
  const reconciledSent: string[] = [];
  let state: TerminalDictationState = emptyTerminalDictationState;
  let previousTextarea = "";
  for (const textareaValue of transcript) {
    const emitted = xtermEmitForTextareaChange(previousTextarea, textareaValue);
    previousTextarea = textareaValue;
    if (emitted === null) continue;
    xtermSent.push(emitted);
    const resolved = resolveTerminalDictationInput({
      payload: emitted,
      textareaValue,
      state,
    });
    state = resolved.state;
    if (resolved.payload.length > 0) reconciledSent.push(resolved.payload);
  }
  return { xtermSent, reconciledSent };
}

/** Apply shell-style input to a line buffer so we can assert what lands. */
function applyToShellLine(chunks: readonly string[]): string {
  let line: string[] = [];
  for (const chunk of chunks) {
    for (const character of Array.from(chunk)) {
      if (character === DEL) line.pop();
      else line.push(character);
    }
  }
  return line.join("");
}

describe("reconcileDictatedBuffer", () => {
  it("sends nothing when the buffer did not move", () => {
    expect(reconcileDictatedBuffer("run these tests", "run these tests")).toBe("");
  });

  it("sends only the tail when the buffer grew by appending", () => {
    expect(reconcileDictatedBuffer("run the", "run the test")).toBe(" test");
  });

  it("deletes back to the common prefix before retyping a rewritten word", () => {
    // "run the test" -> "run these tests" shares "run the".
    expect(reconcileDictatedBuffer("run the test", "run these tests")).toBe(
      `${DEL.repeat(5)}se tests`,
    );
  });

  it("deletes every character the rewrite removed, not just one", () => {
    expect(reconcileDictatedBuffer("hello there", "hello")).toBe(DEL.repeat(6));
  });

  it("counts code points so an emoji is one delete rather than half of one", () => {
    expect(reconcileDictatedBuffer("ok 🙂", "ok")).toBe(DEL.repeat(2));
  });
});

describe("isTextareaExplicablePayload", () => {
  it("treats plain text and a lone delete as textarea edits", () => {
    expect(isTextareaExplicablePayload("tests")).toBe(true);
    expect(isTextareaExplicablePayload(DEL)).toBe(true);
  });

  it("passes real key events through untouched", () => {
    expect(isTextareaExplicablePayload(ENTER)).toBe(false);
    expect(isTextareaExplicablePayload("\u0003")).toBe(false);
    expect(isTextareaExplicablePayload("\u001B[A")).toBe(false);
  });
});

/**
 * Captured from the user's iPhone on 0.1.400, dictating "this is a test to see
 * if terminal properly" into Terminal 1 with the iOS keyboard mic.
 *
 * `emitted` is what xterm actually sent, recovered by segmenting the corrupted
 * shell line; `textarea` is what the dictation buffer held at that moment.
 * From the third word on, every emission is the entire buffer again.
 */
const IPHONE_CAPTURE = [
  { emitted: "th", textarea: "th" },
  { emitted: "ith is i", textarea: "this is i" },
  { emitted: "this is", textarea: "this is" },
  { emitted: "this is a test", textarea: "this is a test" },
  { emitted: "this is a test to", textarea: "this is a test to" },
  { emitted: "this is a test to see if", textarea: "this is a test to see if" },
  { emitted: "this is a test to see if term", textarea: "this is a test to see if term" },
  { emitted: "this is a test to see if terminal", textarea: "this is a test to see if terminal" },
  {
    emitted: "this is a test to see if terminal properly",
    textarea: "this is a test to see if terminal properly",
  },
] as const;

/** Exactly what the screenshot shows at the prompt. */
const IPHONE_CORRUPTED_LINE =
  "thith is ithis isthis is a testthis is a test tothis is a test to see if" +
  "this is a test to see if termthis is a test to see if terminal" +
  "this is a test to see if terminal properly";

describe("resolveTerminalDictationInput", () => {
  it("reproduces the exponential duplication xterm produces today", () => {
    const { xtermSent } = replay(IOS_DICTATION_TRANSCRIPT);
    // The rewrite makes the old value stop being a substring, so `replace`
    // returns the whole buffer and xterm sends the entire message again.
    expect(xtermSent).toContain("run these tests");
    expect(applyToShellLine(xtermSent)).toBe("run the testrun these tests now");
  });

  it("sends the dictated line exactly once through the reconciliation", () => {
    const { reconciledSent } = replay(IOS_DICTATION_TRANSCRIPT);
    expect(applyToShellLine(reconciledSent)).toBe("run these tests now");
  });

  it("reproduces the line the user's iPhone actually left at the prompt", () => {
    expect(applyToShellLine(IPHONE_CAPTURE.map((step) => step.emitted))).toBe(
      IPHONE_CORRUPTED_LINE,
    );
  });

  it("leaves the sentence the user actually dictated", () => {
    // The emissions are ignored while the textarea holds text, so the garbled
    // second one costs nothing: the buffer is what the correction is built from.
    let state: TerminalDictationState = emptyTerminalDictationState;
    const sent: string[] = [];
    for (const step of IPHONE_CAPTURE) {
      const resolved = resolveTerminalDictationInput({
        payload: step.emitted,
        textareaValue: step.textarea,
        state,
      });
      state = resolved.state;
      if (resolved.payload.length > 0) sent.push(resolved.payload);
    }
    expect(applyToShellLine(sent)).toBe("this is a test to see if terminal properly");
  });

  it("passes ordinary typing straight through when no buffer is held", () => {
    const resolved = resolveTerminalDictationInput({
      payload: "a",
      textareaValue: "",
      state: emptyTerminalDictationState,
    });
    expect(resolved.payload).toBe("a");
    expect(resolved.state).toEqual(emptyTerminalDictationState);
  });

  it("forgets the buffer once the textarea is cleared", () => {
    const dictated = resolveTerminalDictationInput({
      payload: "hello",
      textareaValue: "hello",
      state: emptyTerminalDictationState,
    });
    expect(dictated.state.forwarded).toBe("hello");
    const submitted = resolveTerminalDictationInput({
      payload: ENTER,
      textareaValue: "",
      state: dictated.state,
    });
    expect(submitted.payload).toBe(ENTER);
    expect(submitted.state).toEqual(emptyTerminalDictationState);
  });

  it("does not let Enter mid-dictation retract what was already sent", () => {
    const dictated = resolveTerminalDictationInput({
      payload: "hello",
      textareaValue: "hello",
      state: emptyTerminalDictationState,
    });
    const enter = resolveTerminalDictationInput({
      payload: ENTER,
      textareaValue: "hello",
      state: dictated.state,
    });
    expect(enter.payload).toBe(ENTER);
    expect(enter.state.forwarded).toBe("hello");
  });

  it("keeps typing alive when a stale buffer is left sitting in the textarea", () => {
    // Dictation (or a press-and-hold accent menu) leaves text in the textarea
    // and we forward it once.
    const dictated = resolveTerminalDictationInput({
      payload: "hello",
      textareaValue: "hello",
      state: emptyTerminalDictationState,
    });
    expect(dictated.payload).toBe("hello");

    // Now the user just types. xterm handles ordinary keys from `keydown` and
    // emits onData WITHOUT touching the textarea, so that buffer is still
    // sitting there unchanged - which used to reconcile every keystroke away
    // to nothing and kill typing entirely until the textarea happened to clear.
    const first = resolveTerminalDictationInput({
      payload: "x",
      textareaValue: "hello",
      state: dictated.state,
    });
    expect(first.payload).toBe("x");

    const second = resolveTerminalDictationInput({
      payload: "y",
      textareaValue: "hello",
      state: first.state,
    });
    expect(second.payload).toBe("y");
  });

  it("still forwards a backspace typed against a stale buffer", () => {
    const dictated = resolveTerminalDictationInput({
      payload: "hello",
      textareaValue: "hello",
      state: emptyTerminalDictationState,
    });
    const backspace = resolveTerminalDictationInput({
      payload: "\u007F",
      textareaValue: "hello",
      state: dictated.state,
    });
    expect(backspace.payload).toBe("\u007F");
  });

  it("collapses a repeated whole-buffer resend to nothing", () => {
    const first = resolveTerminalDictationInput({
      payload: "run these tests",
      textareaValue: "run these tests",
      state: emptyTerminalDictationState,
    });
    const second = resolveTerminalDictationInput({
      payload: "run these tests",
      textareaValue: "run these tests",
      state: first.state,
    });
    expect(first.payload).toBe("run these tests");
    expect(second.payload).toBe("");
  });

  it("corrects xterm's single delete when a rewrite removed several characters", () => {
    const dictated = resolveTerminalDictationInput({
      payload: "hello there",
      textareaValue: "hello there",
      state: emptyTerminalDictationState,
    });
    const shrunk = resolveTerminalDictationInput({
      payload: DEL,
      textareaValue: "hello",
      state: dictated.state,
    });
    expect(shrunk.payload).toBe(DEL.repeat(6));
  });
});
