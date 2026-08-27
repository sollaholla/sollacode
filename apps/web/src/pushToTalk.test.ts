import { describe, expect, it, vi } from "vite-plus/test";
import {
  cueThenMuteSystemAudio,
  downmixAudioChannels,
  encodeFloat32Pcm16,
  isPushToTalkReleaseEvent,
  isPushToTalkShortcut,
  raceWithTranscriptionCancellation,
  restorePushToTalkFocus,
  resolveVisiblePushToTalkStatus,
  shouldHandlePushToTalkForSurface,
  shouldRouteTranscriptToTerminal,
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
  it("captures Cmd+D on Apple platforms and Ctrl+D elsewhere", () => {
    expect(isPushToTalkShortcut(event({ metaKey: true }), "MacIntel")).toBe(true);
    expect(isPushToTalkShortcut(event({ metaKey: true }), "iPad")).toBe(true);
    expect(isPushToTalkShortcut(event({ ctrlKey: true }), "Win32")).toBe(true);
  });

  it("keeps repeated chord events identifiable while rejecting invalid modifiers", () => {
    expect(isPushToTalkShortcut(event({ ctrlKey: true, repeat: true }), "Win32")).toBe(true);
    expect(isPushToTalkShortcut(event({ metaKey: true, repeat: true }), "MacIntel")).toBe(true);
    expect(isPushToTalkShortcut(event({ metaKey: true, shiftKey: true }), "MacIntel")).toBe(false);
    expect(isPushToTalkShortcut(event({ ctrlKey: true }), "MacIntel")).toBe(false);
    expect(isPushToTalkShortcut(event({ metaKey: true }), "Linux x86_64")).toBe(false);
    expect(isPushToTalkShortcut(event({ code: "KeyE", key: "e", metaKey: true }), "MacIntel")).toBe(
      false,
    );
  });

  it("ends recording when either half of the platform chord is released", () => {
    expect(isPushToTalkReleaseEvent({ code: "KeyD", key: "d" }, "MacIntel")).toBe(true);
    expect(isPushToTalkReleaseEvent({ code: "MetaLeft", key: "Meta" }, "MacIntel")).toBe(true);
    expect(isPushToTalkReleaseEvent({ code: "KeyD", key: "d" }, "Win32")).toBe(true);
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

describe("restorePushToTalkFocus", () => {
  it("restores a still-mounted chord target without invoking the fallback", () => {
    const focus = vi.fn();
    const fallback = vi.fn();

    expect(restorePushToTalkFocus({ isConnected: true, focus }, fallback)).toBe("target");
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("falls back when a live update replaced the original target", () => {
    const focus = vi.fn();
    const fallback = vi.fn();

    expect(restorePushToTalkFocus({ isConnected: false, focus }, fallback)).toBe("fallback");
    expect(focus).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledOnce();
  });
});

describe("shouldRouteTranscriptToTerminal", () => {
  it("routes to the terminal when the chord target sits inside a terminal surface", () => {
    expect(
      shouldRouteTranscriptToTerminal({
        targetWithinTerminalSurface: true,
        terminalMainSurfaceActive: false,
        activeTerminalId: "terminal-1",
      }),
    ).toBe(true);
  });

  it("routes to the terminal while the terminal workspace is the main surface", () => {
    expect(
      shouldRouteTranscriptToTerminal({
        targetWithinTerminalSurface: false,
        terminalMainSurfaceActive: true,
        activeTerminalId: "terminal-1",
      }),
    ).toBe(true);
  });

  it("keeps the composer when no terminal is selected or focused", () => {
    expect(
      shouldRouteTranscriptToTerminal({
        targetWithinTerminalSurface: false,
        terminalMainSurfaceActive: false,
        activeTerminalId: "terminal-1",
      }),
    ).toBe(false);
    expect(
      shouldRouteTranscriptToTerminal({
        targetWithinTerminalSurface: true,
        terminalMainSurfaceActive: true,
        activeTerminalId: "",
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

describe("encodeFloat32Pcm16", () => {
  it("clips and encodes mono samples as signed little-endian PCM", () => {
    const pcm = encodeFloat32Pcm16(new Float32Array([-2, -1, -0.5, 0, 0.5, 1, 2]));
    const view = new DataView(pcm.buffer);
    expect(Array.from({ length: 7 }, (_, index) => view.getInt16(index * 2, true))).toEqual([
      -32_768, -32_768, -16_384, 0, 16_383, 32_767, 32_767,
    ]);
  });
});

describe("resolveVisiblePushToTalkStatus", () => {
  it("drops a stale route-local transcription state after the background task settles", () => {
    expect(resolveVisiblePushToTalkStatus("transcribing", null)).toBeNull();
    expect(resolveVisiblePushToTalkStatus("loading", null)).toBeNull();
    expect(resolveVisiblePushToTalkStatus("refining", null)).toBeNull();
  });

  it("lets the background task replace a stale local recording state after the recorder stops", () => {
    expect(resolveVisiblePushToTalkStatus("recording", "transcribing")).toBe("transcribing");
    expect(resolveVisiblePushToTalkStatus("recording", "loading")).toBe("loading");
    expect(resolveVisiblePushToTalkStatus(null, "loading")).toBe("loading");
    expect(resolveVisiblePushToTalkStatus(null, "transcribing")).toBe("transcribing");
    expect(resolveVisiblePushToTalkStatus(null, "refining")).toBe("refining");
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

describe("cueThenMuteSystemAudio", () => {
  const harness = (overrides: { recordingStates?: boolean[]; cueFails?: boolean } = {}) => {
    const order: string[] = [];
    const recordingStates = [...(overrides.recordingStates ?? [true, true])];
    return {
      order,
      input: {
        playCue: () => {
          order.push("cue");
          return overrides.cueFails === true
            ? Promise.reject(new Error("no audio output"))
            : Promise.resolve();
        },
        muteSystemAudio: () => {
          order.push("mute");
          return Promise.resolve();
        },
        recordingActive: () => recordingStates.shift() ?? false,
        noteMuteRequested: () => order.push("note"),
        restoreSystemAudio: () => order.push("restore"),
      },
    };
  };

  it("finishes the cue before requesting the mute", async () => {
    // The whole point: the system-wide mute used to land before the cue, so on
    // macOS the "recording started" sound played into a silenced output.
    const { order, input } = harness();
    await cueThenMuteSystemAudio(input);
    expect(order).toEqual(["cue", "note", "mute"]);
  });

  it("skips the mute entirely when it is turned off or unavailable", async () => {
    const { order, input } = harness();
    await cueThenMuteSystemAudio({ ...input, muteSystemAudio: null });
    expect(order).toEqual(["cue"]);
  });

  it("does not mute a recording that already ended during the cue", async () => {
    const { order, input } = harness({ recordingStates: [false] });
    await cueThenMuteSystemAudio(input);
    expect(order).toEqual(["cue"]);
  });

  it("restores a mute that landed after the recording ended", async () => {
    // A tap-and-release can stop the recorder while the mute IPC is in
    // flight; the stop handler has already run and found nothing to restore,
    // so without this the machine stays muted until the safety timer.
    const { order, input } = harness({ recordingStates: [true, false] });
    await cueThenMuteSystemAudio(input);
    expect(order).toEqual(["cue", "note", "mute", "restore"]);
  });

  it("still mutes when the cue itself fails", async () => {
    // The cue is a courtesy; the mute protects the transcription. System
    // sound policy breaking the tone must not let music bleed into dictation.
    const { order, input } = harness({ cueFails: true });
    await cueThenMuteSystemAudio(input);
    expect(order).toEqual(["cue", "note", "mute"]);
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
