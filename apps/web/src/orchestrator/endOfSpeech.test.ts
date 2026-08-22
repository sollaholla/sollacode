import { describe, expect, it } from "vite-plus/test";

import {
  CONTINUATION_GRACE_MS,
  decideEndOfSpeech,
  isNoiseTranscript,
  isUtteranceComplete,
} from "./endOfSpeech";

describe("isUtteranceComplete", () => {
  it("treats a trailing ellipsis as still thinking", () => {
    // The reported failure: the model answers the first half of a sentence and
    // the rest arrives as a second turn nobody wanted.
    expect(isUtteranceComplete("so what I want to do is...")).toBe(false);
    expect(isUtteranceComplete("so what I want to do is…")).toBe(false);
  });

  it("does not mistake an ellipsis for a full stop", () => {
    // "..." ends in a dot, so the terminator test alone would pass it.
    expect(isUtteranceComplete("hang on...")).toBe(false);
    expect(isUtteranceComplete("hang on....")).toBe(false);
  });

  it("treats a closed sentence as finished", () => {
    expect(isUtteranceComplete("what is running right now?")).toBe(true);
    expect(isUtteranceComplete("stop that thread.")).toBe(true);
    expect(isUtteranceComplete("do it!")).toBe(true);
  });

  it("treats a blank transcript as finished", () => {
    // Nothing to wait for, and holding a turn open on silence hangs the session.
    expect(isUtteranceComplete("")).toBe(true);
    expect(isUtteranceComplete("   ")).toBe(true);
  });

  it("ignores trailing whitespace either side of the verdict", () => {
    expect(isUtteranceComplete("give me a second...  ")).toBe(false);
    expect(isUtteranceComplete("that is all.  ")).toBe(true);
  });

  it("answers an unpunctuated command rather than holding it", () => {
    // Deliberately NOT treated as unfinished. Transcribers do not reliably
    // punctuate short commands, and requiring a full stop would make every
    // ordinary turn pay the grace period to catch an occasional trail-off.
    expect(isUtteranceComplete("stop that thread")).toBe(true);
    expect(isUtteranceComplete("and then the other thing")).toBe(true);
  });
});

describe("decideEndOfSpeech", () => {
  it("waits when the user trailed off", () => {
    expect(decideEndOfSpeech({ text: "I was thinking...", waitedAlready: false })).toEqual({
      kind: "wait-for-continuation",
      graceMs: CONTINUATION_GRACE_MS,
    });
  });

  it("answers a finished sentence immediately", () => {
    expect(decideEndOfSpeech({ text: "what is running?", waitedAlready: false })).toEqual({
      kind: "answer",
    });
  });

  it("never waits twice", () => {
    // Someone who habitually trails off would otherwise never be answered.
    expect(decideEndOfSpeech({ text: "and then...", waitedAlready: true })).toEqual({
      kind: "answer",
    });
  });

  it("honours an injected grace for tests and tuning", () => {
    expect(decideEndOfSpeech({ text: "hold on...", waitedAlready: false, graceMs: 10 })).toEqual({
      kind: "wait-for-continuation",
      graceMs: 10,
    });
  });
});

describe("isNoiseTranscript", () => {
  it("treats a punctuation-only turn as noise", () => {
    expect(isNoiseTranscript(".")).toBe(true);
    expect(isNoiseTranscript("…")).toBe(true);
    expect(isNoiseTranscript("?!")).toBe(true);
  });

  it("treats a transcriber's non-speech marker as noise", () => {
    expect(isNoiseTranscript("[BLANK_AUDIO]")).toBe(true);
    expect(isNoiseTranscript("(silence)")).toBe(true);
    expect(isNoiseTranscript("[ Music ]")).toBe(true);
  });

  it("never treats an empty transcript as noise", () => {
    // Transcription lags, fails, and returns nothing for short speech, so
    // "empty" covers a door closing *and* someone saying "yes". Discarding it
    // stopped the session answering after the first turn.
    expect(isNoiseTranscript("")).toBe(false);
    expect(isNoiseTranscript("   ")).toBe(false);
  });

  it("never discards a real one-word answer", () => {
    // The whole risk of this filter: someone says "yes" and is ignored.
    expect(isNoiseTranscript("yes")).toBe(false);
    expect(isNoiseTranscript("no")).toBe(false);
    expect(isNoiseTranscript("Vera")).toBe(false);
    expect(isNoiseTranscript("42")).toBe(false);
    expect(isNoiseTranscript("да")).toBe(false);
  });
});

describe("decideEndOfSpeech on a noise turn", () => {
  it("discards it rather than answering, so nothing is said aloud", () => {
    // Answering an empty turn is what produced "I didn't catch that" every
    // time anything happened in the room.
    expect(decideEndOfSpeech({ text: "[BLANK_AUDIO]", waitedAlready: false })).toEqual({
      kind: "discard",
    });
    expect(decideEndOfSpeech({ text: "...", waitedAlready: true })).toEqual({ kind: "discard" });
    // An empty transcript is answered, not discarded — see isNoiseTranscript.
    expect(decideEndOfSpeech({ text: "", waitedAlready: false })).toEqual({ kind: "answer" });
  });

  it("still answers anything with words in it", () => {
    expect(decideEndOfSpeech({ text: "hello", waitedAlready: false })).toEqual({ kind: "answer" });
  });
});
