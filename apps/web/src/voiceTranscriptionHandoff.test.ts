import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  forgetPendingTranscriptionToast,
  registerPendingTranscriptionToast,
  resetPendingTranscriptionToastsForTests,
  takePendingTranscriptionToast,
} from "./voiceTranscriptionHandoff";

afterEach(() => {
  resetPendingTranscriptionToastsForTests();
});

describe("pending transcription toast handoff", () => {
  it("has nothing to hand back for a thread that raised no toast", () => {
    expect(takePendingTranscriptionToast("env:thread-a")).toBeNull();
  });

  // Returning to the thread must retire the toast, or the composer draft and
  // the toast's Send button both hold the same words and it sends twice.
  it("hands the toast back to the thread it came from", () => {
    registerPendingTranscriptionToast("env:thread-a", "toast-7");
    expect(takePendingTranscriptionToast("env:thread-a")).toBe("toast-7");
  });

  it("only hands it back once", () => {
    registerPendingTranscriptionToast("env:thread-a", "toast-7");
    takePendingTranscriptionToast("env:thread-a");
    expect(takePendingTranscriptionToast("env:thread-a")).toBeNull();
  });

  it("does not hand a toast to a different thread", () => {
    registerPendingTranscriptionToast("env:thread-a", "toast-7");
    expect(takePendingTranscriptionToast("env:thread-b")).toBeNull();
    expect(takePendingTranscriptionToast("env:thread-a")).toBe("toast-7");
  });

  it("forgets a toast that was already closed by Send", () => {
    registerPendingTranscriptionToast("env:thread-a", "toast-7");
    forgetPendingTranscriptionToast("env:thread-a");
    expect(takePendingTranscriptionToast("env:thread-a")).toBeNull();
  });

  it("keeps the newest toast when a thread produces another transcript", () => {
    registerPendingTranscriptionToast("env:thread-a", "toast-7");
    registerPendingTranscriptionToast("env:thread-a", "toast-9");
    expect(takePendingTranscriptionToast("env:thread-a")).toBe("toast-9");
  });

  it("ignores an empty thread key rather than colliding on it", () => {
    registerPendingTranscriptionToast("", "toast-7");
    expect(takePendingTranscriptionToast("")).toBeNull();
  });
});
