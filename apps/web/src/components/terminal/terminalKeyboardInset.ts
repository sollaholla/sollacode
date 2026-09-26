/**
 * Keeping the prompt above the phone keyboard.
 *
 * The terminal drawer is a fixed-height pane. When the software keyboard opens
 * it covers the bottom of that pane - which is exactly where the prompt, the
 * line you are typing, and the mobile key bar all live, so the one part of the
 * terminal you are interacting with is the part you cannot see. Insetting the
 * pane by the covered height lifts the whole column clear.
 *
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
  readonly paneTop?: number;
  readonly visualViewportHeight: number;
  readonly visualViewportOffsetTop: number;
  /** The terminal itself holds focus, so this keyboard is its own. */
  readonly terminalFocused: boolean;
  readonly isPortrait: boolean;
  readonly isTouch: boolean;
}): number {
  if (!input.terminalFocused || !input.isTouch) {
    return 0;
  }
  const inset = visualViewportBottomInset({
    layoutViewportBottom: input.paneBottom,
    visualViewportHeight: input.visualViewportHeight,
    visualViewportOffsetTop: input.visualViewportOffsetTop,
  });
  // Leave room for the key bar and a usable grid even in landscape.
  const maximumInset = Math.max(0, input.paneBottom - (input.paneTop ?? 0) - 120);
  return inset >= TERMINAL_KEYBOARD_MINIMUM_INSET ? Math.min(inset, maximumInset) : 0;
}
