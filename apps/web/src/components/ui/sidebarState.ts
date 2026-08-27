export type ResponsiveSidebarState = "expanded" | "collapsed";

export function resolveSidebarState(input: {
  isMobile: boolean;
  open: boolean;
  openMobile: boolean;
}): ResponsiveSidebarState {
  return (input.isMobile ? input.openMobile : input.open) ? "expanded" : "collapsed";
}

/**
 * How long after opening the mobile sheet a dismissal is treated as the
 * opening gesture cancelling itself.
 *
 * No one opens a sheet and deliberately closes it inside a quarter second, so
 * suppressing that window costs the user nothing.
 */
export const SHEET_OPEN_DISMISS_GUARD_MS = 250;

/**
 * Whether a request to close the mobile sidebar is really the tap that opened
 * it, arriving late.
 *
 * The trigger button is not a `SheetTrigger` — it lives elsewhere in the tree
 * and flips the state directly — so the Base UI dialog holds no reference to
 * it and counts a press on it as an *outside* press, which dismisses. On a
 * touch screen the tap that opens the sheet can still produce a trailing
 * compatibility mouse event after the dialog has mounted, and the sheet closes
 * itself the instant it opens. Reported as: the sidebar appears to animate,
 * then does not open until you tap a second time.
 */
export function shouldIgnoreSheetDismiss(input: {
  /** 0 when the sheet has never been opened. */
  readonly openedAtMs: number;
  readonly nowMs: number;
}): boolean {
  if (input.openedAtMs === 0) return false;
  const elapsed = input.nowMs - input.openedAtMs;
  // A clock that moved backwards must not wedge the sheet open.
  if (elapsed < 0) return false;
  return elapsed < SHEET_OPEN_DISMISS_GUARD_MS;
}
