import { describe, expect, it } from "vite-plus/test";
import {
  downmixAudioChannels,
  isPushToTalkReleaseEvent,
  isPushToTalkShortcut,
  startRecorderWithCue,
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

describe("downmixAudioChannels", () => {
  it("averages channels into mono without mutating the source", () => {
    const left = new Float32Array([1, -1]);
    const right = new Float32Array([-1, 0.5]);
    expect([...downmixAudioChannels([left, right])]).toEqual([0, -0.25]);
    expect([...left]).toEqual([1, -1]);
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
