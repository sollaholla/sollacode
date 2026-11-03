// @effect-diagnostics globalTimers:off - browser media pipeline driven by WebCodecs callbacks, not Effect
/**
 * Watches a media-channel topic and paints it onto a canvas.
 *
 * Tells the publisher what this viewer can decode and how large the picture
 * is on screen (`hello`, then `view` whenever that changes), acknowledges
 * every packet for the relay's pacing, and asks for a key frame whenever the
 * decoder has to resynchronize. Reconnects on its own after a dropped socket;
 * a close in the 4000 range means the topic ended and is final.
 */
import type { MediaViewport } from "@t3tools/contracts";
import type { MediaPacketRegion, MediaVideoConfig } from "@t3tools/shared/mediaPacket";

import { openMediaSubscriber, type MediaSubscriberSocket } from "./mediaChannelSocket.ts";
import { sameMediaRegion } from "./mediaEncodeSize.ts";
import {
  createVideoCanvasRenderer,
  type VideoCanvasRenderer,
  type VideoCanvasRendererStats,
} from "./videoCanvasRenderer.ts";

export interface VideoStreamSubscriberOptions {
  /** A fresh media-channel URL; called for every (re)connect. */
  readonly resolveUrl: () => Promise<string>;
  readonly canvas: HTMLCanvasElement;
  /** Where crops of the source are shown; see `createVideoCanvasRenderer`. */
  readonly regionCanvas?: HTMLCanvasElement | null;
  /** Codecs this browser decodes, from `detectDecodableCodecs`. */
  readonly codecs: ReadonlyArray<string>;
  readonly viewport: () => MediaViewport;
  readonly onFrame?: (
    frame: VideoFrame,
    config: MediaVideoConfig,
    region: MediaPacketRegion | null,
  ) => void;
  readonly onBroadcast?: (key: string, body: unknown) => void;
  readonly onPublisher?: (online: boolean) => void;
  /** Optional recoverable fallback for a quiet source; keeps its socket and decoder alive. */
  readonly onFrameTimeout?: (reason: string) => void;
  /** This path cannot work here; switch to the legacy picture. */
  readonly onFatal: (reason: string) => void;
  /** The server ended the topic (the session is over). */
  readonly onEnded?: () => void;
}

export interface VideoStreamSubscriber {
  /** Re-reads `viewport()` and tells the publisher if it changed. */
  readonly updateViewport: () => void;
  /** An explicitly unavailable capture keeps the socket alive for source recovery. */
  readonly setFrameExpected: (expected: boolean) => void;
  readonly stop: () => void;
  readonly stats: () => VideoCanvasRendererStats & {
    readonly packets: number;
    readonly bytes: number;
    readonly reconnects: number;
  };
}

const MAX_FAILED_CONNECTS = 4;
const VIEW_UPDATE_DELAY_MS = 150;
const FRAME_RECOVERY_TIMEOUT_MS = 5_000;

function sameViewport(left: MediaViewport | null, right: MediaViewport): boolean {
  if (!left) return false;
  const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, b * 0.02);
  return (
    close(left.width, right.width) &&
    close(left.height, right.height) &&
    left.devicePixelRatio === right.devicePixelRatio &&
    Math.abs(left.zoom - right.zoom) <= right.zoom * 0.02 &&
    sameMediaRegion(left.region ?? null, right.region ?? null)
  );
}

export function createVideoStreamSubscriber(
  options: VideoStreamSubscriberOptions,
): VideoStreamSubscriber {
  let stopped = false;
  let socket: MediaSubscriberSocket | null = null;
  let publisherOnline = true;
  let frameExpected = true;
  let failedConnects = 0;
  let reconnects = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let frameDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let viewTimer: ReturnType<typeof setTimeout> | null = null;
  let sentView: MediaViewport | null = null;
  // A crop needs a whole picture around it, so one is requested first even when
  // this viewer opens already magnified.
  let wholePicturePainted = false;
  const currentViewport = (): MediaViewport => {
    const view = options.viewport();
    if (wholePicturePainted || !view.region) return view;
    const { region: _region, ...whole } = view;
    return whole;
  };
  const counters = { packets: 0, bytes: 0 };
  const clearFrameDeadline = () => {
    if (frameDeadlineTimer !== null) clearTimeout(frameDeadlineTimer);
    frameDeadlineTimer = null;
  };

  const fatal = (reason: string) => {
    if (stopped) return;
    stop();
    options.onFatal(reason);
  };

  const awaitFrame = (reason: string) => {
    if (stopped || (!frameExpected && publisherOnline) || frameDeadlineTimer !== null) return;
    frameDeadlineTimer = setTimeout(() => {
      frameDeadlineTimer = null;
      if (stopped) return;
      if (options.onFrameTimeout) options.onFrameTimeout(reason);
      else fatal(reason);
    }, FRAME_RECOVERY_TIMEOUT_MS);
  };

  const renderer: VideoCanvasRenderer = createVideoCanvasRenderer({
    canvas: options.canvas,
    regionCanvas: options.regionCanvas ?? null,
    onFrame: (frame, config, region) => {
      failedConnects = 0;
      if (publisherOnline && frameExpected) clearFrameDeadline();
      options.onFrame?.(frame, config, region);
      if (!region && !wholePicturePainted) {
        wholePicturePainted = true;
        updateViewport();
      }
    },
    onKeyframeNeeded: () => socket?.send({ type: "keyframe" }),
    onFatal: (reason) => fatal(`The video decoder kept failing: ${reason}`),
  });

  const connect = async () => {
    if (stopped) return;
    let url: string;
    try {
      url = await options.resolveUrl();
    } catch (cause) {
      retry(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    if (stopped) return;
    let opened = false;
    let current: MediaSubscriberSocket;
    try {
      current = openMediaSubscriber(url, {
        onOpen: () => {
          opened = true;
          awaitFrame("The host did not deliver a decodable video frame within 5 seconds.");
          sentView = currentViewport();
          current.send({ type: "hello", codecs: [...options.codecs], view: sentView });
        },
        onPacket: (packet) => {
          counters.packets += 1;
          counters.bytes += packet.payload.length;
          renderer.push(packet);
        },
        onNotice: (notice) => {
          switch (notice.type) {
            case "publisher":
              publisherOnline = notice.online;
              if (!notice.online)
                awaitFrame("The host disconnected and did not resume video within 5 seconds.");
              else if (!frameExpected) clearFrameDeadline();
              options.onPublisher?.(notice.online);
              return;
            case "broadcast":
              options.onBroadcast?.(notice.key, notice.body);
              return;
            case "unsupported":
              fatal(notice.reason);
              return;
          }
        },
        onClose: (code, reason) => {
          if (socket !== current) return;
          socket = null;
          if (code >= 4000 && code < 4100) {
            stop();
            options.onEnded?.();
            return;
          }
          retry(
            opened
              ? reason || "The media channel disconnected."
              : "The media channel refused the connection.",
          );
        },
      });
    } catch (cause) {
      retry(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    socket = current;
  };

  const retry = (reason: string) => {
    if (stopped || reconnectTimer !== null) return;
    failedConnects += 1;
    if (failedConnects >= MAX_FAILED_CONNECTS) {
      fatal(reason);
      return;
    }
    reconnects += 1;
    reconnectTimer = setTimeout(
      () => {
        reconnectTimer = null;
        void connect();
      },
      Math.min(4_000, 250 * 2 ** failedConnects),
    );
  };

  const updateViewport = () => {
    if (stopped || viewTimer !== null) return;
    viewTimer = setTimeout(() => {
      viewTimer = null;
      const view = currentViewport();
      if (sameViewport(sentView, view)) return;
      sentView = view;
      socket?.send({ type: "view", view });
    }, VIEW_UPDATE_DELAY_MS);
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    if (viewTimer !== null) clearTimeout(viewTimer);
    clearFrameDeadline();
    socket?.close();
    socket = null;
    renderer.dispose();
  };

  void connect();

  return {
    setFrameExpected: (expected) => {
      if (stopped || frameExpected === expected) return;
      frameExpected = expected;
      if (expected)
        awaitFrame("The host resumed capture but did not deliver video within 5 seconds.");
      else if (publisherOnline) clearFrameDeadline();
    },
    updateViewport,
    stop,
    stats: () => ({ ...renderer.stats(), ...counters, reconnects }),
  };
}
