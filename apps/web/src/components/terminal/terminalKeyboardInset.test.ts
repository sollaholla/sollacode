import { describe, expect, it } from "vite-plus/test";

import {
  resolveTerminalKeyboardInset,
  TERMINAL_KEYBOARD_MINIMUM_INSET,
} from "./terminalKeyboardInset.ts";

// A phone pane whose bottom sits at 800; the keyboard has taken 300 of it.
const KEYBOARD_OPEN = {
  paneBottom: 800,
  visualViewportHeight: 500,
  visualViewportOffsetTop: 0,
  terminalFocused: true,
  isPortrait: true,
  isTouch: true,
} as const;

describe("resolveTerminalKeyboardInset", () => {
  it("lifts the pane by exactly what the keyboard covers", () => {
    expect(resolveTerminalKeyboardInset(KEYBOARD_OPEN)).toBe(300);
  });

  it("stays flat when the terminal does not own the keyboard", () => {
    // The composer raised it; the terminal must not jump in sympathy.
    expect(resolveTerminalKeyboardInset({ ...KEYBOARD_OPEN, terminalFocused: false })).toBe(0);
  });

  it("leaves landscape alone", () => {
    // The keyboard already owns most of the height there; reserving it again
    // would leave the terminal a couple of rows tall.
    expect(resolveTerminalKeyboardInset({ ...KEYBOARD_OPEN, isPortrait: false })).toBe(0);
  });

  it("does nothing on a pointer device", () => {
    expect(resolveTerminalKeyboardInset({ ...KEYBOARD_OPEN, isTouch: false })).toBe(0);
  });

  it("ignores browser chrome collapsing, which is not a keyboard", () => {
    // A URL bar's worth of movement would otherwise make the pane twitch on
    // every scroll.
    expect(
      resolveTerminalKeyboardInset({
        ...KEYBOARD_OPEN,
        visualViewportHeight: 800 - (TERMINAL_KEYBOARD_MINIMUM_INSET - 1),
      }),
    ).toBe(0);
  });

  it("accounts for a viewport that is also offset from the top", () => {
    // iOS scrolls the visual viewport as well as shrinking it.
    expect(
      resolveTerminalKeyboardInset({
        ...KEYBOARD_OPEN,
        visualViewportHeight: 400,
        visualViewportOffsetTop: 100,
      }),
    ).toBe(300);
  });
});
