/**
 * What one finger on the mirrored frame means.
 *
 * A phone looking at a guest browser on another machine has no mouse: a tap
 * has to become a click, holding a moment has to become a right-click, and
 * dragging has to scroll the page under the finger. The decisions live here,
 * away from React and timers, so each threshold is testable as a plain
 * function of points and time.
 */

/** Movement beyond this is a drag, not an unsteady tap. */
export const TOUCH_SLOP_PX = 10;
/** A stationary press this long is a right-click. */
export const TOUCH_LONG_PRESS_MS = 500;
/** Scroll increments are batched to this cadence so a drag is not an RPC per pixel. */
export const TOUCH_SCROLL_FLUSH_MS = 90;

export interface TouchGestureState {
  /** Where the finger landed, in client coordinates. */
  readonly startClientX: number;
  readonly startClientY: number;
  /** Where the finger last was, for scroll deltas. */
  readonly lastClientX: number;
  readonly lastClientY: number;
  readonly startedAt: number;
  /**
   * pending: could still be a tap or a long-press.
   * scrolling: moved past slop; every further move scrolls.
   * consumed: already acted (long-press fired, or a second finger arrived).
   */
  readonly mode: "pending" | "scrolling" | "consumed";
}

export function beginTouchGesture(point: {
  readonly clientX: number;
  readonly clientY: number;
  readonly now: number;
}): TouchGestureState {
  return {
    startClientX: point.clientX,
    startClientY: point.clientY,
    lastClientX: point.clientX,
    lastClientY: point.clientY,
    startedAt: point.now,
    mode: "pending",
  };
}

export function exceedsTouchSlop(
  gesture: TouchGestureState,
  point: { readonly clientX: number; readonly clientY: number },
): boolean {
  const dx = point.clientX - gesture.startClientX;
  const dy = point.clientY - gesture.startClientY;
  return dx * dx + dy * dy > TOUCH_SLOP_PX * TOUCH_SLOP_PX;
}

/**
 * Advances the gesture for one finger movement.
 *
 * The scroll delta is `last - current`: the page's content follows the
 * finger, exactly like native touch scrolling — dragging upward reads on as
 * a positive deltaY, which scrolls the page down so the content underneath
 * moves up with the finger.
 */
export function moveTouchGesture(
  gesture: TouchGestureState,
  point: { readonly clientX: number; readonly clientY: number },
): {
  readonly gesture: TouchGestureState;
  readonly scrollDelta: { readonly deltaX: number; readonly deltaY: number } | null;
} {
  if (gesture.mode === "consumed") return { gesture, scrollDelta: null };
  if (gesture.mode === "pending" && !exceedsTouchSlop(gesture, point)) {
    return { gesture, scrollDelta: null };
  }
  const scrollDelta = {
    deltaX: gesture.lastClientX - point.clientX,
    deltaY: gesture.lastClientY - point.clientY,
  };
  return {
    gesture: {
      ...gesture,
      mode: "scrolling",
      lastClientX: point.clientX,
      lastClientY: point.clientY,
    },
    scrollDelta,
  };
}

/**
 * Whether the press has been held long and still enough to be a right-click.
 * Only a pending gesture can fire: movement demoted it to scrolling, and a
 * fired one is consumed so lifting the finger afterwards is not also a tap.
 */
export function isTouchLongPressDue(gesture: TouchGestureState, now: number): boolean {
  return gesture.mode === "pending" && now - gesture.startedAt >= TOUCH_LONG_PRESS_MS;
}

/**
 * What lifting the finger means: a tap (left click at the start point) only
 * when nothing else claimed the gesture first.
 */
export function finishTouchGesture(gesture: TouchGestureState): "tap" | "none" {
  return gesture.mode === "pending" ? "tap" : "none";
}
