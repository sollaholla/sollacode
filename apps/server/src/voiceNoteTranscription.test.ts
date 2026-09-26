import { describe, expect, it, vi, beforeEach } from "vite-plus/test";
import {
  readVoiceNotePcm,
  transcribeVoiceNote,
  makeVoiceNoteTranscriber,
} from "./voiceNoteTranscription.ts";

const native = vi.hoisted(() => vi.fn());
vi.mock("@t3tools/shared/nativeVoice/MacSpeechTranscription", () => ({
  transcribeMacVoice: native,
}));
vi.mock("@t3tools/shared/nativeVoice/WindowsSpeechTranscription", () => ({
  transcribeWindowsVoice: native,
}));
const fallback = vi.hoisted(() => vi.fn());
vi.mock("./voiceNoteFallback.ts", () => ({ transcribeVoiceFallback: fallback }));
const mlx = vi.hoisted(() => vi.fn());
const resolveMlx = vi.hoisted(() => vi.fn());
vi.mock("./voiceNoteMlx.ts", () => ({ transcribeVoiceMlx: mlx }));
vi.mock("./voiceNoteMlxRuntime.ts", () => ({ resolveVoiceMlxRuntime: resolveMlx }));

import { voiceWavFixture } from "./voiceNote.test-fixture.ts";

beforeEach(() => {
  native.mockReset();
  fallback.mockReset().mockResolvedValue("");
  mlx.mockReset();
  resolveMlx.mockReset().mockResolvedValue(null);
});
function quietVoiceWavFixture() {
  const bytes = voiceWavFixture();
  // The smallest nonzero PCM sample must not be classified as digital silence.
  new DataView(bytes.buffer).setInt16(44, 1, true);
  return bytes;
}

describe("voice note host transcription", () => {
  it.each(["darwin", "win32", "linux"] as const)(
    "rejects digital silence before invoking a recognizer on %s",
    async (platform) => {
      native.mockResolvedValue({ status: "success", text: "you know." });
      fallback.mockResolvedValue("you know.");
      await expect(
        transcribeVoiceNote(voiceWavFixture(), "/tmp/voice-unit-test", platform, {}),
      ).rejects.toThrow("recording contains only silence");
      expect(native).not.toHaveBeenCalled();
      expect(fallback).not.toHaveBeenCalled();
      expect(resolveMlx).not.toHaveBeenCalled();
    },
  );
  it("preserves even the quietest nonzero audio for recognition", async () => {
    native.mockResolvedValue({ status: "success", text: "Quiet voice note." });
    await expect(
      transcribeVoiceNote(quietVoiceWavFixture(), "/tmp/voice-unit-test", "darwin", {}),
    ).resolves.toBe("Quiet voice note.");
    expect(native).toHaveBeenCalledTimes(1);
  });
  it("derives duration from PCM instead of trusting uploaded metadata", () => {
    expect(readVoiceNotePcm(voiceWavFixture())).toMatchObject({ durationMs: 1000 });
  });
  it("rejects truncated, mismatched and compressed audio", () => {
    for (const audio of [
      new Uint8Array(),
      voiceWavFixture().slice(0, 100),
      new TextEncoder().encode("invalid audio"),
    ])
      expect(() => readVoiceNotePcm(audio)).toThrow();
    const stereo = voiceWavFixture();
    new DataView(stereo.buffer).setUint16(22, 2, true);
    expect(() => readVoiceNotePcm(stereo)).toThrow();
  });
  it("returns host-generated speech and passes only PCM to native recognition", async () => {
    native.mockResolvedValue({
      status: "success",
      text: "  Keep this separate from typed text.  ",
    });
    expect(
      await transcribeVoiceNote(quietVoiceWavFixture(), "/tmp/voice-unit-test", "darwin", {}),
    ).toBe("Keep this separate from typed text.");
    expect(native.mock.calls[0]?.[0]).toMatchObject({ sampleRate: 16_000 });
    expect(native.mock.calls[0]?.[0].pcm16.length).toBe(32_000);
  });
  it("rejects a second simultaneous transcription without queuing an invisible send", async () => {
    let finish!: (value: { status: string; text: string }) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    native.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
          started();
        }),
    );
    const first = transcribeVoiceNote(quietVoiceWavFixture(), "/tmp/voice-unit-test", "darwin", {});
    await expect(
      transcribeVoiceNote(quietVoiceWavFixture(), "/tmp/voice-unit-test", "darwin", {}),
    ).rejects.toThrow("another voice note");
    await ready;
    finish({ status: "success", text: "first recording" });
    await expect(first).resolves.toBe("first recording");
  });
  it("does not send a note when neither recognizer detects speech", async () => {
    native.mockResolvedValue({ status: "success", text: "" });
    await expect(
      transcribeVoiceNote(quietVoiceWavFixture(), "/tmp/voice-unit-test", "darwin", {}),
    ).rejects.toThrow("No speech");
  });
  it("uses the prepared accelerated model before native speech", async () => {
    const runtime = { pythonPath: "/managed/python", modelPath: "/managed/model" };
    resolveMlx.mockResolvedValue(runtime);
    mlx.mockResolvedValue("Is this in the live app or still in dev?");
    await expect(
      transcribeVoiceNote(quietVoiceWavFixture(), "/home/solla/userdata", "darwin", {}),
    ).resolves.toBe("Is this in the live app or still in dev?");
    expect(resolveMlx).toHaveBeenCalledWith({ baseDir: "/home/solla", platform: "darwin" });
    expect(mlx.mock.calls[0]?.[1]).toBe(runtime);
    expect(native).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });
  it.each(["runtime", "inference"])(
    "keeps native speech available after a %s failure",
    async (failure) => {
      if (failure === "runtime") resolveMlx.mockRejectedValue(new Error("Unreadable runtime"));
      else {
        resolveMlx.mockResolvedValue({});
        mlx.mockRejectedValue(new Error("Model failed"));
      }
      native.mockResolvedValue({ status: "success", text: "Native recovery." });
      await expect(
        transcribeVoiceNote(quietVoiceWavFixture(), "/tmp/voice-unit-test", "darwin", {}),
      ).resolves.toBe("Native recovery.");
    },
  );
  it.each(["win32", "linux"] as const)("does not probe a Mac runtime on %s", async (platform) => {
    native.mockResolvedValue({ status: "success", text: "Compatible host." });
    await transcribeVoiceNote(quietVoiceWavFixture(), "/tmp/voice-unit-test", platform, {});
    expect(resolveMlx).not.toHaveBeenCalled();
  });
});

describe("voice transcription deadline recovery", () => {
  it("does not fall through to native speech after accelerated inference cancellation", async () => {
    vi.useFakeTimers();
    try {
      resolveMlx.mockResolvedValue({});
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      mlx.mockImplementation(
        (_pcm, _runtime, signal: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            started();
          }),
      );
      const first = makeVoiceNoteTranscriber(180_000)(
        quietVoiceWavFixture(),
        "/tmp/voice-unit-test",
        "darwin",
        {},
      );
      const rejected = expect(first).rejects.toThrow("timed out");
      await ready;
      await vi.advanceTimersByTimeAsync(180_000);
      await rejected;
      expect(native).not.toHaveBeenCalled();
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("aborts stuck fallback inference and accepts the next recording", async () => {
    vi.useFakeTimers();
    try {
      native.mockResolvedValue({ status: "unavailable" });
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      fallback.mockImplementation(
        (_pcm, _cache, signal: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            started();
          }),
      );
      const transcribe = makeVoiceNoteTranscriber(180_000);
      const first = transcribe(quietVoiceWavFixture(), "/tmp/voice-unit-test", "darwin", {});
      const rejected = expect(first).rejects.toThrow("timed out");
      await ready;
      await vi.advanceTimersByTimeAsync(180_000);
      await rejected;
      native.mockResolvedValue({ status: "success", text: "Next voice note." });
      await expect(
        transcribe(quietVoiceWavFixture(), "/tmp/voice-unit-test", "darwin", {}),
      ).resolves.toBe("Next voice note.");
    } finally {
      vi.useRealTimers();
    }
  });
  it("discards native text returned after cancellation and does not start fallback", async () => {
    vi.useFakeTimers();
    try {
      let finish!: (value: { status: string; text: string }) => void;
      native.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const transcribe = makeVoiceNoteTranscriber(180_000);
      const first = transcribe(quietVoiceWavFixture(), "/tmp/voice-unit-test", "darwin", {});
      const rejected = expect(first).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(180_000);
      finish({ status: "success", text: "Late result must not send." });
      await rejected;
      expect(fallback).not.toHaveBeenCalled();
      native.mockResolvedValue({ status: "success", text: "Fresh recording." });
      await expect(
        transcribe(quietVoiceWavFixture(), "/tmp/voice-unit-test", "darwin", {}),
      ).resolves.toBe("Fresh recording.");
    } finally {
      vi.useRealTimers();
    }
  });
});
