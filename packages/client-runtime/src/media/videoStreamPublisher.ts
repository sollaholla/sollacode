// @effect-diagnostics globalTimers:off - browser media pipeline driven by WebCodecs callbacks, not Effect
/**
 * Publishes a live video track to a media-channel topic with WebCodecs.
 *
 * Demand-driven end to end: the capture opens when the first subscriber says
 * hello and closes a few seconds after the last one leaves, so an idle
 * session costs nothing. Frames are pulled from the track with
 * `MediaStreamTrackProcessor` and encoded as they arrive - a screen that does
 * not change produces no frames and therefore no bytes. The newest frame is
 * always kept, so a key frame or a refinement pass can be cut from a screen
 * that has gone still.
 *
 * Size and codec follow the subscribers: the picture is encoded at the
 * largest viewer's device-pixel size (`targetEncodeSize`), in the first codec
 * they can all decode. Quality follows the link: the relay's measurements set
 * a byte budget (`mediaBitrateController`) and every frame's quantizer comes
 * from how far behind that budget the stream is (`mediaFrameQuality`). While
 * the encoder is busy or the budget is spent, newer frames replace older
 * ones, so the stream degrades to fewer, current frames - never to a queue.
 */
import type {
  MediaPublisherMessage,
  MediaPublisherNotice,
  MediaSubscriberInfo,
} from "@t3tools/contracts";
import { encodeMediaPacket, type MediaVideoConfig } from "@t3tools/shared/mediaPacket";

import {
  createBitrateController,
  resizeBitrateController,
  updateBitrate,
  type BitrateControllerState,
} from "./mediaBitrateController.ts";
import { openMediaPublisher, type MediaPublisherSocket } from "./mediaChannelSocket.ts";
import { shouldReconfigureSize, targetEncodeSize, type PixelSize } from "./mediaEncodeSize.ts";
import {
  BUCKET_SKIP_SECONDS,
  bucketSeconds,
  EMPTY_BUCKET,
  needsRefinement,
  pourBucket,
  quantizerFor,
  quantizerScale,
  type FrameBucket,
  type QuantizerScale,
} from "./mediaFrameQuality.ts";
import {
  commonCodec,
  isAvc,
  isHevc,
  MEDIA_VIDEO_CODECS,
  resolveEncoderConfig,
} from "./videoCodecs.ts";

/** A JSON value a broadcast carries; its meaning belongs to the topic owner. */
export type MediaBroadcastBody = Extract<MediaPublisherMessage, { type: "broadcast" }>["body"];

export interface VideoSource {
  readonly track: MediaStreamTrack;
  readonly close: () => void;
}

export interface VideoStreamPublisherStats {
  readonly subscribers: number;
  readonly capturing: boolean;
  readonly framesIn: number;
  readonly framesEncoded: number;
  readonly framesRefined: number;
  readonly framesDeferred: number;
  readonly keyFrames: number;
  readonly packetsSent: number;
  readonly bytesSent: number;
  readonly packetsDropped: number;
  readonly codec: string | null;
  readonly hardware: boolean | null;
  readonly quantizerMode: boolean | null;
  readonly width: number;
  readonly height: number;
  readonly targetBitsPerSecond: number;
}

export interface VideoStreamPublisher {
  /** Topic metadata for every subscriber; re-sent after a reconnect. */
  readonly broadcast: (key: string, body: MediaBroadcastBody) => void;
  /** Reopens the capture, e.g. after a monitor switch. */
  readonly restartSource: () => void;
  readonly stop: () => void;
  readonly stats: () => VideoStreamPublisherStats;
}

export interface VideoStreamPublisherOptions {
  /** A fresh media-channel URL; called for every (re)connect. */
  readonly resolveUrl: () => Promise<string>;
  /** Opens the capture when the first subscriber arrives. */
  readonly openSource: () => Promise<VideoSource>;
  readonly codecs?: ReadonlyArray<string>;
  /** The capture failed or ended. The publisher retries while subscribed. */
  readonly onCaptureError?: (cause: unknown) => void;
  /** The first frame of each newly opened capture, including explicit source replacements. */
  readonly onCaptureFrame?: () => void;
  /** The topic was closed by the server; nothing more will be published. */
  readonly onEnded?: () => void;
}

const IDLE_CAPTURE_GRACE_MS = 3_000;
const KEYFRAME_REFRESH_DELAY_MS = 40;
const PERIODIC_KEYFRAME_MS = 30_000;
/** A still screen this long after its last frame gets its refinement pass. */
const REFINE_DELAY_MS = 220;
/** The refinement waits for the budget to be nearly drained. */
const REFINE_MAX_BACKLOG_SECONDS = 0.12;
const MIN_FRAME_INTERVAL_MS = 1_000 / 60;
const MAX_SOCKET_BUFFER_BYTES = 8 * 1024 * 1024;
const SOCKET_DRAIN_RETRY_MS = 50;
const BITRATE_RECONFIGURE_SPACING_MS = 500;
const MAX_ENCODE_QUEUE = 1;

export function createVideoStreamPublisher(
  options: VideoStreamPublisherOptions,
): VideoStreamPublisher {
  const candidates = options.codecs ?? MEDIA_VIDEO_CODECS;
  const broadcasts = new Map<string, MediaBroadcastBody>();
  let stopped = false;
  let socket: MediaPublisherSocket | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let subscribers: ReadonlyArray<MediaSubscriberInfo> = [];

  let source: VideoSource | null = null;
  let sourceGeneration = 0;
  let reportedSourceGeneration = -1;
  let opening = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let captureRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let captureRetryAttempt = 0;
  let sourceSize: PixelSize | null = null;

  let encoder: VideoEncoder | null = null;
  let encoderConfig: VideoEncoderConfig | null = null;
  let encoderHardware: boolean | null = null;
  let quantizerMode: boolean | null = null;
  let scale: QuantizerScale = quantizerScale("avc1");
  let encodeSize: PixelSize | null = null;
  let decoderConfig: MediaVideoConfig | null = null;
  let bitrate: BitrateControllerState | null = null;
  let bucket: FrameBucket = EMPTY_BUCKET;
  let lastBitrateConfigureAt = Number.NEGATIVE_INFINITY;
  let epoch = 0;
  let sequence = 0;
  let reconciling: Promise<void> = Promise.resolve();

  let latestFrame: VideoFrame | null = null;
  let latestFrameAt = 0;
  /** The newest frame has been handed to the encoder at least once. */
  let latestEncoded = true;
  /** Its newest encode produced output (a rate-controlled encoder may drop). */
  let latestOutput = true;
  let latestQuantizer: number | null = null;
  let latestTimestamp = -1;
  let refinePasses = 0;
  let forceKey = true;
  let lastEncodeAt = Number.NEGATIVE_INFINITY;
  let lastKeyAt = Number.NEGATIVE_INFINITY;
  let lastTimestamp = 0;
  let encodeTimer: ReturnType<typeof setTimeout> | null = null;
  let refineTimer: ReturnType<typeof setTimeout> | null = null;
  const captureTimes = new Map<number, number>();

  const counters = {
    framesIn: 0,
    framesEncoded: 0,
    framesRefined: 0,
    framesDeferred: 0,
    keyFrames: 0,
    packetsSent: 0,
    bytesSent: 0,
    packetsDropped: 0,
  };

  const wallClock = () => performance.timeOrigin + performance.now();
  const budget = () => bitrate?.targetBitsPerSecond ?? 1_000_000;

  // ---- socket ---------------------------------------------------------

  const connect = async () => {
    if (stopped) return;
    let url: string;
    try {
      url = await options.resolveUrl();
    } catch {
      scheduleReconnect();
      return;
    }
    if (stopped) return;
    let current: MediaPublisherSocket;
    try {
      current = openMediaPublisher(url, {
        onOpen: () => {
          reconnectAttempt = 0;
          for (const [key, body] of broadcasts) current.send({ type: "broadcast", key, body });
        },
        onNotice: (notice) => {
          if (socket === current) handleNotice(notice);
        },
        onClose: (code) => {
          if (socket !== current) return;
          socket = null;
          subscribers = [];
          scheduleIdleStop();
          if (code >= 4000 && code < 4100) {
            stop();
            options.onEnded?.();
            return;
          }
          scheduleReconnect();
        },
      });
    } catch {
      scheduleReconnect();
      return;
    }
    socket = current;
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer !== null) return;
    const delay = Math.min(5_000, 250 * 2 ** reconnectAttempt);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  };

  const handleNotice = (notice: MediaPublisherNotice) => {
    switch (notice.type) {
      case "subscribers":
        subscribers = notice.subscribers;
        if (subscribers.length === 0) {
          scheduleIdleStop();
          return;
        }
        cancelIdleStop();
        ensureCapture();
        queueReconcile();
        return;
      case "keyframe":
        requestKeyframe();
        return;
      case "stats": {
        if (!bitrate) return;
        bitrate = updateBitrate(bitrate, notice.stats, performance.now());
        if (quantizerMode === false) applyEncoderBitrate();
        return;
      }
    }
  };

  /** Rate-controlled encoders take the budget directly; quantizer mode does not. */
  const applyEncoderBitrate = () => {
    if (!encoder || !encoderConfig || !bitrate) return;
    const current = encoderConfig.bitrate ?? bitrate.targetBitsPerSecond;
    const ratio = bitrate.targetBitsPerSecond / current;
    if (ratio > 0.9 && ratio < 1.1) return;
    if (performance.now() - lastBitrateConfigureAt < BITRATE_RECONFIGURE_SPACING_MS) return;
    lastBitrateConfigureAt = performance.now();
    encoderConfig = { ...encoderConfig, bitrate: bitrate.targetBitsPerSecond };
    try {
      encoder.configure(encoderConfig);
    } catch {
      // A rejected reconfigure leaves the old rate in place.
    }
  };

  // ---- capture --------------------------------------------------------

  const cancelIdleStop = () => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
  };

  const scheduleIdleStop = () => {
    if (idleTimer !== null || (!source && !opening)) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (subscribers.length === 0) stopCapture();
    }, IDLE_CAPTURE_GRACE_MS);
  };

  const ensureCapture = () => {
    if (stopped || source || opening || subscribers.length === 0) return;
    opening = true;
    const generation = ++sourceGeneration;
    void options
      .openSource()
      .then((opened) => {
        if (generation === sourceGeneration) opening = false;
        if (stopped || generation !== sourceGeneration || subscribers.length === 0) {
          opened.close();
          return;
        }
        source = opened;
        opened.track.addEventListener("ended", () => {
          if (generation !== sourceGeneration) return;
          captureFailed(new Error("The capture track ended."));
        });
        void readFrames(opened, generation);
      })
      .catch((cause: unknown) => {
        if (generation !== sourceGeneration) return;
        opening = false;
        captureFailed(cause);
      });
  };

  const captureFailed = (cause: unknown) => {
    if (stopped) return;
    releaseSource();
    options.onCaptureError?.(cause);
    if (captureRetryTimer !== null || subscribers.length === 0) return;
    const delay = Math.min(10_000, 500 * 2 ** captureRetryAttempt);
    captureRetryAttempt += 1;
    captureRetryTimer = setTimeout(() => {
      captureRetryTimer = null;
      ensureCapture();
    }, delay);
  };

  const readFrames = async (opened: VideoSource, generation: number) => {
    const Processor = trackProcessorConstructor();
    if (!Processor) {
      captureFailed(new Error("MediaStreamTrackProcessor is unavailable."));
      return;
    }
    const reader = new Processor({ track: opened.track }).readable.getReader();
    try {
      // Capture callbacks can stop or replace this source while read() awaits.
      // eslint-disable-next-line no-unmodified-loop-condition
      while (!stopped && generation === sourceGeneration) {
        const { value, done } = await reader.read();
        if (done) {
          if (!stopped && generation === sourceGeneration)
            captureFailed(new Error("The capture stream ended."));
          break;
        }
        if (generation !== sourceGeneration) {
          value.close();
          break;
        }
        acceptFrame(value);
      }
    } catch (cause) {
      if (generation === sourceGeneration) captureFailed(cause);
    } finally {
      reader.releaseLock();
    }
  };

  const acceptFrame = (frame: VideoFrame) => {
    counters.framesIn += 1;
    if (reportedSourceGeneration !== sourceGeneration) {
      reportedSourceGeneration = sourceGeneration;
      options.onCaptureFrame?.();
    }
    captureRetryAttempt = 0;
    latestFrame?.close();
    latestFrame = frame;
    latestFrameAt = wallClock();
    latestEncoded = false;
    refinePasses = 0;
    const size = { width: frame.displayWidth, height: frame.displayHeight };
    if (!sourceSize || sourceSize.width !== size.width || sourceSize.height !== size.height) {
      sourceSize = size;
      queueReconcile();
      return;
    }
    maybeEncode();
  };

  const releaseSource = () => {
    sourceGeneration += 1;
    opening = false;
    source?.close();
    source = null;
    latestFrame?.close();
    latestFrame = null;
    latestEncoded = true;
  };

  const stopCapture = () => {
    releaseSource();
    closeEncoder();
    sourceSize = null;
  };

  // ---- encoder --------------------------------------------------------

  const clearTimers = () => {
    if (encodeTimer !== null) clearTimeout(encodeTimer);
    encodeTimer = null;
    if (refineTimer !== null) clearTimeout(refineTimer);
    refineTimer = null;
  };

  const closeEncoder = () => {
    clearTimers();
    try {
      if (encoder && encoder.state !== "closed") encoder.close();
    } catch {
      // Already closed.
    }
    encoder = null;
    encoderConfig = null;
    encodeSize = null;
    decoderConfig = null;
    captureTimes.clear();
  };

  /** Serialized: codec probing is async and must not interleave. */
  const queueReconcile = () => {
    reconciling = reconciling.then(reconcile, reconcile).catch((cause: unknown) => {
      if (stopped) return;
      closeEncoder();
      captureFailed(cause);
    });
  };

  const reconcile = async () => {
    if (stopped || subscribers.length === 0 || !sourceSize) return;
    const codecs = commonCodec(
      subscribers.map((subscriber) => subscriber.codecs),
      candidates,
    );
    if (codecs.length === 0) {
      for (const subscriber of subscribers) {
        if (commonCodec([subscriber.codecs], candidates).length === 0) {
          socket?.send({
            type: "unsupported",
            subscriber: subscriber.id,
            reason: "This viewer cannot decode any video format the host can encode.",
          });
        }
      }
      return;
    }
    const size = targetEncodeSize({
      source: sourceSize,
      viewports: subscribers.map((subscriber) => subscriber.view),
    });
    const codecStillValid = encoderConfig !== null && codecs.includes(encoderConfig.codec);
    if (encoder && codecStillValid && !shouldReconfigureSize(encodeSize, size)) {
      maybeEncode();
      return;
    }
    bitrate = bitrate ? resizeBitrateController(bitrate, size) : createBitrateController(size);
    const choice = await resolveEncoderConfig({
      codecs: codecStillValid && encoderConfig ? [encoderConfig.codec, ...codecs] : codecs,
      width: size.width,
      height: size.height,
      bitrate: bitrate.targetBitsPerSecond,
      framerate: 30,
    });
    if (stopped || !sourceSize || subscribers.length === 0) return;
    if (!choice) {
      for (const subscriber of subscribers) {
        socket?.send({
          type: "unsupported",
          subscriber: subscriber.id,
          reason: "The host has no video encoder for this viewer.",
        });
      }
      return;
    }
    closeEncoder();
    const next = new VideoEncoder({
      output: (chunk, metadata) => handleOutput(next, chunk, metadata),
      error: () => {
        if (encoder !== next) return;
        closeEncoder();
        forceKey = true;
        queueReconcile();
      },
    });
    next.configure(choice.config);
    encoder = next;
    encoderConfig = choice.config;
    encoderHardware = choice.hardware;
    quantizerMode = choice.quantizer;
    scale = quantizerScale(choice.config.codec);
    encodeSize = size;
    bucket = EMPTY_BUCKET;
    epoch += 1;
    forceKey = true;
    latestEncoded = false;
    lastBitrateConfigureAt = performance.now();
    maybeEncode();
  };

  const requestKeyframe = () => {
    forceKey = true;
    latestEncoded = false;
    // A static screen sends no new frames; cut the key frame from the last
    // one rather than waiting for the screen to change.
    if (encodeTimer === null)
      encodeTimer = setTimeout(runScheduledEncode, KEYFRAME_REFRESH_DELAY_MS);
  };

  const runScheduledEncode = () => {
    encodeTimer = null;
    maybeEncode();
  };

  const encoderReady = (): boolean =>
    !stopped &&
    encoder !== null &&
    encoder.state === "configured" &&
    latestFrame !== null &&
    socket?.isOpen() === true;

  const scheduleEncode = (delayMs: number) => {
    if (encodeTimer !== null) return;
    encodeTimer = setTimeout(runScheduledEncode, Math.max(1, delayMs));
  };

  const maybeEncode = () => {
    if (!encoderReady() || !encoder) return;
    if (latestEncoded && !forceKey) return;
    if (socket && socket.bufferedAmount() > MAX_SOCKET_BUFFER_BYTES) {
      // Keep the newest picture and recovery key-frame request, but do not
      // spend encoder work on frames the congested socket cannot accept.
      scheduleEncode(SOCKET_DRAIN_RETRY_MS);
      return;
    }
    if (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) return; // the next output resumes us
    const at = performance.now();
    if (!forceKey && at - lastEncodeAt < MIN_FRAME_INTERVAL_MS) {
      scheduleEncode(lastEncodeAt + MIN_FRAME_INTERVAL_MS - at);
      return;
    }
    const backlog = bucketSeconds(bucket, budget(), at);
    if (!forceKey && backlog > BUCKET_SKIP_SECONDS) {
      // Over budget: hold the newest frame until the backlog drains. Any
      // newer frame replaces it in the meantime.
      counters.framesDeferred += 1;
      scheduleEncode((backlog - BUCKET_SKIP_SECONDS) * 1_000 + 5);
      return;
    }
    if (encodeTimer !== null) {
      clearTimeout(encodeTimer);
      encodeTimer = null;
    }
    const key = forceKey || at - lastKeyAt > PERIODIC_KEYFRAME_MS;
    encodeLatest(key, quantizerMode ? quantizerFor(scale, backlog) : null);
  };

  const encodeLatest = (key: boolean, quantizer: number | null) => {
    if (!encoder || !latestFrame || !encoderConfig) return;
    const at = performance.now();
    const timestamp = Math.max(lastTimestamp + 1, Math.round(at * 1_000));
    lastTimestamp = timestamp;
    // Some rate-controlled encoders drop frames without an output callback.
    // Keep timestamp bookkeeping bounded even on a permanently busy capture.
    if (captureTimes.size >= 128) captureTimes.delete(captureTimes.keys().next().value!);
    captureTimes.set(timestamp, latestFrameAt);
    const frame = new VideoFrame(scaleForEncode(latestFrame), { timestamp });
    const perFrame =
      quantizer === null
        ? {}
        : isHevc(encoderConfig.codec)
          ? { hevc: { quantizer } }
          : isAvc(encoderConfig.codec)
            ? { avc: { quantizer } }
            : {};
    try {
      encoder.encode(frame, { keyFrame: key, ...perFrame } as VideoEncoderEncodeOptions);
      counters.framesEncoded += 1;
      latestEncoded = true;
      latestOutput = false;
      latestQuantizer = quantizer;
      latestTimestamp = timestamp;
      forceKey = false;
      lastEncodeAt = at;
      if (key) lastKeyAt = at;
    } catch {
      captureTimes.delete(timestamp);
    } finally {
      frame.close();
    }
    scheduleRefinement(REFINE_DELAY_MS);
  };

  /**
   * Downscales on the GPU with a proper filter before the encoder sees the
   * frame. Encoders scale with whatever their hardware offers, which on a
   * 2.3x reduction of text is close to point sampling: strokes alias and
   * thin glyphs break up. A 2D canvas with high-quality smoothing averages
   * instead, and the encoder then compresses exactly the pixels the viewer
   * will show one-to-one.
   */
  let scaler: OffscreenCanvas | null = null;
  let scalerContext: OffscreenCanvasRenderingContext2D | null = null;
  const scaleForEncode = (frame: VideoFrame): VideoFrame | OffscreenCanvas => {
    if (
      !encodeSize ||
      typeof OffscreenCanvas === "undefined" ||
      (frame.displayWidth === encodeSize.width && frame.displayHeight === encodeSize.height)
    ) {
      return frame;
    }
    if (!scaler || scaler.width !== encodeSize.width || scaler.height !== encodeSize.height) {
      scaler = new OffscreenCanvas(encodeSize.width, encodeSize.height);
      scalerContext = scaler.getContext("2d", { alpha: false });
    }
    if (!scalerContext) return frame;
    scalerContext.imageSmoothingEnabled = true;
    scalerContext.imageSmoothingQuality = "high";
    scalerContext.drawImage(frame, 0, 0, encodeSize.width, encodeSize.height);
    return scaler;
  };

  const scheduleRefinement = (delayMs: number) => {
    if (refineTimer !== null) clearTimeout(refineTimer);
    refineTimer = setTimeout(refine, Math.max(1, delayMs));
  };

  /**
   * The screen has been still since the last encode. Either that encode never
   * came out (a rate-controlled encoder dropped it, so the viewer is showing
   * an older picture) or it came out coarse; either way the last frame is
   * encoded once more.
   */
  const refine = () => {
    refineTimer = null;
    if (!encoderReady() || !encoder) return;
    if (!latestOutput) {
      if (encoder.encodeQueueSize > 0) {
        scheduleRefinement(100);
        return;
      }
      latestEncoded = false;
      maybeEncode();
      return;
    }
    if (!latestEncoded || forceKey) {
      maybeEncode();
      return;
    }
    const worthIt = quantizerMode ? needsRefinement(scale, latestQuantizer) : refinePasses === 0;
    if (!worthIt) return;
    const backlog = bucketSeconds(bucket, budget(), performance.now());
    if (backlog > REFINE_MAX_BACKLOG_SECONDS || encoder.encodeQueueSize > 0) {
      scheduleRefinement((backlog - REFINE_MAX_BACKLOG_SECONDS) * 1_000 + 20);
      return;
    }
    refinePasses += 1;
    counters.framesRefined += 1;
    encodeLatest(false, quantizerMode ? scale.refine : null);
  };

  const handleOutput = (
    from: VideoEncoder,
    chunk: EncodedVideoChunk,
    metadata: EncodedVideoChunkMetadata | undefined,
  ) => {
    if (from !== encoder || !encodeSize || !sourceSize) return;
    const capturedAt = captureTimes.get(chunk.timestamp) ?? wallClock();
    captureTimes.delete(chunk.timestamp);
    if (chunk.timestamp === latestTimestamp) latestOutput = true;
    const reported = metadata?.decoderConfig;
    if (reported) {
      decoderConfig = {
        codec: reported.codec,
        codedWidth: reported.codedWidth ?? encodeSize.width,
        codedHeight: reported.codedHeight ?? encodeSize.height,
        sourceWidth: sourceSize.width,
        sourceHeight: sourceSize.height,
        ...(reported.description ? { description: copyDescription(reported.description) } : {}),
      };
    }
    const key = chunk.type === "key";
    if (key) counters.keyFrames += 1;
    const payload = new Uint8Array(chunk.byteLength);
    chunk.copyTo(payload);
    bucket = pourBucket(bucket, payload.length, budget(), performance.now());
    const current = socket;
    if (!current || current.bufferedAmount() > MAX_SOCKET_BUFFER_BYTES) {
      counters.packetsDropped += 1;
      forceKey = true;
    } else {
      const packet = encodeMediaPacket({
        key,
        epoch,
        sequence: sequence++,
        capturedAt,
        timestamp: chunk.timestamp,
        ...(key && decoderConfig ? { config: decoderConfig } : {}),
        payload,
      });
      current.sendPacket(packet);
      counters.packetsSent += 1;
      counters.bytesSent += packet.length;
    }
    maybeEncode();
  };

  // ---- lifecycle ------------------------------------------------------

  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelIdleStop();
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    if (captureRetryTimer !== null) clearTimeout(captureRetryTimer);
    stopCapture();
    socket?.close();
    socket = null;
  };

  void connect();

  return {
    broadcast: (key, body) => {
      broadcasts.set(key, body);
      socket?.send({ type: "broadcast", key, body });
    },
    restartSource: () => {
      if (!source && !opening) return;
      releaseSource();
      opening = false;
      ensureCapture();
    },
    stop,
    stats: () => ({
      subscribers: subscribers.length,
      capturing: source !== null,
      ...counters,
      codec: encoderConfig?.codec ?? null,
      hardware: encoderHardware,
      quantizerMode,
      width: encodeSize?.width ?? 0,
      height: encodeSize?.height ?? 0,
      targetBitsPerSecond: bitrate?.targetBitsPerSecond ?? 0,
    }),
  };
}

type TrackProcessorConstructor = new (init: { readonly track: MediaStreamTrack }) => {
  readonly readable: ReadableStream<VideoFrame>;
};

/** Chromium-only (and so not in the DOM typings), which is all a host runs. */
function trackProcessorConstructor(): TrackProcessorConstructor | null {
  return (
    (globalThis as { MediaStreamTrackProcessor?: TrackProcessorConstructor })
      .MediaStreamTrackProcessor ?? null
  );
}

/** Whether this runtime can publish with WebCodecs at all. */
export function supportsVideoStreamPublishing(): boolean {
  return (
    typeof VideoEncoder !== "undefined" &&
    typeof VideoFrame !== "undefined" &&
    trackProcessorConstructor() !== null
  );
}

function copyDescription(description: AllowSharedBufferSource): Uint8Array {
  if (description instanceof ArrayBuffer) return new Uint8Array(description.slice(0));
  if (ArrayBuffer.isView(description)) {
    return new Uint8Array(
      description.buffer.slice(
        description.byteOffset,
        description.byteOffset + description.byteLength,
      ),
    );
  }
  return new Uint8Array(description as ArrayBufferLike);
}
