// @effect-diagnostics globalTimers:off globalDate:off - The bench viewer runs on wall-clock time like a phone does.
import {
  PreviewTabId,
  ThreadId,
  WS_METHODS,
  type PreviewRemoteInputAction,
  type PreviewRemoteSnapshotResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import {
  planRemoteFrameEvents,
  remoteFrameRequestSize,
  type HeldRemoteFrame,
} from "../../packages/client-runtime/src/preview/remoteFrameFeed.ts";

import {
  mergeRemoteSnapshot,
  remoteSnapshotRequest,
} from "../../packages/client-runtime/src/preview/remoteFrame.ts";
import { connectBenchClient } from "./benchClient.ts";

/** One picture-carrying (or picture-confirming) arrival at the viewer. */
export type ReceivedEvent =
  | { readonly at: number; readonly kind: "full"; readonly data: string }
  | { readonly at: number; readonly kind: "same" }
  | {
      readonly at: number;
      readonly kind: "patch";
      readonly patches: ReadonlyArray<{ x: number; y: number; data: string }>;
    };

export interface ViewerSize {
  readonly name: string;
  /** The box the frame is drawn in, in CSS pixels, and the screen's device pixel ratio. */
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
}

export interface ViewerHandle {
  readonly events: Array<ReceivedEvent>;
  readonly firstPictureAt: Promise<number>;
  readonly bytes: () => { readonly read: number; readonly written: number };
  readonly input: (action: PreviewRemoteInputAction) => Promise<void>;
  readonly stop: () => Promise<void>;
}

export const now = () => performance.timeOrigin + performance.now();

const target = { threadId: ThreadId.make("bench-thread"), tabId: PreviewTabId.make("bench-tab") };

/**
 * The polling viewer every client shipped through 0.1.737: ask for a frame,
 * name the one already held so an unchanged page costs no picture, wait the
 * interval, repeat; after each input, ask again at once.
 */
export async function startPollingViewer(options: {
  readonly url: string;
  readonly intervalMs: number;
}): Promise<ViewerHandle> {
  const connection = await Effect.runPromise(connectBenchClient(options.url));
  const client = connection.client;
  const events: Array<ReceivedEvent> = [];
  let held: PreviewRemoteSnapshotResult | null = null;
  let running = true;
  let resolveFirst: (at: number) => void = () => {};
  const firstPictureAt = new Promise<number>((resolve) => (resolveFirst = resolve));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;

  const capture = (): Promise<void> => {
    if (inFlight !== null) return inFlight;
    inFlight = Effect.runPromise(
      Effect.exit(client[WS_METHODS.previewRemoteSnapshot](remoteSnapshotRequest(target, held))),
    )
      .then((exit) => {
        if (exit._tag !== "Success") return;
        const at = now();
        const result = exit.value;
        if (result.loading) return;
        held = mergeRemoteSnapshot(held, result);
        if ("unchanged" in result) {
          events.push({ at, kind: "same" });
        } else {
          events.push({ at, kind: "full", data: result.screenshot.data });
          resolveFirst(at);
        }
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
  const tick = async () => {
    await capture();
    if (running) timer = setTimeout(() => void tick(), options.intervalMs);
  };
  void tick();

  return {
    events,
    firstPictureAt,
    bytes: () => ({ read: connection.counters.read(), written: connection.counters.written() }),
    input: async (action) => {
      const exit = await Effect.runPromise(
        Effect.exit(client[WS_METHODS.previewRemoteInput]({ ...target, action })),
      );
      if (exit._tag === "Success") await capture();
    },
    stop: async () => {
      running = false;
      if (timer !== null) clearTimeout(timer);
      await inFlight;
      await Effect.runPromise(connection.close);
    },
  };
}

/** Production feed planning and RPC backpressure, with arrival timestamps. */
export async function startStreamingViewer(options: {
  readonly url: string;
  readonly size: ViewerSize;
  readonly patches?: boolean;
}): Promise<ViewerHandle> {
  const connection = await Effect.runPromise(connectBenchClient(options.url));
  const events: Array<ReceivedEvent> = [];
  let held: HeldRemoteFrame | null = null;
  let resolveFirst: (at: number) => void = () => {};
  const firstPictureAt = new Promise<number>((resolve) => (resolveFirst = resolve));
  let failure: unknown = null;
  const fiber = Effect.runFork(
    Stream.runForEach(
      connection.client[WS_METHODS.previewRemoteFrames]({
        ...target,
        ...remoteFrameRequestSize({
          boxWidth: options.size.width,
          boxHeight: options.size.height,
          devicePixelRatio: options.size.devicePixelRatio,
        }),
        patches: options.patches !== false,
      }),
      (event) =>
        Effect.sync(() => {
          const at = now();
          const batch = planRemoteFrameEvents(held, [event], {
            patches: options.patches !== false,
          });
          if (batch.resync || batch.unavailable)
            throw new Error(batch.unavailable ?? "Frame chain broke");
          held = batch.held;
          for (const draw of batch.draws) {
            if (draw.kind === "keyframe") events.push({ at, kind: "full", data: draw.event.data });
            else events.push({ at, kind: "patch", patches: draw.event.patches });
            resolveFirst(at);
          }
        }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          failure = cause;
        }),
      ),
    ),
  );
  return {
    events,
    firstPictureAt,
    bytes: () => ({ read: connection.counters.read(), written: connection.counters.written() }),
    input: (action) =>
      Effect.runPromise(
        connection.client[WS_METHODS.previewRemoteInput]({ ...target, action }),
      ).then(() => undefined),
    stop: async () => {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await Effect.runPromise(connection.close);
      if (failure !== null) throw new Error(`Stream failed: ${String(failure)}`);
    },
  };
}
