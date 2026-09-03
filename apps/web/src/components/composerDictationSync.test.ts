import { describe, expect, it } from "vite-plus/test";

import {
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
