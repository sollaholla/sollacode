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

/**
 * Safari-shaped recogniser: `stop()` does NOT fire `end` on its own, so the
 * test decides whether the browser ever reports the end of the session.
 */
function silentStopRecognition(): {
  readonly recognition: SpeechRecognitionLike;
  readonly emit: (value: SpeechRecognitionEventLike) => void;
  readonly end: () => void;
} {
  const recognition: SpeechRecognitionLike = {
    lang: "",
    continuous: false,
    interimResults: false,
    start: vi.fn(),
    stop: vi.fn(),
    abort: vi.fn(),
    onresult: null,
    onerror: null,
    onend: null,
  };
  return {
    recognition,
    emit: (value) => recognition.onresult?.(value),
    end: () => recognition.onend?.(),
  };
}

describe("startNativeSpeechDictation on Safari", () => {
  it("delivers the interim tail when stop ends the session before it is finalised", async () => {
    const fake = fakeRecognition();
    const session = startNativeSpeechDictation({
      create: () => fake.recognition,
      lang: "en-US",
    });
    fake.emit(event(0, [{ text: "run the", isFinal: true }]));
    fake.emit(
      event(1, [
        { text: "run the", isFinal: true },
        { text: "tests please", isFinal: false },
      ]),
    );
    await expect(session.stop()).resolves.toBe("run the tests please");
  });

  it("listens again when iOS ends the session while the button is still held", async () => {
    const fake = fakeRecognition();
    const session = startNativeSpeechDictation({
      create: () => fake.recognition,
      lang: "en-US",
    });
    fake.emit(event(0, [{ text: "first half", isFinal: true }]));
    fake.end();
    expect(fake.recognition.start).toHaveBeenCalledTimes(2);
    // The new session numbers its results from zero again.
    fake.emit(event(0, [{ text: "second half", isFinal: true }]));
    await expect(session.stop()).resolves.toBe("first half second half");
  });

  it("commits interim text across an automatic restart", async () => {
    const fake = fakeRecognition();
    const session = startNativeSpeechDictation({
      create: () => fake.recognition,
      lang: "en-US",
    });
    fake.emit(event(0, [{ text: "hello there", isFinal: false }]));
    fake.end();
    fake.emit(event(0, [{ text: "again", isFinal: true }]));
    await expect(session.stop()).resolves.toBe("hello there again");
  });

  it("stops re-opening after repeated silent sessions", async () => {
    const fake = fakeRecognition();
    const session = startNativeSpeechDictation({
      create: () => fake.recognition,
      lang: "en-US",
      maxSilentRestarts: 2,
    });
    fake.end();
    fake.end();
    fake.end();
    fake.end();
    // Initial start plus two retries; the third silent end is final.
    expect(fake.recognition.start).toHaveBeenCalledTimes(3);
    await expect(session.stop()).resolves.toBe("");
    expect(fake.stopped()).toBe(0);
  });

  it("does not listen again once stop was requested", async () => {
    const fake = fakeRecognition();
    const session = startNativeSpeechDictation({
      create: () => fake.recognition,
      lang: "en-US",
    });
    fake.emit(event(0, [{ text: "done", isFinal: true }]));
    await expect(session.stop()).resolves.toBe("done");
    expect(fake.recognition.start).toHaveBeenCalledTimes(1);
  });

  it("delivers what was heard when the recogniser never reports end after stop", async () => {
    const fake = silentStopRecognition();
    let pending: (() => void) | null = null;
    const session = startNativeSpeechDictation({
      create: () => fake.recognition,
      lang: "en-US",
      setTimeout: (callback) => {
        pending = callback;
        return "timer";
      },
      clearTimeout: () => {
        pending = null;
      },
    });
    fake.emit(event(0, [{ text: "still here", isFinal: true }]));
    const stopped = session.stop();
    expect(fake.recognition.stop).toHaveBeenCalledTimes(1);
    expect(pending).not.toBeNull();
    pending!();
    await expect(stopped).resolves.toBe("still here");
    expect(fake.recognition.abort).toHaveBeenCalledTimes(1);
  });

  it("cancels the stop timeout once the browser reports end", async () => {
    const fake = silentStopRecognition();
    const cleared: unknown[] = [];
    const session = startNativeSpeechDictation({
      create: () => fake.recognition,
      lang: "en-US",
      setTimeout: () => "timer",
      clearTimeout: (handle) => {
        cleared.push(handle);
      },
    });
    fake.emit(event(0, [{ text: "prompt", isFinal: true }]));
    const stopped = session.stop();
    fake.end();
    await expect(stopped).resolves.toBe("prompt");
    expect(cleared).toEqual(["timer"]);
  });

  it("gives up on a restart the browser refuses without losing the transcript", async () => {
    const fake = fakeRecognition();
    let starts = 0;
    fake.recognition.start = () => {
      starts += 1;
      if (starts > 1) throw new Error("not allowed");
    };
    const session = startNativeSpeechDictation({
      create: () => fake.recognition,
      lang: "en-US",
    });
    fake.emit(event(0, [{ text: "kept", isFinal: true }]));
    fake.end();
    await expect(session.stop()).resolves.toBe("kept");
  });
});
