/**
 * Decodes media-channel video with WebCodecs and paints each frame onto a
 * canvas the moment it is decoded.
 *
 * There is deliberately no player in between. A `<video>` element fed by
 * MediaSource keeps a jitter buffer and a media clock, which is right for
 * film and wrong for a remote desktop: on a mostly idle screen it waits for
 * frames that never come and shows the next caret blink a second late. Here a
 * decoded frame is drawn and released in the same callback, and nothing
 * repaints between frames.
 *
 * Recovery is local: a decoder error or a backlog drops everything until the
 * next key frame and asks for one. Repeated failure is reported once so the
 * caller can fall back to the legacy picture.
 */
import { isAvc } from "./videoCodecs.ts";
import type { MediaPacket, MediaVideoConfig } from "@t3tools/shared/mediaPacket";

export interface VideoCanvasRendererStats {
  readonly decoded: number;
  readonly dropped: number;
  readonly errors: number;
  readonly keyframesRequested: number;
  readonly codec: string | null;
  readonly width: number;
  readonly height: number;
}

export interface VideoCanvasRenderer {
  readonly push: (packet: MediaPacket) => void;
  readonly stats: () => VideoCanvasRendererStats;
  readonly dispose: () => void;
}

/** More than this many chunks waiting to decode means we are behind live. */
const MAX_DECODE_QUEUE = 3;
const MAX_ERRORS = 3;
const ERROR_WINDOW_MS = 10_000;
const KEYFRAME_REQUEST_SPACING_MS = 300;

function sameConfig(left: MediaVideoConfig | null, right: MediaVideoConfig): boolean {
  if (!left) return false;
  if (
    left.sourceWidth !== right.sourceWidth ||
    left.sourceHeight !== right.sourceHeight ||
    left.codec !== right.codec ||
    left.codedWidth !== right.codedWidth ||
    left.codedHeight !== right.codedHeight
  ) {
    return false;
  }
  const a = left.description;
  const b = right.description;
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

export function createVideoCanvasRenderer(options: {
  readonly canvas: HTMLCanvasElement;
  /** Called with each decoded frame after it is drawn, before it is closed. */
  readonly onFrame?: (frame: VideoFrame, config: MediaVideoConfig) => void;
  readonly onKeyframeNeeded: () => void;
  /** The decoder keeps failing; the caller should stop using this path. */
  readonly onFatal: (reason: string) => void;
}): VideoCanvasRenderer {
  const context = options.canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("A 2D canvas context is unavailable.");
  let decoder: VideoDecoder | null = null;
  let config: MediaVideoConfig | null = null;
  let epoch: number | null = null;
  let waitingForKey = true;
  let disposed = false;
  let failed = false;
  let lastKeyframeRequest = Number.NEGATIVE_INFINITY;
  const errorTimes: number[] = [];
  const counters = { decoded: 0, dropped: 0, errors: 0, keyframesRequested: 0 };

  const requestKeyframe = () => {
    const now = performance.now();
    if (now - lastKeyframeRequest < KEYFRAME_REQUEST_SPACING_MS) return;
    lastKeyframeRequest = now;
    counters.keyframesRequested += 1;
    options.onKeyframeNeeded();
  };

  const draw = (frame: VideoFrame) => {
    if (disposed) {
      frame.close();
      return;
    }
    counters.decoded += 1;
    const width = frame.displayWidth;
    const height = frame.displayHeight;
    if (options.canvas.width !== width || options.canvas.height !== height) {
      options.canvas.width = width;
      options.canvas.height = height;
    }
    context.drawImage(frame, 0, 0, width, height);
    try {
      if (config) options.onFrame?.(frame, config);
    } finally {
      frame.close();
    }
  };

  const handleError = (cause: unknown) => {
    if (disposed || failed) return;
    counters.errors += 1;
    const now = performance.now();
    errorTimes.push(now);
    while (errorTimes.length > 0 && errorTimes[0]! < now - ERROR_WINDOW_MS) errorTimes.shift();
    try {
      if (decoder && decoder.state !== "closed") decoder.close();
    } catch {
      /* already closed */
    }
    decoder = null;
    config = null;
    waitingForKey = true;
    if (errorTimes.length >= MAX_ERRORS) {
      failed = true;
      options.onFatal(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    requestKeyframe();
  };

  const configure = (next: MediaVideoConfig): boolean => {
    try {
      if (!decoder || decoder.state === "closed") {
        decoder = new VideoDecoder({ output: draw, error: handleError });
      }
      decoder.configure({
        codec: next.codec,
        codedWidth: next.codedWidth,
        codedHeight: next.codedHeight,
        optimizeForLatency: true,
        ...(next.description ? { description: next.description } : {}),
        // Without a description an H.264 stream is Annex B; with one it is
        // length-prefixed (avcC). Both decode everywhere WebCodecs exists.
        ...(isAvc(next.codec) && !next.description ? { avc: { format: "annexb" } } : {}),
      } as VideoDecoderConfig);
      config = next;
      return true;
    } catch (cause) {
      handleError(cause);
      return false;
    }
  };

  return {
    push: (packet) => {
      if (disposed || failed) return;
      if (packet.config && (packet.epoch !== epoch || !sameConfig(config, packet.config))) {
        if (!packet.key) return;
        if (!configure(packet.config)) return;
        epoch = packet.epoch;
        waitingForKey = true;
      }
      if (!decoder || !config) {
        counters.dropped += 1;
        requestKeyframe();
        return;
      }
      if (waitingForKey && !packet.key) {
        counters.dropped += 1;
        return;
      }
      if (!packet.key && decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
        // Behind live: skip to the next key frame instead of decoding a
        // backlog the viewer would watch play out late.
        decoder.reset();
        if (!configure(config)) return;
        waitingForKey = true;
        counters.dropped += 1;
        requestKeyframe();
        return;
      }
      try {
        decoder.decode(
          new EncodedVideoChunk({
            type: packet.key ? "key" : "delta",
            timestamp: packet.timestamp,
            data: packet.payload,
          }),
        );
        waitingForKey = false;
      } catch (cause) {
        handleError(cause);
      }
    },
    stats: () => ({
      ...counters,
      codec: config?.codec ?? null,
      width: options.canvas.width,
      height: options.canvas.height,
    }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try {
        if (decoder && decoder.state !== "closed") decoder.close();
      } catch {
        // Already closed by an error.
      }
      decoder = null;
    },
  };
}
