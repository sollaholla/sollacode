/**
 * Host-side screen encoder for remote control.
 *
 * Replaces per-frame JPEG capture with a live `MediaStream` fed through
 * `MediaRecorder`, which hands off encoding to the platform's video codec
 * instead of re-encoding a full still image per frame.
 *
 * Every tuning choice here favours latency over image quality:
 *  - VP8 before VP9/H.264 — it encodes with the least delay, and inter-frame
 *    prediction matters more than compression ratio for a screen that is mostly
 *    static between frames.
 *  - A short timeslice, because a chunk cannot be sent until its slice closes,
 *    so the slice length is a latency floor.
 *  - A modest bitrate and 1080p cap, because bytes on the wire are latency.
 */

export const REMOTE_CONTROL_TIMESLICE_MS = 60;
export const REMOTE_CONTROL_TARGET_FPS = 30;
export const REMOTE_CONTROL_MAX_WIDTH = 1_920;
export const REMOTE_CONTROL_MAX_HEIGHT = 1_080;
export const REMOTE_CONTROL_VIDEO_BITS_PER_SECOND = 2_500_000;

/** Ordered by encode latency, cheapest first. */
const CANDIDATE_MIME_TYPES = [
  "video/webm;codecs=vp8",
  "video/webm;codecs=vp9",
  "video/webm",
  "video/mp4;codecs=avc1",
] as const;

export function selectRemoteControlMimeType(
  isSupported: (mimeType: string) => boolean = (mimeType) =>
    typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mimeType),
): string | null {
  for (const candidate of CANDIDATE_MIME_TYPES) {
    if (isSupported(candidate)) return candidate;
  }
  return null;
}

/**
 * True when this runtime can encode video at all. The JPEG path stays as the
 * fallback, so an environment without `MediaRecorder` still shares its screen.
 */
export function supportsRemoteControlVideo(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    navigator.mediaDevices !== undefined &&
    selectRemoteControlMimeType() !== null
  );
}

export function encodeBlobToBase64(blob: Blob): Promise<string> {
  return blob.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    // Chunked so a large slice cannot blow the argument limit of `apply`.
    const STRIDE = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += STRIDE) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + STRIDE));
    }
    return btoa(binary);
  });
}

/**
 * Opens a capture stream for one monitor via Chromium's desktop capture
 * constraints. These live under `mandatory`, which is not in the standard
 * `MediaTrackConstraints` type, hence the cast.
 */
export function openDisplayStream(sourceId: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: sourceId,
        maxWidth: REMOTE_CONTROL_MAX_WIDTH,
        maxHeight: REMOTE_CONTROL_MAX_HEIGHT,
        maxFrameRate: REMOTE_CONTROL_TARGET_FPS,
      },
    } as unknown as MediaTrackConstraints,
  });
}

export function stopStream(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}
