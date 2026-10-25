import type { PreviewRemoteFrameEvent } from "@t3tools/contracts";
import type { RemoteFrameDraw } from "@t3tools/client-runtime/preview/remote-frame-feed";
import { AsyncResult, type Atom, type AtomRegistry } from "effect/unstable/reactivity";

import { base64ToBytes } from "./remoteFrameEncoder";

/**
 * Opens a remote frame subscription and hands over every arrival, in order,
 * plus a failure when the stream itself breaks (an older server, a dropped
 * connection). `immediate` is what opens it: a stream atom nobody has read
 * never starts its stream (see `listenToTabAudio`).
 */
export function listenToRemoteFrames<E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<ReadonlyArray<PreviewRemoteFrameEvent>, E>>,
  handlers: {
    readonly onEvents: (events: ReadonlyArray<PreviewRemoteFrameEvent>) => void;
    readonly onFailure: () => void;
  },
): () => void {
  let lastBatch: ReadonlyArray<PreviewRemoteFrameEvent> | null = null;
  return registry.subscribe(
    atom,
    (result) => {
      if (AsyncResult.isFailure(result)) {
        handlers.onFailure();
        return;
      }
      // Waiting flags and completion re-announce the same batch; drawing a
      // patch twice is harmless but wasted.
      if (!AsyncResult.isSuccess(result) || result.value === lastBatch) return;
      lastBatch = result.value;
      handlers.onEvents(result.value);
    },
    { immediate: true },
  );
}

type DecodedPicture = CanvasImageSource & { readonly close?: () => void };

async function decodeJpeg(data: string): Promise<DecodedPicture> {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(
      new Blob([base64ToBytes(data) as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }),
    );
  }
  const image = new Image();
  image.src = `data:image/jpeg;base64,${data}`;
  await image.decode();
  return image;
}

/**
 * Draws stream pictures onto the viewer's canvas: a keyframe replaces the
 * picture, patches are drawn over it. Decoding is asynchronous, so draws run
 * strictly in arrival order; `reset` abandons whatever is still queued (the
 * viewer moved to another tab). Painting never re-renders React: only a new
 * picture size is reported.
 */
export function createRemoteFramePainter(options: {
  readonly onPicture: (picture: { readonly width: number; readonly height: number }) => void;
  readonly onError?: () => void;
}) {
  let canvas: HTMLCanvasElement | null = null;
  let generation = 0;
  let pending: Array<RemoteFrameDraw> = [];
  let running = false;

  const paint = async (draws: ReadonlyArray<RemoteFrameDraw>, at: number) => {
    for (const draw of draws) {
      if (at !== generation || canvas === null) return;
      if (draw.kind === "keyframe") {
        const picture = await decodeJpeg(draw.event.data);
        try {
          if (at !== generation || canvas === null) return;
          if (canvas.width !== draw.event.width || canvas.height !== draw.event.height) {
            canvas.width = draw.event.width;
            canvas.height = draw.event.height;
          }
          canvas.getContext("2d")?.drawImage(picture, 0, 0);
        } finally {
          picture.close?.();
        }
      } else {
        const results = await Promise.allSettled(
          draw.event.patches.map((patch) => decodeJpeg(patch.data)),
        );
        const pictures = results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        try {
          if (pictures.length !== results.length)
            throw new Error("A remote frame patch could not be decoded.");
          if (at !== generation || canvas === null) return;
          const context = canvas.getContext("2d");
          draw.event.patches.forEach((patch, index) => {
            context?.drawImage(pictures[index]!, patch.x, patch.y);
          });
        } finally {
          for (const picture of pictures) picture.close?.();
        }
      }
      options.onPicture({ width: canvas.width, height: canvas.height });
    }
  };

  const drain = async () => {
    if (running) return;
    running = true;
    try {
      while (pending.length > 0) {
        const at = generation;
        const draw = pending.shift()!;
        try {
          await paint([draw], at);
        } catch {
          if (at === generation) {
            generation += 1;
            pending = [];
            options.onError?.();
          }
        }
      }
    } finally {
      running = false;
    }
  };

  return {
    attach: (element: HTMLCanvasElement | null) => {
      canvas = element;
    },
    paint: (draws: ReadonlyArray<RemoteFrameDraw>) => {
      for (const draw of draws) {
        // An independently decodable frame supersedes every queued draw.
        if (draw.kind === "keyframe") pending = [];
        pending.push(draw);
      }
      const bytes = pending.reduce(
        (total, draw) =>
          total +
          (draw.kind === "keyframe"
            ? draw.event.data.length
            : draw.event.patches.reduce((sum, patch) => sum + patch.data.length, 0)),
        0,
      );
      // Decoder throughput may be slower than RPC consumption. Never retain an
      // unbounded promise chain: abandon a broken chain and request a new base.
      if (pending.length > 120 || bytes > 8 * 1024 * 1024) {
        generation += 1;
        pending = [];
        options.onError?.();
        return;
      }
      void drain();
    },
    reset: () => {
      generation += 1;
      pending = [];
    },
  };
}
