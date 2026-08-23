/**
 * The on-disk form of a real provider conversation.
 *
 * A recording exists so that a frame order a real provider actually produced
 * becomes a permanent test, rather than something the suite guesses at. The
 * bug this was built around hid precisely in that gap: the hand-written frame
 * sequences all included the audio-done frame, because whoever wrote them
 * assumed it always arrives.
 *
 * Audio payloads are stored as byte counts, not bytes. Playback timing is the
 * only thing the session derives from them — a chunk's duration follows from
 * its length — so a count replays with identical timing while keeping the
 * fixtures small and free of recorded model speech.
 */

export interface RecordedFrame {
  /** Milliseconds since the socket opened. */
  readonly atMs: number;
  /** The provider frame, with any audio payload replaced by `audioBytes`. */
  readonly frame: Record<string, unknown>;
  /** Set when the original frame carried a base64 audio payload. */
  readonly audioBytes?: number;
}

export interface VoiceRecording {
  readonly provider: "xai" | "openai";
  readonly model: string;
  readonly recordedAt: string;
  /** What the recorder asked for, so a reader knows what they are looking at. */
  readonly prompt: string;
  readonly frames: ReadonlyArray<RecordedFrame>;
}

const AUDIO_DELTA_TYPES = new Set(["response.output_audio.delta", "response.audio.delta"]);

/** Strips a live frame down to what a replay needs. */
export function normalizeRecordedFrame(
  atMs: number,
  frame: Record<string, unknown>,
): RecordedFrame {
  const type = typeof frame.type === "string" ? frame.type : "";
  if (AUDIO_DELTA_TYPES.has(type) && typeof frame.delta === "string") {
    const { delta: _delta, ...rest } = frame;
    return {
      atMs,
      frame: rest,
      // Base64 to bytes, which is what determines the chunk's duration.
      audioBytes: Math.floor((frame.delta.length * 3) / 4),
    };
  }
  return { atMs, frame };
}

/** Rebuilds a playable frame, substituting silence of the recorded length. */
export function expandRecordedFrame(recorded: RecordedFrame): Record<string, unknown> {
  if (recorded.audioBytes === undefined) return recorded.frame;
  return {
    ...recorded.frame,
    type: recorded.frame.type ?? "response.output_audio.delta",
    delta: silentBase64(recorded.audioBytes),
  };
}

/** `bytes` of PCM silence, base64-encoded. */
export function silentBase64(bytes: number): string {
  const safe = Math.max(0, Math.min(bytes, 1_000_000));
  // Node and the browser both have btoa-equivalent paths; Buffer is available
  // wherever the recorder and its replay run.
  return Buffer.from(new Uint8Array(safe)).toString("base64");
}

/**
 * Whether a recording covers the sequence the session's hardest paths need.
 *
 * A recording that never produced audio, or never completed a response, is not
 * evidence of anything — replaying it would pass without exercising the state
 * machine at all, which is worse than having no recording.
 */
export function describeRecordingCoverage(recording: VoiceRecording): {
  readonly usable: boolean;
  readonly reason: string;
} {
  const types = new Set(recording.frames.map((entry) => String(entry.frame.type)));
  if (!types.has("response.created")) {
    return { usable: false, reason: "no response was ever created" };
  }
  if (!types.has("response.done")) {
    return { usable: false, reason: "no response ever completed" };
  }
  if (!recording.frames.some((entry) => entry.audioBytes !== undefined)) {
    return { usable: false, reason: "the response produced no audio" };
  }
  return { usable: true, reason: "covers a full spoken response" };
}
