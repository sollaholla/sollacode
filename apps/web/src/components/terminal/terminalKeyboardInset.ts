/**
 * Keeping the prompt above the phone keyboard.
 *
 * The terminal drawer is a fixed-height pane. When the software keyboard opens
 * it covers the bottom of that pane - which is exactly where the prompt, the
 * line you are typing, and the mobile key bar all live, so the one part of the
 * terminal you are interacting with is the part you cannot see. Insetting the
 * pane by the covered height lifts the whole column clear.
 *
 * Portrait only, deliberately. In landscape the keyboard already takes most of
 * a phone's height, and reserving that much again would leave the terminal a
 * couple of rows tall - worse than the overlap it was meant to fix.
 */

import { visualViewportBottomInset } from "../chat/mobileComposerViewport.ts";

/**
 * Below this, the gap is browser chrome (a URL bar collapsing, a toolbar)
 * rather than a keyboard, and reacting to it would make the pane twitch during
 * ordinary scrolling.
 */
export const TERMINAL_KEYBOARD_MINIMUM_INSET = 80;

export function resolveTerminalKeyboardInset(input: {
  /** Bottom edge of the terminal pane in layout-viewport coordinates. */
  readonly paneBottom: number;
  readonly visualViewportHeight: number;
  readonly visualViewportOffsetTop: number;
  /** The terminal itself holds focus, so this keyboard is its own. */
  readonly terminalFocused: boolean;
  readonly isPortrait: boolean;
  readonly isTouch: boolean;
}): number {
  if (!input.terminalFocused || !input.isPortrait || !input.isTouch) {
    return 0;
  }
  const inset = visualViewportBottomInset({
    layoutViewportBottom: input.paneBottom,
    visualViewportHeight: input.visualViewportHeight,
    visualViewportOffsetTop: input.visualViewportOffsetTop,
  });
  return inset >= TERMINAL_KEYBOARD_MINIMUM_INSET ? inset : 0;
}
