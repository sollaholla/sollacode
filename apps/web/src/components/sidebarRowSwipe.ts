/**
 * Swipe-to-act geometry for sidebar thread rows.
 *
 * The row actions used to be buttons revealed on hover. Touch has no hover, so
 * on a phone they were either invisible or a tiny target sitting on top of the
 * row's own tap area. Sliding the row is the gesture people already know from
 * mail clients, and it gives the action a full-height target instead of a
 * 12-pixel icon.
 *
 * Kept separate from the component so the thresholds and the direction mapping
 * are testable without a DOM — the harness here has none.
 */

/**
 * Movement before the gesture is claimed as horizontal.
 *
 * The rows live in a vertically scrolling list, so a swipe handler that grabs
 * the pointer immediately would fight every scroll that starts with a few
 * pixels of horizontal drift. Below this, the browser keeps the gesture.
 */
export const SWIPE_SLOP_PX = 10;

/** Displacement at which releasing commits the action. */
export const SWIPE_ACTIVATE_PX = 72;

/** Hard ceiling on how far the row travels, however far the finger goes. */
export const SWIPE_MAX_PX = 112;

export type SidebarSwipeAction = "settle" | "unsettle" | "snooze" | "unsnooze";

export type SidebarSwipeDirection = "left" | "right";

export interface SidebarSwipeCapabilities {
  /** What the row's trailing control would have done. */
  readonly variantAction: "settle" | "unsettle" | "unsnooze";
  /** Server understands thread.settle/unsettle. */
  readonly settlementSupported: boolean;
  /** Server understands thread.snooze/unsnooze. */
  readonly snoozeSupported: boolean;
  /** Snooze would be accepted right now (not blocked-on-you or queued). */
  readonly canSnoozeNow: boolean;
}

/**
 * The action a swipe would commit, or null when that direction does nothing.
 *
 * Right is the settle axis and left the snooze axis, in both directions of
 * travel: a settled row swiped right un-settles, a snoozed row swiped left
 * wakes. Keeping an axis to one side means the gesture for undoing something
 * is the same one that did it, rather than having to remember which side a row
 * currently lives on.
 *
 * Returning null rather than a disabled action is deliberate — the caller uses
 * it to leave the row inert, so an unsupported server never shows an
 * affordance that would fail on release.
 */
export function swipeActionForDirection(
  direction: SidebarSwipeDirection,
  capabilities: SidebarSwipeCapabilities,
): SidebarSwipeAction | null {
  if (direction === "right") {
    if (!capabilities.settlementSupported) return null;
    // A snoozed row is not settled; sliding it toward "done" should settle it.
    return capabilities.variantAction === "unsettle" ? "unsettle" : "settle";
  }
  if (!capabilities.snoozeSupported) return null;
  if (capabilities.variantAction === "unsnooze") return "unsnooze";
  return capabilities.canSnoozeNow ? "snooze" : null;
}

/** The direction a displacement points, or null when it has not left centre. */
export function swipeDirection(dx: number): SidebarSwipeDirection | null {
  if (!Number.isFinite(dx) || dx === 0) return null;
  return dx > 0 ? "right" : "left";
}

/**
 * Whether a movement should be taken as a horizontal swipe.
 *
 * Requires both clearing the slop and being more horizontal than vertical, so
 * a diagonal that is mostly a scroll stays a scroll.
 */
export function isHorizontalSwipe(dx: number, dy: number): boolean {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
  return Math.abs(dx) > SWIPE_SLOP_PX && Math.abs(dx) > Math.abs(dy);
}

/**
 * Where to draw the row for a given finger displacement.
 *
 * Past the activation point the row keeps moving but at a third of the rate,
 * up to a hard stop. That resistance is the feedback that the threshold has
 * been passed — the row visibly stops keeping up with the finger — and the
 * ceiling stops a long drag from sliding the row out of its own list.
 *
 * A direction with no available action does not move at all, so "nothing
 * happens here" is legible before the finger is lifted.
 */
export function resolveSwipeOffset(dx: number, hasAction: boolean): number {
  if (!Number.isFinite(dx) || !hasAction) return 0;
  const magnitude = Math.abs(dx);
  const sign = dx < 0 ? -1 : 1;
  if (magnitude <= SWIPE_ACTIVATE_PX) return dx;
  const past = magnitude - SWIPE_ACTIVATE_PX;
  return sign * Math.min(SWIPE_MAX_PX, SWIPE_ACTIVATE_PX + past / 3);
}

/** Whether releasing at this displacement commits rather than springs back. */
export function shouldCommitSwipe(dx: number, hasAction: boolean): boolean {
  if (!Number.isFinite(dx) || !hasAction) return false;
  return Math.abs(dx) >= SWIPE_ACTIVATE_PX;
}

/**
 * How far through the gesture the row is, 0…1.
 *
 * Drives the action panel's fade so it arrives with the row rather than
 * appearing at full strength the moment the finger moves.
 */
export function swipeProgress(dx: number, hasAction: boolean): number {
  if (!Number.isFinite(dx) || !hasAction) return 0;
  return Math.min(1, Math.abs(dx) / SWIPE_ACTIVATE_PX);
}

/** Label and intent for the panel revealed behind the row. */
export function describeSwipeAction(action: SidebarSwipeAction): {
  readonly label: string;
  readonly tone: "settle" | "snooze";
} {
  switch (action) {
    case "settle":
      return { label: "Settle", tone: "settle" };
    case "unsettle":
      return { label: "Un-settle", tone: "settle" };
    case "snooze":
      return { label: "Snooze", tone: "snooze" };
    case "unsnooze":
      return { label: "Wake", tone: "snooze" };
  }
}
