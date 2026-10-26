import {
  PreviewTabId,
  ThreadId,
  type PreviewMediaDemand,
  type PreviewRemoteFramePageState,
  type PreviewRemoteInputAction,
} from "@t3tools/contracts";
import { mediaChannelUrl } from "../../packages/client-runtime/src/media/mediaChannelSocket.ts";
import {
  createVideoStreamPublisher,
  type VideoStreamPublisher,
} from "../../packages/client-runtime/src/media/videoStreamPublisher.ts";
import {
  createVideoStreamSubscriber,
  type VideoStreamSubscriber,
} from "../../packages/client-runtime/src/media/videoStreamSubscriber.ts";
import { detectDecodableCodecs } from "../../packages/client-runtime/src/media/videoCodecs.ts";
import { decodeMediaPacket } from "@t3tools/shared/mediaPacket";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import {
  capturePreviewTab,
  createPreviewMediaHost,
  previewCaptureSize,
  type PreviewVideoSourceDescriptor,
} from "../../apps/web/src/components/preview/remoteMedia/previewMediaHost.ts";
import { connectBrowserClient } from "./browserClient.ts";
import { MARKER, SCENE_VIEWPORT, readMarker } from "./scenes.mjs";
import type { ViewerSize } from "./viewer.ts";

const target = { threadId: ThreadId.make("bench-thread"), tabId: PreviewTabId.make("bench-tab") };
const now = () => performance.timeOrigin + performance.now();
const bridge = () =>
  (
    globalThis as typeof globalThis & {
      previewBenchMediaBridge: {
        videoSource: () => Promise<PreviewVideoSourceDescriptor>;
        hostMediaUrl: (target: PreviewMediaDemand) => Promise<string>;
      };
    }
  ).previewBenchMediaBridge;

let host: ReturnType<typeof createPreviewMediaHost> | null = null;
let publisher: VideoStreamPublisher | null = null;
let page: PreviewRemoteFramePageState | null = null;
let hostTabId: string = target.tabId;
let captureAvailable = true;
let captureDescription: {
  cssWidth: number;
  cssHeight: number;
  devicePixelRatio: number;
  webContentsId?: number;
  requested: { width: number; height: number };
} | null = null;

export interface VideoReceivedFrame {
  readonly kind: "video";
  readonly at: number;
  readonly decodedAt: number;
  readonly marker: number | null;
  readonly width: number;
  readonly height: number;
}

let closeViewer: (() => Promise<void>) | null = null;
let subscriber: VideoStreamSubscriber | null = null;
let viewerFrames: VideoReceivedFrame[] = [];
let viewerFailure: string | null = null;
let viewerCodecs: ReadonlyArray<string> = [];
let viewerCanvas: HTMLCanvasElement | null = null;
let firstPicture: Promise<number> = Promise.reject(new Error("No video viewer started."));
void firstPicture.catch(() => undefined);
let sendInput: ((action: PreviewRemoteInputAction) => Promise<void>) | null = null;

/** Read only the small pinned marker, after the production decoder has drawn the picture. */
function markerFromCanvas(canvas: HTMLCanvasElement) {
  const width = Math.min(
    canvas.width,
    Math.ceil(
      ((MARKER.left + MARKER.bits * MARKER.cell + 4) * canvas.width) / SCENE_VIEWPORT.width,
    ),
  );
  const height = Math.min(
    canvas.height,
    Math.ceil(((MARKER.top + MARKER.cell + 4) * canvas.height) / SCENE_VIEWPORT.height),
  );
  const context = canvas.getContext("2d");
  if (!context) return null;
  const pixels = context.getImageData(0, 0, width, height).data;
  return readMarker((x, y) => {
    const offset = (y * width + x) * 4;
    return (pixels[offset]! + pixels[offset + 1]! + pixels[offset + 2]!) / 3;
  }, canvas);
}

const api = {
  async startHost(options: {
    url: string;
    clientId: string;
    connectionId: string;
    tabId?: string;
  }) {
    host?.dispose();
    captureDescription = null;
    captureAvailable = true;
    hostTabId = options.tabId ?? target.tabId;
    host = createPreviewMediaHost({
      runtime: () => ({ runtimeTabId: hostTabId, generation: options.connectionId }),
      resolveUrl: (demand) => bridge().hostMediaUrl(demand),
      openSource: async () => {
        if (!captureAvailable) throw new Error("The isolated fixture capture is unavailable.");
        const source = await bridge().videoSource();
        captureDescription = {
          cssWidth: source.width,
          cssHeight: source.height,
          devicePixelRatio: source.devicePixelRatio,
          ...(source.webContentsId === undefined ? {} : { webContentsId: source.webContentsId }),
          requested: previewCaptureSize(source),
        };
        return capturePreviewTab(source);
      },
      readState: () => page,
      subscribeTarget: () => () => undefined,
      createPublisher: (input) => {
        publisher = createVideoStreamPublisher(input);
        return publisher;
      },
    });
  },
  setDemand(tabs: ReadonlyArray<PreviewMediaDemand>) {
    host?.setDemand(tabs);
  },
  setPage(state: PreviewRemoteFramePageState) {
    page = state;
    host?.stateChanged(hostTabId);
  },
  sourceChanged() {
    host?.sourceChanged(hostTabId);
  },
  setCaptureAvailable(available: boolean) {
    captureAvailable = available;
    host?.sourceChanged(hostTabId);
  },
  hostStats() {
    return publisher
      ? { ...publisher.stats(), source: captureDescription, captureAvailable }
      : null;
  },
  async startViewer(options: { url: string; size: ViewerSize }) {
    await closeViewer?.();
    const OriginalSocket = globalThis.WebSocket;
    const arrivals = new Map<number, number>();
    // Instrument receipt before the unmodified subscriber sees the same packet.
    class MeasuredSocket extends OriginalSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener("message", (event: MessageEvent) => {
          if (!(event.data instanceof ArrayBuffer)) return;
          const packet = decodeMediaPacket(new Uint8Array(event.data));
          if (!packet) return;
          arrivals.set(packet.timestamp, now());
          if (arrivals.size > 512) arrivals.delete(arrivals.keys().next().value!);
        });
      }
    }
    globalThis.WebSocket = MeasuredSocket;
    viewerFrames = [];
    viewerFailure = null;
    let connection: Awaited<ReturnType<typeof connectBrowserClient>>;
    try {
      viewerCodecs = await detectDecodableCodecs();
      if (viewerCodecs.length === 0)
        throw new Error("This benchmark viewer has no supported WebCodecs decoder.");
      connection = await connectBrowserClient(options.url);
    } catch (error) {
      globalThis.WebSocket = OriginalSocket;
      throw error;
    }
    const canvas = document.createElement("canvas");
    canvas.style.cssText = `width:${options.size.width}px;height:${options.size.height}px;object-fit:contain`;
    document.body.append(canvas);
    viewerCanvas = canvas;
    let resolveFirst!: (at: number) => void;
    let rejectFirst!: (error: Error) => void;
    firstPicture = new Promise<number>((resolve, reject) => {
      resolveFirst = resolve;
      rejectFirst = reject;
    });
    void firstPicture.catch(() => undefined);
    const fail = (reason: string) => {
      viewerFailure = reason;
      rejectFirst(new Error(reason));
    };
    const fiber = Effect.runFork(
      Stream.runForEach(connection.client["preview.mediaWatch"](target), (event) =>
        Effect.sync(() => {
          if (event.type !== "ready") {
            fail(event.reason);
            return;
          }
          subscriber?.stop();
          subscriber = createVideoStreamSubscriber({
            canvas,
            codecs: viewerCodecs,
            viewport: () => ({
              width: options.size.width,
              height: options.size.height,
              devicePixelRatio: options.size.devicePixelRatio,
              zoom: 1,
            }),
            resolveUrl: async () => {
              const ticket = await Effect.runPromise(
                connection.client["preview.mediaTicket"]({ watchId: event.watchId }),
              );
              return mediaChannelUrl(options.url, ticket.ticket);
            },
            onFrame: (frame) => {
              const decodedAt = now();
              const at = arrivals.get(frame.timestamp);
              if (at === undefined) {
                fail("Decoded frame has no measured packet receipt.");
                return;
              }
              arrivals.delete(frame.timestamp);
              viewerFrames.push({
                kind: "video",
                at,
                decodedAt,
                marker: markerFromCanvas(canvas),
                width: frame.displayWidth,
                height: frame.displayHeight,
              });
              resolveFirst(at);
            },
            onFatal: fail,
            onEnded: () => fail("The preview media topic ended during the sample."),
          });
        }),
      ).pipe(Effect.catchCause((cause) => Effect.sync(() => fail(String(cause))))),
    );
    sendInput = (action) =>
      Effect.runPromise(connection.client["preview.remoteInput"]({ ...target, action })).then(
        () => undefined,
      );
    closeViewer = async () => {
      subscriber?.stop();
      try {
        await Effect.runPromise(Fiber.interrupt(fiber));
        await connection.close();
      } finally {
        globalThis.WebSocket = OriginalSocket;
        canvas.remove();
        closeViewer = null;
        sendInput = null;
      }
    };
  },
  firstPicture() {
    return firstPicture;
  },
  viewerInput(action: PreviewRemoteInputAction) {
    if (!sendInput) throw new Error("No video viewer is active.");
    return sendInput(action);
  },
  viewerSnapshot(includeImage = false) {
    return {
      frames: viewerFrames,
      failure: viewerFailure,
      stats: { ...subscriber?.stats(), codecs: viewerCodecs },
      ...(includeImage && viewerCanvas
        ? { png: viewerCanvas.toDataURL("image/png").split(",")[1] }
        : {}),
    };
  },
  async stopViewer() {
    await closeViewer?.();
  },
};

Object.assign(globalThis, { previewBenchMedia: api });
export type PreviewBenchMediaApi = typeof api;
