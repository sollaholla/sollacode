/**
 * Benchmark viewer, media-channel pipeline: the production
 * `createVideoStreamSubscriber` painting into a canvas laid out like the
 * dialog's picture, with the watch stream reduced to control events.
 */
import type {
  MediaViewport,
  RemoteControlControllerStreamEvent,
  RemoteControlInput,
} from "@t3tools/contracts";
import { mediaChannelUrl } from "@t3tools/client-runtime/media/media-channel-socket";
import { detectDecodableCodecs } from "@t3tools/client-runtime/media/video-codecs";
import {
  createVideoStreamSubscriber,
  type VideoStreamSubscriber,
} from "@t3tools/client-runtime/media/video-stream-subscriber";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { createRemoteControlInputScheduler } from "../../../web/src/components/remoteControl/remoteControlInputScheduler.ts";
import { connectBenchRpc } from "./benchRpc.ts";
import { readFrameNumber } from "./scene.ts";

export interface MediaViewerHandle {
  readonly stop: () => Promise<void>;
  readonly send: (input: RemoteControlInput) => void;
  readonly stats: () => Record<string, unknown>;
}

export async function startMediaViewer(options: {
  readonly pane: HTMLElement;
  /** Called on the frame after a picture was painted, with its frame number. */
  readonly onPainted: (frame: number | null, canvas: HTMLCanvasElement) => void;
  readonly captureFrameMetadata?: boolean;
  /** Diagnostic only: request extra encoded pixels without changing displayed size. */
  readonly encodeScale?: number;
}): Promise<MediaViewerHandle> {
  const socketUrl = `${location.origin.replace(/^http/, "ws")}/ws?as=viewer`;
  const connection = await connectBenchRpc(socketUrl);
  const { client } = connection;
  const codecs = await detectDecodableCodecs();
  const session = await connection.run(
    client["remoteControl.requestAccess"]({
      clientId: "bench-viewer",
      requestedCapabilities: ["screen", "pointer", "keyboard"],
    }),
  );
  const sessionId = session.sessionId;
  let sequence = 0;
  let serial: Promise<unknown> = Promise.resolve();
  const sendInput = (input: RemoteControlInput): Promise<void> => {
    const current = serial.then(() =>
      connection.run(client["remoteControl.sendInput"]({ sessionId, sequence: sequence++, input })),
    );
    serial = current.catch(() => undefined);
    return current.then(() => undefined);
  };
  const scheduler = createRemoteControlInputScheduler({
    send: sendInput,
    scheduleFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
  });

  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:contain";
  options.pane.append(canvas);
  const viewport = (): MediaViewport => {
    const rect = options.pane.getBoundingClientRect();
    return {
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height),
      devicePixelRatio,
      zoom: options.encodeScale ?? 1,
    };
  };

  let subscriber: VideoStreamSubscriber | null = null;
  let fatal: string | null = null;
  let paintPending = false;
  let nativeFrame: Record<string, unknown> | null = null;
  const startSubscriber = () => {
    if (subscriber) return;
    subscriber = createVideoStreamSubscriber({
      canvas,
      codecs,
      viewport,
      resolveUrl: async () => {
        const ticket = await connection.run(client["remoteControl.mediaTicket"]({ sessionId }));
        return mediaChannelUrl(socketUrl, ticket.ticket);
      },
      // Read back from the canvas on the next animation frame, i.e. when the
      // picture is actually composited (WebKit also cannot sub-rect draw a
      // VideoFrame, which is what reading it directly would need).
      onFrame: (frame, config) => {
        if (options.captureFrameMetadata) {
          const rect = frame.visibleRect;
          nativeFrame = {
            format: frame.format,
            displayWidth: frame.displayWidth,
            displayHeight: frame.displayHeight,
            codedWidth: frame.codedWidth,
            codedHeight: frame.codedHeight,
            visibleRect: rect
              ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
              : null,
            colorSpace: {
              primaries: frame.colorSpace.primaries,
              transfer: frame.colorSpace.transfer,
              matrix: frame.colorSpace.matrix,
              fullRange: frame.colorSpace.fullRange,
            },
            configWidth: config.codedWidth,
            configHeight: config.codedHeight,
          };
        }
        if (paintPending) return;
        paintPending = true;
        requestAnimationFrame(() => {
          paintPending = false;
          options.onPainted(readFrameNumber(canvas, canvas.width, canvas.height), canvas);
        });
      },
      onFatal: (reason) => {
        fatal = reason;
        console.error("media path failed", reason);
      },
    });
  };

  const handle = (event: RemoteControlControllerStreamEvent) => {
    if (event.type === "session-updated" && event.session.status === "approved") startSubscriber();
  };
  const fiber = Effect.runFork(
    Stream.runForEach(client["remoteControl.watch"]({ sessionId, mediaChannel: true }), (event) =>
      Effect.sync(() => handle(event)),
    ),
  );

  return {
    send: (input) => scheduler.enqueue(input),
    stats: () => ({
      codecs,
      fatal,
      ...(subscriber?.stats() ?? {}),
      ...(nativeFrame ? { nativeFrame } : {}),
    }),
    stop: async () => {
      scheduler.clear();
      subscriber?.stop();
      await connection.run(client["remoteControl.cancel"]({ sessionId })).catch(() => undefined);
      await Effect.runPromise(Fiber.interrupt(fiber));
      canvas.remove();
      await connection.close();
    },
  };
}
