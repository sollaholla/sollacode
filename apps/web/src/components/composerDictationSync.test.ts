import { describe, expect, it } from "vite-plus/test";

import {
  COMPOSER_ECHO_MEMORY_MS,
  resolveComposerReplacement,
  isComposerStaleEcho,
  rememberComposerEmittedValue,
  resolveComposerControlledSync,
  resolveComposerDictationFlush,
} from "./composerDictationSync";

const base = {
  incomingValue: "hello world",
  incomingCursor: 11,
  snapshotValue: "hello world",
  snapshotCursor: 11,
  contextsChanged: false,
  skillsChanged: false,
  isFocused: true,
  isDictating: false,
  isStaleEcho: false,
};

describe("resolveComposerControlledSync", () => {
  it("skips when the props already match what the editor emitted", () => {
    expect(resolveComposerControlledSync(base)).toEqual({ kind: "skip" });
  });

  it("rewrites the editor for an external value change", () => {
    expect(
      resolveComposerControlledSync({ ...base, incomingValue: "pasted text", incomingCursor: 11 }),
    ).toEqual({ kind: "apply", rewrite: true, setSelection: true });
  });

  it("restores the caret for a cursor-only change while focused", () => {
    expect(resolveComposerControlledSync({ ...base, incomingCursor: 4 })).toEqual({
      kind: "apply",
      rewrite: false,
      setSelection: true,
    });
  });

  it("ignores a cursor-only change while unfocused", () => {
    expect(resolveComposerControlledSync({ ...base, incomingCursor: 4, isFocused: false })).toEqual(
      { kind: "skip" },
    );
  });

  it("rewrites when inline chips change even without a text change", () => {
    expect(resolveComposerControlledSync({ ...base, contextsChanged: true })).toEqual({
      kind: "apply",
      rewrite: true,
      setSelection: true,
    });
  });

  // The dictation bug: a lagging echo of an earlier edit arrives mid-sentence.
  // Applying it would clear the root under the words dictation is still
  // rewriting, dropping them and leaving the spaces behind.
  it("defers a stale value that arrives while dictating", () => {
    expect(
      resolveComposerControlledSync({
        ...base,
        snapshotValue: "call me at four thirty",
        incomingValue: "call me at four",
        incomingCursor: 15,
        isDictating: true,
      }),
    ).toEqual({ kind: "defer" });
  });

  it("defers the caret force-move while dictating", () => {
    expect(
      resolveComposerControlledSync({ ...base, incomingCursor: 4, isDictating: true }),
    ).toEqual({ kind: "defer" });
  });

  it("defers a chip change while dictating rather than rebuilding nodes", () => {
    expect(
      resolveComposerControlledSync({ ...base, contextsChanged: true, isDictating: true }),
    ).toEqual({ kind: "defer" });
  });

  it("still skips a no-op while dictating so idle renders stay free", () => {
    expect(resolveComposerControlledSync({ ...base, isDictating: true })).toEqual({ kind: "skip" });
  });
});

describe("resolveComposerDictationFlush", () => {
  it("adopts the editor's text when props lagged behind the spoken words", () => {
    expect(
      resolveComposerDictationFlush({
        contextsChanged: false,
        skillsChanged: false,
        valueDiverged: true,
      }),
    ).toEqual({ kind: "adopt-editor" });
  });

  it("rebuilds when chips changed, since chips only exist as nodes", () => {
    expect(
      resolveComposerDictationFlush({
        contextsChanged: true,
        skillsChanged: false,
        valueDiverged: true,
      }),
    ).toEqual({ kind: "rewrite" });
  });

  it("reports no divergence when the props caught up on their own", () => {
    expect(
      resolveComposerDictationFlush({
        contextsChanged: false,
        skillsChanged: false,
        valueDiverged: false,
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("isComposerStaleEcho", () => {
  const now = 10_000;

  it("recognises a value the editor emitted a moment ago", () => {
    // iOS dictation streams "hello", then "hello there". The store hands back
    // "hello" one render later, which is the write-back that reverts the word.
    const history = rememberComposerEmittedValue([], "hello", now - 20);
    expect(
      isComposerStaleEcho({
        history,
        incomingValue: "hello",
        snapshotValue: "hello there",
        now,
      }),
    ).toBe(true);
  });

  it("does not treat the editor agreeing with its props as an echo", () => {
    const history = rememberComposerEmittedValue([], "hello", now - 20);
    expect(
      isComposerStaleEcho({ history, incomingValue: "hello", snapshotValue: "hello", now }),
    ).toBe(false);
  });

  it("lets a genuine external set through", () => {
    const history = rememberComposerEmittedValue([], "hello", now - 20);
    expect(
      isComposerStaleEcho({
        history,
        incomingValue: "a transcript arrived",
        snapshotValue: "hello there",
        now,
      }),
    ).toBe(false);
  });

  it("forgets an echo old enough to be a deliberate reset", () => {
    const history = rememberComposerEmittedValue([], "hello", now - COMPOSER_ECHO_MEMORY_MS - 1);
    expect(
      isComposerStaleEcho({
        history,
        incomingValue: "hello",
        snapshotValue: "hello there",
        now,
      }),
    ).toBe(false);
  });

  it("bounds the history over a long dictation", () => {
    let history = rememberComposerEmittedValue([], "start", now);
    for (let index = 0; index < 200; index += 1) {
      history = rememberComposerEmittedValue(history, `word ${String(index)}`, now + index);
    }
    expect(history.length).toBeLessThanOrEqual(32);
  });
});

describe("resolveComposerControlledSync with a stale echo", () => {
  it("keeps the dictated text instead of rebuilding from the lagging value", () => {
    expect(
      resolveComposerControlledSync({
        ...base,
        incomingValue: "hello",
        snapshotValue: "hello there",
        isStaleEcho: true,
      }),
    ).toEqual({ kind: "skip" });
  });

  it("still applies a chip change that arrived alongside the echo", () => {
    expect(
      resolveComposerControlledSync({
        ...base,
        incomingValue: "hello",
        snapshotValue: "hello there",
        isStaleEcho: true,
        contextsChanged: true,
      }),
    ).toEqual({ kind: "apply", rewrite: true, setSelection: true });
  });

  it("defers to dictation before considering the echo", () => {
    expect(
      resolveComposerControlledSync({
        ...base,
        incomingValue: "hello",
        snapshotValue: "hello there",
        isStaleEcho: true,
        isDictating: true,
      }),
    ).toEqual({ kind: "defer" });
  });
});

describe("resolveComposerReplacement", () => {
  it("lets a replacement through when the clipboard payload has the new text", () => {
    expect(resolveComposerReplacement({ dataTransferText: "their", data: null })).toEqual({
      kind: "allow",
    });
  });

  it("lets a replacement through when there is no dataTransfer and data has the text", () => {
    expect(resolveComposerReplacement({ dataTransferText: null, data: "their" })).toEqual({
      kind: "allow",
    });
  });

  it("blocks a replacement that carries no replacement text at all", () => {
    // The selection already covers the word. Letting this through replaces it
    // with nothing, which is the word loss with the spaces left behind.
    expect(resolveComposerReplacement({ dataTransferText: "", data: null })).toEqual({
      kind: "block",
    });
    expect(resolveComposerReplacement({ dataTransferText: null, data: null })).toEqual({
      kind: "block",
    });
    expect(resolveComposerReplacement({ dataTransferText: "", data: "" })).toEqual({
      kind: "block",
    });
  });

  it("applies the text itself when an empty dataTransfer would win over data", () => {
    // Lexical prefers a non-null dataTransfer, so an empty one erases the word
    // even though the replacement text is sitting in `data`.
    expect(resolveComposerReplacement({ dataTransferText: "", data: "their" })).toEqual({
      kind: "insert",
      text: "their",
    });
  });
});
