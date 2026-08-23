import { describe, expect, it } from "vite-plus/test";

import {
  describeRecordingCoverage,
  expandRecordedFrame,
  normalizeRecordedFrame,
  silentBase64,
  type VoiceRecording,
} from "./recordingFormat";

describe("recording format", () => {
  it("replaces an audio payload with its length, and restores the same length", () => {
    const delta = Buffer.from(new Uint8Array(4_800)).toString("base64");
    const recorded = normalizeRecordedFrame(120, { type: "response.output_audio.delta", delta });

    expect(recorded.audioBytes).toBe(4_800);
    expect(recorded.frame.delta).toBeUndefined();

    const replayed = expandRecordedFrame(recorded);
    // Duration is what the session derives from a chunk, and it follows from
    // the byte count — so a replay has to reproduce it exactly.
    expect(Buffer.from(String(replayed.delta), "base64").length).toBe(4_800);
    expect(replayed.type).toBe("response.output_audio.delta");
  });

  it("leaves a frame without audio untouched", () => {
    const frame = { type: "response.done", response: { usage: { total_tokens: 12 } } };
    const recorded = normalizeRecordedFrame(500, frame);
    expect(recorded.audioBytes).toBeUndefined();
    expect(expandRecordedFrame(recorded)).toEqual(frame);
  });

  it("bounds a silence request rather than allocating whatever it is asked for", () => {
    expect(silentBase64(-1)).toBe("");
    expect(Buffer.from(silentBase64(5_000_000), "base64").length).toBe(1_000_000);
  });

  const recording = (frames: VoiceRecording["frames"]): VoiceRecording => ({
    provider: "xai",
    model: "grok-voice-latest",
    recordedAt: "2026-08-22T20:00:00.000Z",
    prompt: "say hello",
    frames,
  });

  it("rejects a recording that never produced audio", () => {
    // Replaying one would pass without touching the state machine at all,
    // which reads as coverage and is not.
    const coverage = describeRecordingCoverage(
      recording([
        { atMs: 0, frame: { type: "response.created" } },
        { atMs: 10, frame: { type: "response.done" } },
      ]),
    );
    expect(coverage.usable).toBe(false);
    expect(coverage.reason).toContain("no audio");
  });

  it("rejects a recording whose response never completed", () => {
    const coverage = describeRecordingCoverage(
      recording([
        { atMs: 0, frame: { type: "response.created" } },
        { atMs: 10, frame: { type: "response.output_audio.delta" }, audioBytes: 480 },
      ]),
    );
    expect(coverage.usable).toBe(false);
  });

  it("accepts a full spoken response", () => {
    const coverage = describeRecordingCoverage(
      recording([
        { atMs: 0, frame: { type: "response.created" } },
        { atMs: 10, frame: { type: "response.output_audio.delta" }, audioBytes: 480 },
        { atMs: 20, frame: { type: "response.output_audio.done" } },
        { atMs: 30, frame: { type: "response.done" } },
      ]),
    );
    expect(coverage.usable).toBe(true);
  });
});
