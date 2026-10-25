/**
 * Benchmark viewer page, laid out like RemoteControlViewerDialog: a header,
 * the picture pane, and the control strip. It renders with the production
 * players and records which frame it showed when, read back from the strip
 * in the picture itself.
 */
import type { RemoteControlControllerStreamEvent, RemoteControlInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { createRemoteControlInputScheduler } from "../../../web/src/components/remoteControl/remoteControlInputScheduler.ts";
import {
  createRemoteControlVideoSink,
  describeUnsupportedCodec,
  type RemoteControlVideoSink,
} from "../../../web/src/components/remoteControl/remoteControlPlayer.ts";
import { connectBenchRpc } from "./benchRpc.ts";
import type { BenchPipeline } from "./host.ts";
import {
  lumaPsnr,
  readFrameNumber,
  renderFrame,
  SOURCE_HEIGHT,
  SOURCE_WIDTH,
  STRIP_HEIGHT,
  type BenchScene,
} from "./scene.ts";
import { startMediaViewer, type MediaViewerHandle } from "./viewerMedia.ts";

const now = () => performance.timeOrigin + performance.now();

document.body.style.cssText =
  "margin:0;background:#111;display:flex;flex-direction:column;height:100vh;overflow:hidden";
const header = document.createElement("div");
header.style.cssText = "height:56px;flex:none";
const pane = document.createElement("div");
pane.style.cssText = "position:relative;flex:1;min-height:0;margin:0 8px";
const strip = document.createElement("div");
strip.style.cssText = "height:44px;flex:none";
document.body.append(header, pane, strip);

let shownLog: Array<[frame: number, time: number]> = [];
let sentLog: Array<[index: number, time: number]> = [];
let lastShownFrame = -1;
let stopCurrent: (() => Promise<void>) | null = null;
let displayed: { source: CanvasImageSource; width: number; height: number } | null = null;
let mediaViewer: MediaViewerHandle | null = null;
const counters = { chunks: 0, frames: 0, decodedUnreadable: 0, fallbacks: 0 };

/** Records a displayed picture; called once per presented frame. */
function noteDisplayed(source: CanvasImageSource, width: number, height: number): void {
  displayed = { source, width, height };
  const value = readFrameNumber(source, width, height);
  if (value === null) {
    counters.decodedUnreadable += 1;
    return;
  }
  if (value === lastShownFrame) return;
  lastShownFrame = value;
  shownLog.push([value, now()]);
}

function mediaElementStyle(element: HTMLElement): void {
  element.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:contain";
}

async function startLegacy(): Promise<{
  stop: () => Promise<void>;
  send: (input: RemoteControlInput) => void;
}> {
  const connection = await connectBenchRpc(
    `${location.origin.replace(/^http/, "ws")}/ws?as=viewer`,
  );
  const { client } = connection;
  const session = await connection.run(
    client["remoteControl.requestAccess"]({
      clientId: "bench-viewer",
      requestedCapabilities: ["screen", "pointer", "keyboard"],
    }),
  );
  const sessionId = session.sessionId;
  let sequence = 0;
  // createEnvironmentRpcCommand's "serial" mode: each send waits for the
  // previous one's round trip.
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

  let video: HTMLVideoElement | null = null;
  let image: HTMLImageElement | null = null;
  let sink: RemoteControlVideoSink | null = null;
  let fellBack = false;

  const fallBack = () => {
    if (fellBack) return;
    fellBack = true;
    counters.fallbacks += 1;
    sink?.dispose();
    sink = null;
    scheduler.enqueue({ type: "request-image-fallback" });
  };

  const watchVideo = (element: HTMLVideoElement) => {
    const onFrame = () => {
      if (video !== element) return;
      if (element.videoWidth > 0) noteDisplayed(element, element.videoWidth, element.videoHeight);
      element.requestVideoFrameCallback(onFrame);
    };
    element.requestVideoFrameCallback(onFrame);
  };

  const handle = (event: RemoteControlControllerStreamEvent) => {
    if (event.type === "video-chunk") {
      counters.chunks += 1;
      if (fellBack) return;
      if (event.chunk.isInit) {
        if (describeUnsupportedCodec(event.chunk.mimeType) !== null) {
          // What the dialog does on a phone without MediaSource.
          fallBack();
          return;
        }
        sink?.dispose();
        video?.remove();
        video = document.createElement("video");
        video.muted = true;
        video.autoplay = true;
        video.playsInline = true;
        mediaElementStyle(video);
        pane.append(video);
        sink = createRemoteControlVideoSink(event.chunk.mimeType, video, (detail) => {
          console.error("video sink failed", detail);
          fallBack();
        });
        if (!sink) {
          fallBack();
          return;
        }
        video.src = sink.url;
        watchVideo(video);
      }
      sink?.append(event.chunk);
      return;
    }
    if (event.type === "frame") {
      counters.frames += 1;
      if (!image) {
        sink?.dispose();
        video?.remove();
        video = null;
        image = document.createElement("img");
        mediaElementStyle(image);
        pane.append(image);
        const current = image;
        current.addEventListener("load", () => {
          requestAnimationFrame(() =>
            noteDisplayed(current, current.naturalWidth, current.naturalHeight),
          );
        });
      }
      image.src = `data:${event.frame.mimeType};base64,${event.frame.data}`;
    }
  };

  const fiber = Effect.runFork(
    Stream.runForEach(client["remoteControl.watch"]({ sessionId }), (event) =>
      Effect.sync(() => handle(event)),
    ),
  );

  return {
    send: (input) => scheduler.enqueue(input),
    stop: async () => {
      scheduler.clear();
      await connection.run(client["remoteControl.cancel"]({ sessionId })).catch(() => undefined);
      await Effect.runPromise(Fiber.interrupt(fiber));
      sink?.dispose();
      video?.remove();
      image?.remove();
      await connection.close();
    },
  };
}

let sendInput: ((input: RemoteControlInput) => void) | null = null;
let typingTimer: number | null = null;

declare global {
  interface Window {
    bench: {
      start(config: { pipeline: BenchPipeline; typeEveryMs?: number }): Promise<void>;
      stop(): Promise<void>;
      shownLog(): Array<[number, number]>;
      sentLog(): Array<[number, number]>;
      counters(): Record<string, unknown>;
      score(
        scene: BenchScene,
      ): { frame: number; psnr: number; width: number; height: number } | null;
      images(scene: BenchScene): Promise<{ received: string; truth: string } | null>;
      now(): number;
      environment(): Record<string, unknown>;
    };
  }
}

/** The picture's on-screen rectangle in device pixels (object-fit: contain). */
function pictureDeviceSize(): { width: number; height: number } {
  const rect = pane.getBoundingClientRect();
  const scale = Math.min(rect.width / SOURCE_WIDTH, rect.height / SOURCE_HEIGHT);
  return {
    width: Math.round(SOURCE_WIDTH * scale * devicePixelRatio),
    height: Math.round(SOURCE_HEIGHT * scale * devicePixelRatio),
  };
}

window.bench = {
  async start(config) {
    await window.bench.stop();
    shownLog = [];
    sentLog = [];
    lastShownFrame = -1;
    displayed = null;
    for (const key of Object.keys(counters) as Array<keyof typeof counters>) counters[key] = 0;
    if (config.pipeline === "legacy") {
      const legacy = await startLegacy();
      sendInput = legacy.send;
      stopCurrent = legacy.stop;
    } else {
      mediaViewer = await startMediaViewer({
        pane,
        onPainted: (value, canvas) => {
          displayed = { source: canvas, width: canvas.width, height: canvas.height };
          if (value === null) {
            counters.decodedUnreadable += 1;
            return;
          }
          if (value === lastShownFrame) return;
          lastShownFrame = value;
          shownLog.push([value, now()]);
        },
      });
      sendInput = mediaViewer.send;
      stopCurrent = () => mediaViewer!.stop();
    }
    if (config.typeEveryMs) {
      let index = 0;
      typingTimer = window.setInterval(() => {
        sentLog.push([index, now()]);
        index += 1;
        sendInput?.({ type: "key", action: "down", code: "KeyA", key: "a", repeat: false });
        sendInput?.({ type: "key", action: "up", code: "KeyA", key: "a", repeat: false });
      }, config.typeEveryMs);
    }
  },
  async stop() {
    if (typingTimer !== null) window.clearInterval(typingTimer);
    typingTimer = null;
    const stop = stopCurrent;
    stopCurrent = null;
    sendInput = null;
    if (stop) await stop();
    mediaViewer = null;
  },
  shownLog: () => shownLog,
  sentLog: () => sentLog,
  counters: () => ({ ...counters, ...mediaViewer?.stats() }),
  /**
   * Legibility: the displayed picture, resampled to its on-screen device
   * pixel size, against the same frame rendered locally and resampled the same
   * way. Both sides pass through this engine's scaler, so the score isolates
   * what encoding and transport did to the picture.
   */
  score(scene) {
    if (!displayed) return null;
    const frame = readFrameNumber(displayed.source, displayed.width, displayed.height);
    if (frame === null) return null;
    const size = pictureDeviceSize();
    const draw = (source: CanvasImageSource) => {
      const target = new OffscreenCanvas(size.width, size.height);
      const ctx = target.getContext("2d", { willReadFrequently: true })!;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(source, 0, 0, size.width, size.height);
      return ctx.getImageData(0, 0, size.width, size.height).data;
    };
    const truthCanvas = new OffscreenCanvas(SOURCE_WIDTH, SOURCE_HEIGHT);
    renderFrame(truthCanvas.getContext("2d")!, scene, frame);
    const received = draw(displayed.source);
    const truth = draw(truthCanvas);
    const skip = Math.ceil(((STRIP_HEIGHT + 4) * size.height) / SOURCE_HEIGHT);
    return {
      frame,
      psnr: lumaPsnr(received, truth, size.width, size.height, skip),
      ...size,
    };
  },
  /** PNG data URLs of the received picture and the ground truth, as scored. */
  async images(scene) {
    if (!displayed) return null;
    const frame = readFrameNumber(displayed.source, displayed.width, displayed.height);
    if (frame === null) return null;
    const size = pictureDeviceSize();
    const toUrl = async (source: CanvasImageSource) => {
      const target = new OffscreenCanvas(size.width, size.height);
      const ctx = target.getContext("2d")!;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(source, 0, 0, size.width, size.height);
      const blob = await target.convertToBlob({ type: "image/png" });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      }
      return `data:image/png;base64,${btoa(binary)}`;
    };
    const truthCanvas = new OffscreenCanvas(SOURCE_WIDTH, SOURCE_HEIGHT);
    renderFrame(truthCanvas.getContext("2d")!, scene, frame);
    return { received: await toUrl(displayed.source), truth: await toUrl(truthCanvas) };
  },
  now,
  environment: () => ({
    userAgent: navigator.userAgent,
    devicePixelRatio,
    viewport: [innerWidth, innerHeight],
    secureContext: isSecureContext,
    mediaSource: typeof MediaSource !== "undefined",
    videoDecoder: typeof VideoDecoder !== "undefined",
    picture: pictureDeviceSize(),
  }),
};
