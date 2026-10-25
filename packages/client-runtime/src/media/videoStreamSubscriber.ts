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
import type { MediaVideoConfig } from "@t3tools/shared/mediaPacket";

import { openMediaSubscriber, type MediaSubscriberSocket } from "./mediaChannelSocket.ts";
import {
  createVideoCanvasRenderer,
  type VideoCanvasRenderer,
  type VideoCanvasRendererStats,
} from "./videoCanvasRenderer.ts";

export interface VideoStreamSubscriberOptions {
  /** A fresh media-channel URL; called for every (re)connect. */
  readonly resolveUrl: () => Promise<string>;
  readonly canvas: HTMLCanvasElement;
  /** Codecs this browser decodes, from `detectDecodableCodecs`. */
  readonly codecs: ReadonlyArray<string>;
  readonly viewport: () => MediaViewport;
  readonly onFrame?: (frame: VideoFrame, config: MediaVideoConfig) => void;
  readonly onBroadcast?: (key: string, body: unknown) => void;
  readonly onPublisher?: (online: boolean) => void;
  /** This path cannot work here; switch to the legacy picture. */
  readonly onFatal: (reason: string) => void;
  /** The server ended the topic (the session is over). */
  readonly onEnded?: () => void;
}

export interface VideoStreamSubscriber {
  /** Re-reads `viewport()` and tells the publisher if it changed. */
  readonly updateViewport: () => void;
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
    close(left.zoom, right.zoom)
  );
}

export function createVideoStreamSubscriber(
  options: VideoStreamSubscriberOptions,
): VideoStreamSubscriber {
  let stopped = false;
  let socket: MediaSubscriberSocket | null = null;
  let publisherOnline = true;
  let failedConnects = 0;
  let reconnects = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let frameDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let viewTimer: ReturnType<typeof setTimeout> | null = null;
  let sentView: MediaViewport | null = null;
  const counters = { packets: 0, bytes: 0 };

  const fatal = (reason: string) => {
    if (stopped) return;
    stop();
    options.onFatal(reason);
  };

  const awaitFrame = (reason: string) => {
    if (stopped || frameDeadlineTimer !== null) return;
    frameDeadlineTimer = setTimeout(() => fatal(reason), FRAME_RECOVERY_TIMEOUT_MS);
  };

  const renderer: VideoCanvasRenderer = createVideoCanvasRenderer({
    canvas: options.canvas,
    onFrame: (frame, config) => {
      failedConnects = 0;
      if (publisherOnline) {
        if (frameDeadlineTimer !== null) clearTimeout(frameDeadlineTimer);
        frameDeadlineTimer = null;
      }
      options.onFrame?.(frame, config);
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
          sentView = options.viewport();
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

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    if (viewTimer !== null) clearTimeout(viewTimer);
    if (frameDeadlineTimer !== null) clearTimeout(frameDeadlineTimer);
    socket?.close();
    socket = null;
    renderer.dispose();
  };

  void connect();

  return {
    updateViewport: () => {
      if (stopped || viewTimer !== null) return;
      viewTimer = setTimeout(() => {
        viewTimer = null;
        const view = options.viewport();
        if (sameViewport(sentView, view)) return;
        sentView = view;
        socket?.send({ type: "view", view });
      }, VIEW_UPDATE_DELAY_MS);
    },
    stop,
    stats: () => ({ ...renderer.stats(), ...counters, reconnects }),
  };
}
