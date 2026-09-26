/**
 * Terminal-mode layout rules that belong to the device rather than to the user.
 */

/**
 * A phone, in either orientation.
 *
 * Deliberately not `max-md`: a phone held sideways is ~850px wide and falls out
 * of every width-only breakpoint mid-rotation, which is the one moment the
 * layout must not change under the person's hands. Pairing a coarse pointer
 * with "short in one axis" catches both orientations and leaves tablets and
 * desktops alone. The comma is the OR -- `or` inside parentheses is Media
 * Queries 4 and still not safe on every phone browser this app is opened in.
 */
export const PHONE_TERMINAL_LAYOUT_MEDIA_QUERY =
  "(pointer: coarse) and (max-width: 639px), (pointer: coarse) and (max-height: 639px)";

/**
 * Whether terminal mode should render its single-pane, tabbed full-screen
 * layout instead of the split workspace.
 *
 * On a phone the tabbed layout is the only usable one: splitting ~390px of
 * width between two panes leaves neither wide enough for a command line. The
 * stored flag is a desktop preference about hiding the *other* panes, and the
 * desktop rule behind it -- fullscreen is a multi-pane affordance, so a lone
 * pane drops back to split -- is what kept pulling a phone out of full screen
 * every time it was down to one terminal. A phone therefore ignores the flag
 * and stays full-screen; the desktop keeps deciding for itself.
 */
export function resolveTerminalModeFullscreen(input: {
  readonly phoneLayout: boolean;
  readonly storedFullscreen: boolean;
}): boolean {
  return input.phoneLayout || input.storedFullscreen;
}
