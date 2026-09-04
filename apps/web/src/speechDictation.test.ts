import { describe, expect, it, vi } from "vite-plus/test";

import {
  foldSpeechRecognitionEvent,
  joinSpeechSegments,
  shouldPreferNativeSpeechDictation,
  startNativeSpeechDictation,
  type SpeechRecognitionEventLike,
  type SpeechRecognitionLike,
} from "./speechDictation.ts";

/** Shape one recogniser event the way Safari reports it. */
function event(
  resultIndex: number,
  results: readonly { readonly text: string; readonly isFinal: boolean }[],
): SpeechRecognitionEventLike {
  const list = results.map((result) => ({
    isFinal: result.isFinal,
    length: 1,
    0: { transcript: result.text },
  }));
  return {
    resultIndex,
    results: Object.assign({ length: list.length }, list) as never,
  };
}

function fakeRecognition(): {
  readonly recognition: SpeechRecognitionLike;
  readonly emit: (value: SpeechRecognitionEventLike) => void;
  readonly fail: (error: string) => void;
  readonly end: () => void;
  readonly stopped: () => number;
} {
  let stops = 0;
  const recognition: SpeechRecognitionLike = {
    lang: "",
    continuous: false,
    interimResults: false,
    start: vi.fn(),
    stop: vi.fn(() => {
      stops += 1;
      recognition.onend?.();
    }),
    abort: vi.fn(),
    onresult: null,
    onerror: null,
    onend: null,
  };
  return {
    recognition,
    emit: (value) => recognition.onresult?.(value),
    fail: (error) => recognition.onerror?.({ error }),
    end: () => recognition.onend?.(),
    stopped: () => stops,
  };
}

describe("shouldPreferNativeSpeechDictation", () => {
  it("drives the recogniser on a touch client with no desktop bridge", () => {
    expect(
      shouldPreferNativeSpeechDictation({
        hasDesktopBridge: false,
        hasCoarsePointer: true,
        hasRecognizer: true,
      }),
    ).toBe(true);
  });

  it("leaves the desktop bridge path alone", () => {
    expect(
      shouldPreferNativeSpeechDictation({
        hasDesktopBridge: true,
        hasCoarsePointer: true,
        hasRecognizer: true,
      }),
    ).toBe(false);
  });

  it("does not change recogniser out from under desktop web", () => {
    expect(
      shouldPreferNativeSpeechDictation({
        hasDesktopBridge: false,
        hasCoarsePointer: false,
        hasRecognizer: true,
      }),
    ).toBe(false);
  });

  it("stays off where the browser has no recogniser", () => {
    expect(
      shouldPreferNativeSpeechDictation({
        hasDesktopBridge: false,
        hasCoarsePointer: true,
        hasRecognizer: false,
      }),
    ).toBe(false);
  });
});

describe("joinSpeechSegments", () => {
  it("joins with exactly one space", () => {
    expect(joinSpeechSegments("hello", "there")).toBe("hello there");
    expect(joinSpeechSegments("hello ", "  there ")).toBe("hello there");
  });

  it("keeps either side alone when the other is empty", () => {
    expect(joinSpeechSegments("", "hello")).toBe("hello");
    expect(joinSpeechSegments("hello", "   ")).toBe("hello");
  });
});

describe("foldSpeechRecognitionEvent", () => {
  it("commits only finalised results", () => {
    const folded = foldSpeechRecognitionEvent({
      committed: "",
      event: event(0, [{ text: "hello there", isFinal: true }]),
    });
    expect(folded).toEqual({ committed: "hello there", interim: "" });
  });

  it("keeps interim text out of the committed transcript", () => {
    const folded = foldSpeechRecognitionEvent({
      committed: "hello",
      event: event(0, [{ text: "there fri", isFinal: false }]),
    });
    expect(folded).toEqual({ committed: "hello", interim: "there fri" });
  });

  it("replaces interim text rather than accumulating it", () => {
    // The recogniser re-reports the tail it is still deciding on. Appending it
    // is what would repeat the same phrase over and over.
    const first = foldSpeechRecognitionEvent({
      committed: "",
      event: event(0, [{ text: "super", isFinal: false }]),
    });
    const second = foldSpeechRecognitionEvent({
      committed: first.committed,
      event: event(0, [{ text: "supercalifragilistic", isFinal: false }]),
    });
    expect(second.interim).toBe("supercalifragilistic");
    expect(second.committed).toBe("");
  });

  it("only reads results from resultIndex onward", () => {
    const folded = foldSpeechRecognitionEvent({
      committed: "already said",
      event: event(1, [
        { text: "already said", isFinal: true },
        { text: "and this", isFinal: true },
      ]),
    });
    expect(folded.committed).toBe("already said and this");
  });
});

describe("startNativeSpeechDictation", () => {
  it("resolves with everything committed when stopped", async () => {
    const fake = fakeRecognition();
    const session = startNativeSpeechDictation({
      create: () => fake.recognition,
      lang: "en-US",
    });
    fake.emit(event(0, [{ text: "run the tests", isFinal: true }]));
    await expect(session.stop()).resolves.toBe("run the tests");
    expect(fake.stopped()).toBe(1);
  });

  it("configures the recogniser for continuous interim dictation", () => {
    const fake = fakeRecognition();
    startNativeSpeechDictation({ create: () => fake.recognition, lang: "en-GB" });
    expect(fake.recognition.lang).toBe("en-GB");
    expect(fake.recognition.continuous).toBe(true);
    expect(fake.recognition.interimResults).toBe(true);
  });

  it("reports interim text without committing it", () => {
    const fake = fakeRecognition();
    const session = startNativeSpeechDictation({
      create: () => fake.recognition,
      lang: "en-US",
    });
    const seen: string[] = [];
    session.onInterim((interim) => seen.push(interim));
    fake.emit(event(0, [{ text: "hello th", isFinal: false }]));
    expect(seen).toEqual(["hello th"]);
  });

  it("keeps what was heard when iOS ends the session on silence", async () => {
    const fake = fakeRecognition();
    const session = startNativeSpeechDictation({
      create: () => fake.recognition,
      lang: "en-US",
    });
    fake.emit(event(0, [{ text: "half a sentence", isFinal: true }]));
    fake.end();
    await expect(session.stop()).resolves.toBe("half a sentence");
  });

  it("treats silence and abort as outcomes rather than failures", async () => {
    const fake = fakeRecognition();
    const session = startNativeSpeechDictation({
      create: () => fake.recognition,
      lang: "en-US",
    });
    fake.emit(event(0, [{ text: "something", isFinal: true }]));
    fake.fail("no-speech");
    await expect(session.stop()).resolves.toBe("something");
  });

  it("surfaces a real recogniser failure", async () => {
    const fake = fakeRecognition();
    const session = startNativeSpeechDictation({
      create: () => fake.recognition,
      lang: "en-US",
    });
    // A real failure arrives while listening, before anyone stops the session.
    fake.fail("network");
    await expect(session.stop()).rejects.toThrow("network");
  });
});
