import { describe, expect, it } from "vite-plus/test";

import {
  PHONE_TERMINAL_LAYOUT_MEDIA_QUERY,
  resolveTerminalModeFullscreen,
} from "./terminalModeLayout";

describe("terminal mode layout", () => {
  /**
   * The reported bug, stated as a rule: a phone in terminal mode is usually
   * down to exactly one terminal, which is precisely when the desktop's
   * "fullscreen is a multi-pane affordance" cleanup used to switch the layout
   * back to split underneath the person.
   */
  it("keeps a phone full-screen with one pane and the stored flag off", () => {
    expect(resolveTerminalModeFullscreen({ phoneLayout: true, storedFullscreen: false })).toBe(
      true,
    );
  });

  it("leaves the desktop deciding for itself", () => {
    expect(resolveTerminalModeFullscreen({ phoneLayout: false, storedFullscreen: false })).toBe(
      false,
    );
    expect(resolveTerminalModeFullscreen({ phoneLayout: false, storedFullscreen: true })).toBe(
      true,
    );
  });

  /**
   * The query is a comma-separated list, so each alternative stands alone: one
   * that forgot `(pointer: coarse)` would pin every short *desktop* window to
   * the phone layout, and one that tested only width would let a phone fall
   * out of it the moment it was turned sideways.
   */
  it("requires a touch pointer on both the width and the height alternative", () => {
    const alternatives = PHONE_TERMINAL_LAYOUT_MEDIA_QUERY.split(",").map((part) => part.trim());
    expect(alternatives.length).toBeGreaterThan(1);
    for (const alternative of alternatives) {
      expect(alternative, `${alternative} would match a mouse`).toContain("(pointer: coarse)");
    }
    expect(alternatives.some((alternative) => alternative.includes("max-width"))).toBe(true);
    expect(alternatives.some((alternative) => alternative.includes("max-height"))).toBe(true);
  });
});
