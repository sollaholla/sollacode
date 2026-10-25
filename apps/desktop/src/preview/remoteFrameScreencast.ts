/**
 * Paces Chromium's screencast for a tab a remote viewer is watching.
 *
 * `Page.startScreencast` sends a JPEG whenever the compositor draws, and stops
 * sending once a few frames are unacknowledged. Acknowledging at most one
 * frame per `minIntervalMs` caps how often Chromium encodes a busy page. The
 * catch: a frame drawn while the cap holds acknowledgements back is never
 * sent, and if it was the page's last change the viewer would sit on a stale
 * picture. So after a held-back acknowledgement, a page that then goes quiet
 * for `settleMs` is asked to draw once more (`refresh`), which captures
 * whatever it settled on. A frame identical to the last one costs the
 * encoder a comparison and the viewer nothing.
 */
export interface ScreencastPacerOptions {
  readonly minIntervalMs: number;
  readonly settleMs: number;
  readonly now: () => number;
  /** Runs `run` after `ms`; returns a cancel function. */
  readonly setTimer: (run: () => void, ms: number) => () => void;
  readonly ack: (sessionId: number) => void;
  readonly refresh: () => void;
}

export interface ScreencastPacer {
  /** Call for every `Page.screencastFrame`, after handing the frame on. */
  readonly onFrame: (sessionId: number) => void;
  readonly dispose: () => void;
}

export function createScreencastPacer(options: ScreencastPacerOptions): ScreencastPacer {
  const pending: Array<number> = [];
  let lastAckAt = Number.NEGATIVE_INFINITY;
  let heldBack = false;
  let cancelPump: (() => void) | null = null;
  let cancelSettle: (() => void) | null = null;
  let disposed = false;

  const settle = () => {
    cancelSettle?.();
    cancelSettle = options.setTimer(() => {
      cancelSettle = null;
      if (!disposed) options.refresh();
    }, options.settleMs);
  };

  const pump = () => {
    cancelPump = null;
    if (disposed) return;
    const now = options.now();
    const due = lastAckAt + options.minIntervalMs;
    if (pending.length > 0 && now >= due) {
      options.ack(pending.shift()!);
      lastAckAt = now;
    }
    if (pending.length > 0) {
      heldBack = true;
      cancelPump = options.setTimer(pump, Math.max(0, lastAckAt + options.minIntervalMs - now));
      return;
    }
    if (heldBack) {
      heldBack = false;
      settle();
    }
  };

  return {
    onFrame: (sessionId) => {
      if (disposed) return;
      cancelSettle?.();
      cancelSettle = null;
      pending.push(sessionId);
      if (cancelPump === null) pump();
    },
    dispose: () => {
      disposed = true;
      cancelPump?.();
      cancelSettle?.();
      pending.length = 0;
    },
  };
}

/** How the desktop screencasts a watched tab: JPEG at this quality, at most this often. */
export const REMOTE_FRAME_SCREENCAST_QUALITY = 75;
export const REMOTE_FRAME_MIN_INTERVAL_MS = 50;
export const REMOTE_FRAME_SETTLE_MS = 120;
