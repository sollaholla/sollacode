import type {
  PreviewRemoteFrameDemand,
  PreviewRemoteFrameEvent,
  PreviewRemoteFramePageState,
} from "@t3tools/contracts";
import {
  createLatestFramePipeline,
  type LatestFramePipeline,
  type PipelineScheduler,
} from "@t3tools/client-runtime/preview/remote-frame-pipeline";

import type { RemoteFrameEncodeInput, RemoteFrameEncoded } from "./remoteFrameEncoder";

/**
 * The desktop's side of the remote frame stream. The server says which tabs
 * remote viewers watch and at what size (`frameDemand`); for each one this
 * starts the guest's screencast, turns its pictures into keyframes and
 * patches, and publishes them, one at a time and newest first, together with
 * the page's address, title and the agent's cursor. Everything it touches is
 * passed in, so the desktop window and the bench drive the same code.
 */

/** Pictures a watched tab may publish per second, at most (one per this many ms). */
export const REMOTE_FRAME_PUBLISH_INTERVAL_MS = 50;
/**
 * While a page loads it paints half-built pictures; a viewer keeps its last
 * picture for up to this long, as it did when it polled, then sees the page
 * as it is even if it never finishes loading.
 */
export const REMOTE_FRAME_LOADING_HOLD_MS = 1_500;
/** A guest that has drawn nothing this long after starting is asked to draw. */
export const REMOTE_FRAME_FIRST_PICTURE_RETRY_MS = 1_000;

type Target = Pick<PreviewRemoteFrameDemand, "threadId" | "tabId">;

export interface RemoteFrameStreamerOptions {
  /** The desktop's id for the tab a viewer named (side chats share their parent's browser). */
  readonly runtimeTabId: (target: Target) => string;
  readonly capture: {
    readonly start: (
      runtimeTabId: string,
      size: { readonly maxWidth: number; readonly maxHeight: number },
    ) => Promise<void>;
    readonly stop: (runtimeTabId: string) => Promise<void>;
    readonly refresh: (runtimeTabId: string) => Promise<void>;
  };
  readonly encoder: {
    readonly encode: (key: string, input: RemoteFrameEncodeInput) => Promise<RemoteFrameEncoded>;
    readonly reset: (key: string) => void;
    readonly drop: (key: string) => void;
  };
  readonly publish: (
    target: Target,
    events: ReadonlyArray<PreviewRemoteFrameEvent>,
  ) => Promise<void>;
  readonly readState: (runtimeTabId: string) => PreviewRemoteFramePageState | null;
  readonly scheduler: PipelineScheduler;
  readonly onError?: (error: unknown, target: Target) => void;
}

interface Watched {
  demand: PreviewRemoteFrameDemand;
  readonly key: string;
  runtimeTabId: string;
  readonly pipeline: LatestFramePipeline<string>;
  /** The last picture published, which a patch is drawn over. */
  sequence: number | null;
  nextSequence: number;
  needsKeyframe: boolean;
  keyframeGeneration: number;
  latestFrame: string | null;
  captureGeneration: number;
  captureLost: boolean;
  publishedState: string | null;
  loadingSince: number | null;
  pictures: number;
  disposed: boolean;
}

const targetKey = (target: Target) => `${target.threadId}\u0000${target.tabId}`;

export function createRemoteFrameStreamer(options: RemoteFrameStreamerOptions) {
  const watched = new Map<string, Watched>();
  const captureOperations = new Map<string, Promise<void>>();
  const captureOperation = (runtimeTabId: string, run: () => Promise<void>) => {
    const previous = captureOperations.get(runtimeTabId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    captureOperations.set(runtimeTabId, next);
    void next
      .finally(() => {
        if (captureOperations.get(runtimeTabId) === next) captureOperations.delete(runtimeTabId);
      })
      .catch(() => undefined);
    return next;
  };

  const report = (entry: Watched, error: unknown) => options.onError?.(error, entry.demand);

  const stateEvent = (entry: Watched): PreviewRemoteFrameEvent | null => {
    const state = options.readState(entry.runtimeTabId);
    if (state === null) return null;
    const serialized = JSON.stringify(state);
    if (serialized === entry.publishedState) return null;
    return { type: "state", state };
  };

  const notePublishedState = (entry: Watched, events: ReadonlyArray<PreviewRemoteFrameEvent>) => {
    for (const event of events) {
      if (event.type === "state") entry.publishedState = JSON.stringify(event.state);
    }
  };

  const process = async (entry: Watched, data: string) => {
    if (entry.disposed || entry.captureLost) return;
    const keyframeGeneration = entry.keyframeGeneration;
    const captureGeneration = entry.captureGeneration;
    const encoded = await options.encoder.encode(entry.key, {
      data,
      forceKeyframe: entry.needsKeyframe || entry.sequence === null,
      keyframesOnly: !entry.demand.patches,
    });
    if (entry.disposed || encoded === null || captureGeneration !== entry.captureGeneration) return;
    const sequence = entry.nextSequence++;
    const pixels: PreviewRemoteFrameEvent =
      encoded.type === "keyframe" || entry.sequence === null
        ? {
            type: "keyframe",
            sequence,
            width: encoded.width,
            height: encoded.height,
            mimeType: "image/jpeg",
            data: encoded.type === "keyframe" ? encoded.data : data,
          }
        : {
            type: "patch",
            sequence,
            after: entry.sequence,
            width: encoded.width,
            height: encoded.height,
            mimeType: "image/jpeg",
            patches: encoded.patches.map(({ x, y, width, height, data: patch }) => ({
              x,
              y,
              width,
              height,
              data: patch,
            })),
          };
    const state = stateEvent(entry);
    const events = state === null ? [pixels] : [state, pixels];
    try {
      await options.publish(entry.demand, events);
    } catch (error) {
      // The server may not have the picture a next patch would follow.
      options.encoder.reset(entry.key);
      entry.needsKeyframe = true;
      throw error;
    }
    entry.sequence = sequence;
    entry.pictures += 1;
    if (pixels.type === "keyframe" && keyframeGeneration === entry.keyframeGeneration)
      entry.needsKeyframe = false;
    notePublishedState(entry, events);
  };

  const holdWhileLoading = (entry: Watched, loading: boolean) => {
    if (!loading) {
      entry.loadingSince = null;
      entry.pipeline.setPaused(false);
      return;
    }
    if (entry.loadingSince !== null) return;
    const since = options.scheduler.now();
    entry.loadingSince = since;
    entry.pipeline.setPaused(true);
    void options.scheduler.sleep(REMOTE_FRAME_LOADING_HOLD_MS).then(() => {
      if (entry.loadingSince === since) entry.pipeline.setPaused(false);
    });
  };

  const publishState = (entry: Watched) => {
    const state = stateEvent(entry);
    if (state === null) return;
    holdWhileLoading(entry, state.type === "state" && state.state.loading);
    const events = [state];
    void options.publish(entry.demand, events).then(
      () => notePublishedState(entry, events),
      (error: unknown) => report(entry, error),
    );
  };

  const start = (entry: Watched) => {
    const startedFor = entry.runtimeTabId;
    const siblings = [...watched.values()].filter((other) => other.runtimeTabId === startedFor);
    const size = {
      maxWidth: Math.max(...siblings.map((other) => other.demand.maxWidth)),
      maxHeight: Math.max(...siblings.map((other) => other.demand.maxHeight)),
    };
    captureOperation(startedFor, () => options.capture.start(startedFor, size))
      .then(
        () =>
          // A still page may not draw on its own; ask once more if it has not.
          options.scheduler.sleep(REMOTE_FRAME_FIRST_PICTURE_RETRY_MS).then(() => {
            if (!entry.disposed && entry.pictures === 0 && entry.runtimeTabId === startedFor) {
              return options.capture.refresh(entry.runtimeTabId);
            }
          }),
        (error: unknown) => {
          report(entry, error);
          if (entry.disposed) return;
          void options
            .publish(entry.demand, [
              {
                type: "unavailable",
                reason:
                  error instanceof Error && error.message.length > 0
                    ? error.message.slice(0, 400)
                    : "The desktop could not capture this tab.",
              },
            ])
            .catch((publishError: unknown) => report(entry, publishError));
        },
      )
      .catch((error: unknown) => report(entry, error));
  };

  const watch = (demand: PreviewRemoteFrameDemand) => {
    const key = targetKey(demand);
    const entry: Watched = {
      demand,
      key,
      runtimeTabId: options.runtimeTabId(demand),
      sequence: null,
      nextSequence: 0,
      needsKeyframe: true,
      keyframeGeneration: 0,
      latestFrame: null,
      captureGeneration: 0,
      captureLost: false,
      publishedState: null,
      loadingSince: null,
      pictures: 0,
      disposed: false,
      pipeline: createLatestFramePipeline<string>({
        minIntervalMs: REMOTE_FRAME_PUBLISH_INTERVAL_MS,
        scheduler: options.scheduler,
        process: (data) => process(entry, data),
        onError: (error) => {
          report(entry, error);
          if (entry.disposed) return;
          entry.needsKeyframe = true;
          entry.keyframeGeneration += 1;
          options.encoder.reset(entry.key);
          void options
            .publish(entry.demand, [
              { type: "unavailable", reason: "The desktop could not encode the browser frame." },
            ])
            .catch((publishError: unknown) => report(entry, publishError));
        },
      }),
    };
    watched.set(key, entry);
    publishState(entry);
    start(entry);
  };

  const unwatch = (entry: Watched) => {
    entry.disposed = true;
    entry.pipeline.dispose();
    watched.delete(entry.key);
    options.encoder.drop(entry.key);
    const sibling = [...watched.values()].find(
      (other) => other.runtimeTabId === entry.runtimeTabId,
    );
    if (sibling !== undefined) start(sibling);
    else
      captureOperation(entry.runtimeTabId, () => options.capture.stop(entry.runtimeTabId)).catch(
        (error: unknown) => report(entry, error),
      );
  };

  return {
    /** The whole set of watched tabs, as the server sent it. */
    setDemand: (tabs: ReadonlyArray<PreviewRemoteFrameDemand>) => {
      const next = new Map(tabs.map((tab) => [targetKey(tab), tab]));
      for (const entry of watched.values()) {
        if (!next.has(entry.key)) unwatch(entry);
      }
      for (const [key, demand] of next) {
        const entry = watched.get(key);
        if (entry === undefined) {
          watch(demand);
          continue;
        }
        const previous = entry.demand;
        entry.demand = demand;
        const runtimeTabId = options.runtimeTabId(demand);
        const moved = runtimeTabId !== entry.runtimeTabId;
        if (moved) {
          const oldRuntimeTabId = entry.runtimeTabId;
          entry.runtimeTabId = runtimeTabId;
          entry.pictures = 0;
          entry.latestFrame = null;
          const sibling = [...watched.values()].find(
            (other) => other.runtimeTabId === oldRuntimeTabId,
          );
          if (sibling !== undefined) start(sibling);
          else
            captureOperation(oldRuntimeTabId, () => options.capture.stop(oldRuntimeTabId)).catch(
              (error: unknown) => report(entry, error),
            );
        }
        if (
          demand.patches !== previous.patches ||
          demand.keyframeRequest !== previous.keyframeRequest
        ) {
          entry.needsKeyframe = true;
          entry.keyframeGeneration += 1;
        }
        if (
          moved ||
          demand.maxWidth !== previous.maxWidth ||
          demand.maxHeight !== previous.maxHeight
        ) {
          start(entry);
        } else if (entry.needsKeyframe) {
          if (entry.latestFrame !== null) entry.pipeline.push(entry.latestFrame);
          options.capture
            .refresh(entry.runtimeTabId)
            .catch((error: unknown) => report(entry, error));
        }
      }
    },
    /** A screencast picture from the desktop. */
    frameArrived: (frame: {
      readonly tabId: string;
      readonly data?: string;
      readonly unavailable?: string;
    }) => {
      for (const entry of watched.values()) {
        if (entry.runtimeTabId === frame.tabId) {
          if (frame.data === undefined) {
            entry.latestFrame = null;
            entry.captureGeneration += 1;
            entry.captureLost = true;
            entry.pipeline.setPaused(true);
            entry.needsKeyframe = true;
            entry.keyframeGeneration += 1;
            void options
              .publish(entry.demand, [
                { type: "unavailable", reason: frame.unavailable ?? "Capture stopped." },
              ])
              .catch((error: unknown) => report(entry, error));
            continue;
          }
          entry.latestFrame = frame.data;
          entry.pipeline.push(frame.data);
          if (entry.captureLost) {
            entry.captureLost = false;
            entry.pipeline.setPaused(false);
          }
        }
      }
    },
    /** The tab's address, title, held downloads or agent cursor may have changed. */
    stateChanged: (runtimeTabId: string) => {
      for (const entry of watched.values()) {
        if (entry.runtimeTabId === runtimeTabId) publishState(entry);
      }
    },
    dispose: () => {
      for (const entry of watched.values()) unwatch(entry);
    },
  };
}

export type RemoteFrameStreamer = ReturnType<typeof createRemoteFrameStreamer>;
