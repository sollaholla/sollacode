import { describe, expect, it } from "vite-plus/test";

import {
  SHEET_OPEN_DISMISS_GUARD_MS,
  resolveSidebarState,
  shouldIgnoreSheetDismiss,
} from "./sidebarState.ts";

describe("resolveSidebarState", () => {
  it("reads the mobile sheet on a phone and the docked sidebar otherwise", () => {
    expect(resolveSidebarState({ isMobile: true, open: false, openMobile: true })).toBe("expanded");
    expect(resolveSidebarState({ isMobile: false, open: false, openMobile: true })).toBe(
      "collapsed",
    );
  });
});

describe("shouldIgnoreSheetDismiss", () => {
  const openedAtMs = 1_000_000;

  it("swallows the dismissal that arrives with the opening tap", () => {
    expect(shouldIgnoreSheetDismiss({ openedAtMs, nowMs: openedAtMs + 10 })).toBe(true);
  });

  it("lets a real close through once the gesture is over", () => {
    expect(
      shouldIgnoreSheetDismiss({ openedAtMs, nowMs: openedAtMs + SHEET_OPEN_DISMISS_GUARD_MS }),
    ).toBe(false);
    expect(shouldIgnoreSheetDismiss({ openedAtMs, nowMs: openedAtMs + 5_000 })).toBe(false);
  });

  it("never guards a sheet that has not been opened", () => {
    expect(shouldIgnoreSheetDismiss({ openedAtMs: 0, nowMs: openedAtMs })).toBe(false);
  });

  it("refuses to wedge the sheet open if the clock moves backwards", () => {
    expect(shouldIgnoreSheetDismiss({ openedAtMs, nowMs: openedAtMs - 5_000 })).toBe(false);
  });
});
