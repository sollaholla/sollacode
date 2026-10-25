import type {
  PreviewRemoteFrameEvent,
  PreviewRemoteFrameKeyframe,
  PreviewRemoteFramePageState,
  PreviewRemoteFramePatchSet,
} from "@t3tools/contracts";

/**
 * The viewer's side of the remote frame stream (`previewRemoteFrames`):
 * what size of picture to ask for, and how arriving events change the
 * picture on screen. Shared by the web viewer and the native app.
 */

/** Request sizes are rounded up to this many pixels, so small layout changes do not resubscribe. */
export const REMOTE_FRAME_SIZE_STEP = 128;
export const REMOTE_FRAME_MIN_REQUEST = 256;
/** About a 1440p screen; a viewer zoomed past this gets a slightly soft picture. */
export const REMOTE_FRAME_MAX_REQUEST = 2560;
/**
 * A viewer that has had no picture this long after subscribing polls for
 * snapshots instead, until the stream delivers: a desktop that predates the
 * stream, or one that cannot capture the tab, never sends any.
 */
export const REMOTE_FRAME_STREAM_GRACE_MS = 3_000;

const roundUpToStep = (value: number) =>
  Math.min(
    REMOTE_FRAME_MAX_REQUEST,
    Math.max(
      REMOTE_FRAME_MIN_REQUEST,
      Math.ceil(value / REMOTE_FRAME_SIZE_STEP) * REMOTE_FRAME_SIZE_STEP,
    ),
  );

/**
 * The largest picture worth sending this viewer: the box it is drawn in, in
 * device pixels, times how far the viewer has zoomed in (a pinched phone
 * shows a quarter of the page at twice the size, so it needs twice the
 * pixels to stay sharp). The desktop never sends more than the tab has.
 */
export function remoteFrameRequestSize(input: {
  readonly boxWidth: number;
  readonly boxHeight: number;
  readonly devicePixelRatio: number;
  readonly zoom?: number;
}): { readonly maxWidth: number; readonly maxHeight: number } {
  const ratio = Math.min(3, Math.max(1, input.devicePixelRatio || 1));
  const zoom = Math.min(2, Math.max(1, input.zoom ?? 1));
  return {
    maxWidth: roundUpToStep(Math.max(1, input.boxWidth) * ratio * zoom),
    maxHeight: roundUpToStep(Math.max(1, input.boxHeight) * ratio * zoom),
  };
}

/** The picture a viewer holds: which one it is and its size in pixels. */
export interface HeldRemoteFrame {
  readonly sequence: number;
  readonly width: number;
  readonly height: number;
}

export type RemoteFrameDraw =
  | { readonly kind: "keyframe"; readonly event: PreviewRemoteFrameKeyframe }
  | { readonly kind: "patches"; readonly event: PreviewRemoteFramePatchSet };

export interface RemoteFrameBatch {
  /** The picture held once every draw below is done. */
  readonly held: HeldRemoteFrame | null;
  /** In order. A keyframe replaces the picture; patches are drawn over it. */
  readonly draws: ReadonlyArray<RemoteFrameDraw>;
  /** The newest page state in the batch, if any. */
  readonly state: PreviewRemoteFramePageState | null;
  /** Set when the server says no desktop can stream the tab right now. */
  readonly unavailable: string | null;
  /**
   * A patch did not follow the held picture (a viewer that missed an event):
   * the viewer resubscribes for a fresh keyframe. Nothing after it is drawn.
   */
  readonly resync: boolean;
}

/**
 * Folds one arrival of stream events into draw steps. Only the last keyframe
 * of a batch and the patches after it are drawn: anything earlier would be
 * covered at once. A viewer that cannot draw patches passes `patches: false`
 * and patch events are ignored (the server does not send them to it).
 */
export function planRemoteFrameEvents(
  held: HeldRemoteFrame | null,
  events: ReadonlyArray<PreviewRemoteFrameEvent>,
  options: { readonly patches: boolean } = { patches: true },
): RemoteFrameBatch {
  let state: PreviewRemoteFramePageState | null = null;
  let unavailable: string | null = null;
  let current = held;
  let draws: Array<RemoteFrameDraw> = [];
  for (const event of events) {
    switch (event.type) {
      case "state":
        state = event.state;
        break;
      case "unavailable":
        unavailable = event.reason;
        break;
      case "keyframe":
        draws = [{ kind: "keyframe", event }];
        current = { sequence: event.sequence, width: event.width, height: event.height };
        unavailable = null;
        break;
      case "patch": {
        if (!options.patches) break;
        if (
          current === null ||
          current.sequence !== event.after ||
          current.width !== event.width ||
          current.height !== event.height
        ) {
          return { held: current, draws, state, unavailable, resync: true };
        }
        draws.push({ kind: "patches", event });
        current = { ...current, sequence: event.sequence };
        break;
      }
    }
  }
  return { held: current, draws, state, unavailable, resync: false };
}

/**
 * Whether a viewer should poll for snapshots right now. It streams when the
 * server can, and falls back to polling while the stream has nothing to show:
 * the server said no desktop can stream the tab, or no picture arrived within
 * the grace period. A picture arriving ends the fallback.
 */
export function remoteFrameShouldPoll(input: {
  readonly streamSupported: boolean;
  readonly subscribedAt: number | null;
  readonly lastPictureAt: number | null;
  readonly unavailableAt: number | null;
  readonly now: number;
}): boolean {
  if (!input.streamSupported || input.subscribedAt === null) return true;
  if (input.unavailableAt !== null) {
    return input.lastPictureAt === null || input.lastPictureAt <= input.unavailableAt;
  }
  if (input.lastPictureAt !== null) return false;
  return input.now - input.subscribedAt >= REMOTE_FRAME_STREAM_GRACE_MS;
}
