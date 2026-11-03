// @effect-diagnostics globalTimers:off - browser decoder recovery uses WebCodecs callbacks
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
 * A crop of the source goes on a second canvas instead (`regionCanvas`), placed
 * over its part of the last whole picture, so a magnified viewer sees sharp
 * pixels where it is looking and the older, softer picture around them while
 * panning. Whichever picture arrives is the only one that repaints.
 *
 * Recovery is local: a decoder error or a backlog drops everything until the
 * next key frame and asks for one. Repeated failure is reported once so the
 * caller can fall back to the legacy picture.
 */
import { isAvc } from "./videoCodecs.ts";
import type { MediaPacket, MediaPacketRegion, MediaVideoConfig } from "@t3tools/shared/mediaPacket";

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
const MAX_REGION_CHANGES = 16;

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

const percent = (fraction: number) => `${String(fraction * 100)}%`;

export function createVideoCanvasRenderer(options: {
  readonly canvas: HTMLCanvasElement;
  /**
   * Shows crops of the source. Its parent must cover exactly the area of the
   * whole picture, since it is placed in percentages of that.
   */
  readonly regionCanvas?: HTMLCanvasElement | null;
  /**
   * Called with each decoded frame after it is drawn, before it is closed.
   * `region` is the part of the source this frame shows, null for all of it.
   */
  readonly onFrame?: (
    frame: VideoFrame,
    config: MediaVideoConfig,
    region: MediaPacketRegion | null,
  ) => void;
  readonly onKeyframeNeeded: () => void;
  /** The decoder keeps failing; the caller should stop using this path. */
  readonly onFatal: (reason: string) => void;
}): VideoCanvasRenderer {
  const context = options.canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("A 2D canvas context is unavailable.");
  const regionCanvas = options.regionCanvas ?? null;
  const regionContext = regionCanvas?.getContext("2d", { alpha: false }) ?? null;
  /** When each crop starts; frames still in the decoder belong to the one before. */
  const regionChanges: Array<{ readonly from: number; readonly region: MediaPacketRegion | null }> =
    [];
  let shownRegion: MediaPacketRegion | null = null;
  // A viewer reopening this canvas may have left a crop on it.
  if (regionCanvas) regionCanvas.style.display = "none";
  let decoder: VideoDecoder | null = null;
  let config: MediaVideoConfig | null = null;
  let epoch: number | null = null;
  let waitingForKey = true;
  let disposed = false;
  let failed = false;
  let lastKeyframeRequest = Number.NEGATIVE_INFINITY;
  let keyframeTimer: ReturnType<typeof setTimeout> | null = null;
  const errorTimes: number[] = [];
  const counters = { decoded: 0, dropped: 0, errors: 0, keyframesRequested: 0 };

  const cancelKeyframeRetry = () => {
    if (keyframeTimer !== null) clearTimeout(keyframeTimer);
    keyframeTimer = null;
  };

  const requestKeyframe = () => {
    if (disposed || failed) return;
    const now = performance.now();
    const remaining = KEYFRAME_REQUEST_SPACING_MS - (now - lastKeyframeRequest);
    if (remaining > 0) {
      // A still screen may produce nothing else after a decoder error.
      // Keep the rate limit without losing its last recovery request.
      if (keyframeTimer === null)
        keyframeTimer = setTimeout(() => {
          keyframeTimer = null;
          requestKeyframe();
        }, remaining);
      return;
    }
    cancelKeyframeRetry();
    lastKeyframeRequest = now;
    counters.keyframesRequested += 1;
    options.onKeyframeNeeded();
  };

  const regionOf = (timestamp: number): MediaPacketRegion | null => {
    while (regionChanges.length > 1 && regionChanges[1]!.from <= timestamp) regionChanges.shift();
    return regionChanges[0]?.region ?? null;
  };

  /** Moved in the same task as the paint, so a crop never shows in the old crop's place. */
  const showRegion = (region: MediaPacketRegion | null) => {
    if (!regionCanvas || region === shownRegion) return;
    shownRegion = region;
    if (!region) {
      regionCanvas.style.display = "none";
      return;
    }
    regionCanvas.style.display = "block";
    regionCanvas.style.left = percent(region.x);
    regionCanvas.style.top = percent(region.y);
    regionCanvas.style.width = percent(region.width);
    regionCanvas.style.height = percent(region.height);
  };

  const noteRegion = (packet: MediaPacket) => {
    if (!packet.key || !packet.config) return;
    const region = packet.config.region ?? null;
    const last = regionChanges.at(-1);
    if (last && JSON.stringify(last.region) === JSON.stringify(region)) return;
    if (regionChanges.length >= MAX_REGION_CHANGES) regionChanges.shift();
    regionChanges.push({ from: packet.timestamp, region });
  };

  const draw = (frame: VideoFrame) => {
    if (disposed) {
      frame.close();
      return;
    }
    counters.decoded += 1;
    cancelKeyframeRetry();
    const width = frame.displayWidth;
    const height = frame.displayHeight;
    const region = regionOf(frame.timestamp);
    if (region && regionCanvas && regionContext) {
      if (regionCanvas.width !== width || regionCanvas.height !== height) {
        regionCanvas.width = width;
        regionCanvas.height = height;
      }
      regionContext.drawImage(frame, 0, 0, width, height);
      showRegion(region);
    } else {
      if (options.canvas.width !== width || options.canvas.height !== height) {
        options.canvas.width = width;
        options.canvas.height = height;
      }
      context.drawImage(frame, 0, 0, width, height);
      showRegion(null);
    }
    try {
      if (config) options.onFrame?.(frame, config, region);
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
      cancelKeyframeRetry();
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
      noteRegion(packet);
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
      cancelKeyframeRetry();
      try {
        if (decoder && decoder.state !== "closed") decoder.close();
      } catch {
        // Already closed by an error.
      }
      decoder = null;
    },
  };
}
