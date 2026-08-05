import { describe, expect, it, vi } from "vite-plus/test";
import {
  downmixAudioChannels,
  isPushToTalkReleaseEvent,
  isPushToTalkShortcut,
  raceWithTranscriptionCancellation,
  resolveVisiblePushToTalkStatus,
  shouldHandlePushToTalkForSurface,
  startRecorderWithCue,
  withTranscriptionDeadline,
} from "./pushToTalk";

const event = (overrides: Partial<Parameters<typeof isPushToTalkShortcut>[0]> = {}) => ({
  code: "KeyD",
  key: "d",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  repeat: false,
  ...overrides,
});

describe("isPushToTalkShortcut", () => {
  it("uses Cmd+D on macOS and Ctrl+D elsewhere", () => {
    expect(isPushToTalkShortcut(event({ metaKey: true }), "MacIntel")).toBe(true);
    expect(isPushToTalkShortcut(event({ ctrlKey: true }), "Win32")).toBe(true);
  });

  it("keeps repeated chord events identifiable while rejecting invalid modifiers", () => {
    expect(isPushToTalkShortcut(event({ metaKey: true, repeat: true }), "MacIntel")).toBe(true);
    expect(isPushToTalkShortcut(event({ metaKey: true, shiftKey: true }), "MacIntel")).toBe(false);
    expect(isPushToTalkShortcut(event({ ctrlKey: true }), "MacIntel")).toBe(false);
    expect(isPushToTalkShortcut(event({ metaKey: true }), "Linux x86_64")).toBe(false);
    expect(isPushToTalkShortcut(event({ code: "KeyE", key: "e", metaKey: true }), "MacIntel")).toBe(
      false,
    );
  });

  it("ends on either chord key, including modifier release when macOS swallows KeyD keyup", () => {
    expect(isPushToTalkReleaseEvent({ code: "KeyD", key: "d" }, "MacIntel")).toBe(true);
    expect(isPushToTalkReleaseEvent({ code: "MetaLeft", key: "Meta" }, "MacIntel")).toBe(true);
    expect(isPushToTalkReleaseEvent({ code: "ControlRight", key: "Control" }, "Win32")).toBe(true);
    expect(isPushToTalkReleaseEvent({ code: "KeyE", key: "e" }, "MacIntel")).toBe(false);
  });
});

describe("shouldHandlePushToTalkForSurface", () => {
  it("routes a side-chat shortcut only to that embedded surface", () => {
    expect(
      shouldHandlePushToTalkForSurface({
        embeddedSideChat: false,
        targetWithinOwnSurface: true,
        targetWithinEmbeddedSideChat: true,
      }),
    ).toBe(false);
    expect(
      shouldHandlePushToTalkForSurface({
        embeddedSideChat: true,
        targetWithinOwnSurface: true,
        targetWithinEmbeddedSideChat: true,
      }),
    ).toBe(true);
  });

  it("keeps main-chat and unrelated shortcuts out of an embedded side chat", () => {
    expect(
      shouldHandlePushToTalkForSurface({
        embeddedSideChat: false,
        targetWithinOwnSurface: true,
        targetWithinEmbeddedSideChat: false,
      }),
    ).toBe(true);
    expect(
      shouldHandlePushToTalkForSurface({
        embeddedSideChat: true,
        targetWithinOwnSurface: false,
        targetWithinEmbeddedSideChat: false,
      }),
    ).toBe(false);
  });
});

describe("downmixAudioChannels", () => {
  it("averages channels into mono without mutating the source", () => {
    const left = new Float32Array([1, -1]);
    const right = new Float32Array([-1, 0.5]);
    expect([...downmixAudioChannels([left, right])]).toEqual([0, -0.25]);
    expect([...left]).toEqual([1, -1]);
  });
});

describe("resolveVisiblePushToTalkStatus", () => {
  it("drops a stale route-local transcription state after the background task settles", () => {
    expect(resolveVisiblePushToTalkStatus("transcribing", null)).toBeNull();
    expect(resolveVisiblePushToTalkStatus("loading", null)).toBeNull();
  });

  it("lets the background task replace a stale local recording state after the recorder stops", () => {
    expect(resolveVisiblePushToTalkStatus("recording", "transcribing")).toBe("transcribing");
    expect(resolveVisiblePushToTalkStatus("recording", "loading")).toBe("loading");
    expect(resolveVisiblePushToTalkStatus(null, "loading")).toBe("loading");
    expect(resolveVisiblePushToTalkStatus(null, "transcribing")).toBe("transcribing");
  });
});

describe("startRecorderWithCue", () => {
  it("plays the cue only after the recorder enters the recording state", () => {
    const transitions: string[] = [];
    const recorder = {
      state: "inactive" as RecordingState,
      start() {
        transitions.push("start");
        this.state = "recording";
      },
    };

    expect(
      startRecorderWithCue(recorder, () => {
        transitions.push(`cue:${recorder.state}`);
      }),
    ).toBe(true);
    expect(transitions).toEqual(["start", "cue:recording"]);
  });

  it("does not cue failed or already-active recorder starts", () => {
    let cueCount = 0;
    const active = {
      state: "recording" as RecordingState,
      start() {
        throw new Error("must not start twice");
      },
    };
    expect(
      startRecorderWithCue(active, () => {
        cueCount += 1;
      }),
    ).toBe(false);

    const failed = {
      state: "inactive" as RecordingState,
      start() {
        throw new Error("permission or recorder startup failed");
      },
    };
    expect(() =>
      startRecorderWithCue(failed, () => {
        cueCount += 1;
      }),
    ).toThrow("permission or recorder startup failed");
    expect(cueCount).toBe(0);
  });
});

describe("withTranscriptionDeadline", () => {
  it("clears its deadline when transcription settles", async () => {
    const onTimeout = vi.fn();
    await expect(
      withTranscriptionDeadline(Promise.resolve("transcript"), onTimeout, 10),
    ).resolves.toBe("transcript");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("rejects and runs worker cleanup when transcription stalls", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const transcription = withTranscriptionDeadline(
      new Promise<string>(() => undefined),
      onTimeout,
      25,
    );

    const rejection = expect(transcription).rejects.toThrow("took too long");
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(onTimeout).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});

describe("raceWithTranscriptionCancellation", () => {
  it("can cancel a pipeline before the worker request exists", async () => {
    const controller = new AbortController();
    const decoding = raceWithTranscriptionCancellation(
      new Promise<string>(() => undefined),
      controller.signal,
    );

    const rejection = expect(decoding).rejects.toThrow("cancelled while decoding");
    controller.abort(new Error("cancelled while decoding"));
    await rejection;
  });

  it("rejects immediately when cancellation already happened", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    await expect(
      raceWithTranscriptionCancellation(Promise.resolve("ignored"), controller.signal),
    ).rejects.toThrow("already cancelled");
  });
});
