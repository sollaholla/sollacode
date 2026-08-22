/**
 * Keeps the screen awake for as long as the orchestrator has the microphone.
 *
 * The reported failure was locking the phone mid-conversation: the microphone
 * indicator stays lit, the model stops answering, and coming back shows the chat
 * ended. That is not a bug in the session — a locked iPhone suspends the page,
 * and with it the WebRTC connection and every timer. There is no web API that
 * keeps a browser voice session running in the background; a native audio
 * session is the only thing that can, which is a different application entirely.
 *
 * What *is* available is stopping the lock from happening. A screen wake lock
 * holds the display on while a session is live, so an unattended phone does not
 * end the conversation by itself. It is released the moment voice stops, so it
 * never outlives the reason for holding it.
 *
 * The lock is dropped by the browser whenever the page is hidden, and is not
 * restored on return — so re-acquiring on `visibilitychange` is required, not an
 * optimisation.
 */

/** The slice of the Wake Lock API used here; keeps tests free of a browser. */
export interface WakeLockSentinelLike {
  release(): Promise<void>;
  readonly released?: boolean;
}

export interface WakeLockRequester {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}

export interface ScreenWakeLock {
  /** Re-acquire if not currently held. Safe to call repeatedly. */
  readonly acquire: () => Promise<void>;
  readonly release: () => void;
  readonly isHeld: () => boolean;
}

/**
 * Returns the platform's wake-lock requester, or null where there is none.
 *
 * Absent on older iOS and in any non-secure context, which is why every caller
 * has to treat the lock as best-effort.
 */
export function findWakeLockRequester(): WakeLockRequester | null {
  if (typeof navigator === "undefined") return null;
  const candidate = (navigator as Navigator & { wakeLock?: WakeLockRequester }).wakeLock;
  return candidate !== undefined && typeof candidate.request === "function" ? candidate : null;
}

export function createScreenWakeLock(requester: WakeLockRequester | null): ScreenWakeLock {
  let sentinel: WakeLockSentinelLike | null = null;
  // Guards the gap between asking and being granted: `acquire` is called again
  // on every visibility change, and two in-flight requests would leak the first
  // sentinel, leaving a lock nothing can release.
  let pending = false;

  const acquire = async () => {
    if (requester === null || sentinel !== null || pending) return;
    pending = true;
    try {
      sentinel = await requester.request("screen");
    } catch {
      // Denied — the tab is not visible, or the platform refused. Not worth
      // surfacing: the conversation still works, the screen may just sleep.
      sentinel = null;
    } finally {
      pending = false;
    }
  };

  return {
    acquire,
    release: () => {
      const held = sentinel;
      sentinel = null;
      void held?.release().catch(() => undefined);
    },
    isHeld: () => sentinel !== null,
  };
}

/**
 * Why a live session ended, as far as the page can tell.
 *
 * A session that stops while the page is hidden was almost certainly killed by
 * the phone locking or the app being switched away, not by anything the user
 * did — and saying so is the difference between a confusing empty screen and an
 * explanation.
 */
export function describeSessionInterruption(input: {
  readonly documentHidden: boolean;
  readonly wasLive: boolean;
}): string | null {
  if (!input.wasLive || !input.documentHidden) return null;
  return "Voice stopped because the phone locked or the app went to the background. Tap to start again.";
}
