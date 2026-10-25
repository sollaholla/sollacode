/**
 * Benchmark host page: a synthetic desktop captured with
 * `canvas.captureStream()` and published the way the desktop app publishes
 * its screen.
 *
 * `legacy` replays RemoteControlCoordinator's pre-media-channel paths with the
 * production modules: MediaRecorder (VP8, 60 ms slices, 8 Mbps) through the
 * publish queue as base64 RPC chunks, or the JPEG loop (1600 wide, q65, one
 * publish in flight) once a viewer asks for image fallback. `media` runs the
 * production WebCodecs publisher over the binary media channel.
 */
import type { RemoteControlHostStreamEvent, RemoteControlInput } from "@t3tools/contracts";
import { REMOTE_CONTROL_CHUNK_MAX_BASE64_LENGTH } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import {
  encodeBlobToBase64,
  REMOTE_CONTROL_TIMESLICE_MS,
  REMOTE_CONTROL_VIDEO_BITS_PER_SECOND,
  selectRemoteControlMimeType,
} from "../../../web/src/components/remoteControl/remoteControlEncoder.ts";
import { createRemoteControlVideoPublishQueue } from "../../../web/src/components/remoteControl/remoteControlVideoPublishQueue.ts";
import { connectBenchRpc, type BenchRpcConnection } from "./benchRpc.ts";
import { startMediaHost, type MediaHostHandle } from "./hostMedia.ts";
import {
  type BenchScene,
  paintFrame,
  SCENE_REPAINT_MS,
  SOURCE_HEIGHT,
  SOURCE_WIDTH,
} from "./scene.ts";

export type BenchPipeline = "legacy" | "media";

interface HostConfig {
  readonly pipeline: BenchPipeline;
  readonly scene: BenchScene;
}

const now = () => performance.timeOrigin + performance.now();

const canvas = document.createElement("canvas");
canvas.width = SOURCE_WIDTH;
canvas.height = SOURCE_HEIGHT;
document.body.append(canvas);
const ctx = canvas.getContext("2d", { alpha: false })!;

let drawLog: Array<[frame: number, time: number]> = [];
let inputLog: Array<[frame: number, time: number]> = [];
let frame = 0;
let scene: BenchScene = "idle";
let repaintTimer: number | null = null;
let stopCurrent: (() => Promise<void>) | null = null;
const counters = { chunks: 0, chunkBytes: 0, frames: 0, frameBytes: 0, restarts: 0 };

function paintNext(): void {
  frame += 1;
  paintFrame(ctx, scene, frame);
  drawLog.push([frame, now()]);
}

function startScene(next: BenchScene): void {
  scene = next;
  frame = 0;
  paintFrame(ctx, scene, 0);
  drawLog = [[0, now()]];
  inputLog = [];
  const interval = SCENE_REPAINT_MS[scene];
  if (Number.isFinite(interval)) {
    repaintTimer = window.setInterval(paintNext, interval);
  }
}

function stopScene(): void {
  if (repaintTimer !== null) window.clearInterval(repaintTimer);
  repaintTimer = null;
}

/** The input scene types one character per key-down the viewer sends. */
function applyInput(input: RemoteControlInput): void {
  if (scene !== "input") return;
  if (input.type === "key" && input.action === "down") {
    paintNext();
    inputLog.push([frame, now()]);
  }
}

async function startLegacy(): Promise<() => Promise<void>> {
  const stream = canvas.captureStream();
  const connection: BenchRpcConnection = await connectBenchRpc(
    `${location.origin.replace(/^http/, "ws")}/ws?as=host`,
  );
  const { client } = connection;
  const mimeType = selectRemoteControlMimeType();
  if (!mimeType) throw new Error("No MediaRecorder codec");
  let active: { connectionId: string; sessionId: string } | null = null;
  let recorder: MediaRecorder | null = null;
  let generation = 0;
  let sequence = 0;
  let imageFallback = false;
  let jpegRunning = false;
  let restartTimer: number | null = null;

  const stopRecorder = () => {
    generation += 1;
    try {
      recorder?.stop();
    } catch {
      // Already stopped.
    }
    recorder = null;
  };

  const startRecorder = () => {
    if (!active || imageFallback) return;
    const session = active;
    const attempt = ++generation;
    const queue = createRemoteControlVideoPublishQueue<{ blob: Blob; isInit: boolean }>({
      maxPendingBytes: Math.floor(REMOTE_CONTROL_CHUNK_MAX_BASE64_LENGTH / 4) * 3,
      pauseAtBytes: 512 * 1_024,
      resumeAtBytes: 128 * 1_024,
      sizeOf: (item) => item.blob.size,
      publish: async ({ blob, isInit }) => {
        const data = await encodeBlobToBase64(blob);
        if (attempt !== generation) return;
        counters.chunks += 1;
        counters.chunkBytes += blob.size;
        await connection.run(
          client["remoteControl.hostPublishVideoChunk"]({
            clientId: "bench-host",
            connectionId: session.connectionId,
            pointerLocked: false,
            cursorShape: "default",
            chunk: {
              sessionId: session.sessionId,
              sequence: sequence++,
              capturedAt: new Date().toISOString(),
              mimeType,
              isInit,
              data,
            },
          }),
        );
      },
      onError: (cause) => console.error("publish failed", cause),
    });
    const current = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: REMOTE_CONTROL_VIDEO_BITS_PER_SECOND,
    });
    recorder = current;
    let first = true;
    current.addEventListener("dataavailable", (event) => {
      if (attempt !== generation || event.data.size === 0) return;
      queue.enqueue({ blob: event.data, isInit: first }, current);
      first = false;
    });
    current.start(REMOTE_CONTROL_TIMESLICE_MS);
  };

  // The desktop app captures each JPEG with desktopCapturer in the main
  // process; here the canvas is scaled and encoded in the page. Same size,
  // quality and pacing, minus the native capture cost - so this baseline is
  // if anything optimistic.
  const runJpegLoop = async () => {
    if (jpegRunning) return;
    jpegRunning = true;
    const scaled = new OffscreenCanvas(1_600, Math.round((1_600 * SOURCE_HEIGHT) / SOURCE_WIDTH));
    const scaledCtx = scaled.getContext("2d")!;
    let inFlight: Promise<unknown> | null = null;
    let frameSequence = 0;
    while (active && imageFallback) {
      const startedAt = performance.now();
      scaledCtx.drawImage(canvas, 0, 0, scaled.width, scaled.height);
      const blob = await scaled.convertToBlob({ type: "image/jpeg", quality: 0.65 });
      const data = await encodeBlobToBase64(blob);
      if (inFlight) await inFlight;
      const session = active;
      if (!session) break;
      counters.frames += 1;
      counters.frameBytes += blob.size;
      inFlight = connection
        .run(
          client["remoteControl.hostPublishFrame"]({
            clientId: "bench-host",
            connectionId: session.connectionId,
            pointerLocked: false,
            cursorShape: "default",
            frame: {
              sessionId: session.sessionId,
              sequence: frameSequence++,
              capturedAt: new Date().toISOString(),
              mimeType: "image/jpeg",
              width: scaled.width,
              height: scaled.height,
              data,
            },
          }),
        )
        .catch(() => undefined);
      const elapsed = performance.now() - startedAt;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 1_000 / 30 - elapsed)));
    }
    jpegRunning = false;
  };

  let markConnected: () => void = () => {};
  const connected = new Promise<void>((done) => {
    markConnected = done;
  });
  const handle = (event: RemoteControlHostStreamEvent) => {
    switch (event.type) {
      case "connected":
        markConnected();
        return;
      case "access-requested":
        void connection
          .run(
            client["remoteControl.hostRespond"]({
              clientId: "bench-host",
              connectionId: event.connectionId,
              requestId: event.requestId,
              decision: "approve",
              grantedCapabilities: event.session.requestedCapabilities,
            }),
          )
          .then((session) => {
            active = { connectionId: event.connectionId, sessionId: session.sessionId };
            startRecorder();
          });
        return;
      case "video-restart-requested":
        if (restartTimer !== null) return;
        restartTimer = window.setTimeout(() => {
          restartTimer = null;
          counters.restarts += 1;
          stopRecorder();
          startRecorder();
        }, 150);
        return;
      case "input":
        if (event.input.type === "request-image-fallback") {
          imageFallback = true;
          stopRecorder();
          void runJpegLoop();
          return;
        }
        applyInput(event.input);
        return;
      case "session-ended":
        active = null;
        stopRecorder();
        return;
      default:
        return;
    }
  };

  const fiber = Effect.runFork(
    Stream.runForEach(
      client["remoteControl.hostConnect"]({
        clientId: "bench-host",
        environmentId: "bench-env" as never,
        platform: "macos",
        capabilities: ["screen", "pointer", "keyboard"],
      }),
      (event) => Effect.sync(() => handle(event)),
    ),
  );

  await connected;
  return async () => {
    active = null;
    stopRecorder();
    for (const track of stream.getTracks()) track.stop();
    await Effect.runPromise(Fiber.interrupt(fiber));
    await connection.close();
  };
}

let mediaHost: MediaHostHandle | null = null;

declare global {
  interface Window {
    bench: {
      start(config: HostConfig): Promise<void>;
      stop(): Promise<void>;
      drawLog(): Array<[number, number]>;
      inputLog(): Array<[number, number]>;
      counters(): Record<string, unknown>;
      now(): number;
    };
  }
}

window.bench = {
  async start(config) {
    await window.bench.stop();
    for (const key of Object.keys(counters) as Array<keyof typeof counters>) counters[key] = 0;
    startScene(config.scene);
    if (config.pipeline === "legacy") {
      stopCurrent = await startLegacy();
    } else {
      mediaHost = await startMediaHost({ canvas, onInput: applyInput });
      stopCurrent = () => mediaHost!.stop();
    }
  },
  async stop() {
    stopScene();
    const stop = stopCurrent;
    stopCurrent = null;
    if (stop) await stop();
    mediaHost = null;
  },
  drawLog: () => drawLog,
  inputLog: () => inputLog,
  counters: () => ({ ...counters, ...(mediaHost?.stats() ?? {}) }),
  now,
};
