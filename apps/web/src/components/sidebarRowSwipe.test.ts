import { describe, expect, it } from "vite-plus/test";

import {
  describeSwipeAction,
  isHorizontalSwipe,
  resolveSwipeOffset,
  shouldCommitSwipe,
  SWIPE_ACTIVATE_PX,
  SWIPE_MAX_PX,
  SWIPE_SLOP_PX,
  swipeActionForDirection,
  swipeDirection,
  swipeProgress,
  type SidebarSwipeCapabilities,
} from "./sidebarRowSwipe";

const open: SidebarSwipeCapabilities = {
  variantAction: "settle",
  settlementSupported: true,
  snoozeSupported: true,
  canSnoozeNow: true,
};

describe("swipeActionForDirection", () => {
  it("puts settling on the right and snoozing on the left", () => {
    expect(swipeActionForDirection("right", open)).toBe("settle");
    expect(swipeActionForDirection("left", open)).toBe("snooze");
  });

  it("keeps each axis on its own side when undoing", () => {
    // The gesture that settled a row is the one that un-settles it, so nobody
    // has to remember which shelf a row is currently on.
    expect(swipeActionForDirection("right", { ...open, variantAction: "unsettle" })).toBe(
      "unsettle",
    );
    expect(swipeActionForDirection("left", { ...open, variantAction: "unsnooze" })).toBe(
      "unsnooze",
    );
  });

  it("still settles a snoozed row swiped right", () => {
    // Snoozed is not settled; the settle axis stays available.
    expect(swipeActionForDirection("right", { ...open, variantAction: "unsnooze" })).toBe("settle");
  });

  it("offers nothing the server cannot do", () => {
    expect(swipeActionForDirection("right", { ...open, settlementSupported: false })).toBeNull();
    expect(swipeActionForDirection("left", { ...open, snoozeSupported: false })).toBeNull();
  });

  it("does not offer snooze on work that would be rejected", () => {
    // Blocked-on-you and queued turns fail server-side; the row should not
    // pretend otherwise mid-gesture.
    expect(swipeActionForDirection("left", { ...open, canSnoozeNow: false })).toBeNull();
  });

  it("still wakes a snoozed row even when a fresh snooze would be refused", () => {
    expect(
      swipeActionForDirection("left", {
        ...open,
        variantAction: "unsnooze",
        canSnoozeNow: false,
      }),
    ).toBe("unsnooze");
  });
});

describe("swipeDirection", () => {
  it("reads the sign, and treats dead centre as no direction", () => {
    expect(swipeDirection(5)).toBe("right");
    expect(swipeDirection(-5)).toBe("left");
    expect(swipeDirection(0)).toBeNull();
    expect(swipeDirection(Number.NaN)).toBeNull();
  });
});

describe("isHorizontalSwipe", () => {
  it("ignores movement inside the slop", () => {
    // Otherwise every scroll that starts with a pixel of drift steals the row.
    expect(isHorizontalSwipe(SWIPE_SLOP_PX, 0)).toBe(false);
    expect(isHorizontalSwipe(SWIPE_SLOP_PX + 1, 0)).toBe(true);
  });

  it("leaves a mostly-vertical drag to the scroller", () => {
    expect(isHorizontalSwipe(20, 30)).toBe(false);
    expect(isHorizontalSwipe(30, 20)).toBe(true);
  });

  it("works in both directions", () => {
    expect(isHorizontalSwipe(-30, 5)).toBe(true);
  });
});

describe("resolveSwipeOffset", () => {
  it("tracks the finger up to the activation point", () => {
    expect(resolveSwipeOffset(40, true)).toBe(40);
    expect(resolveSwipeOffset(-40, true)).toBe(-40);
    expect(resolveSwipeOffset(SWIPE_ACTIVATE_PX, true)).toBe(SWIPE_ACTIVATE_PX);
  });

  it("resists past the threshold instead of keeping up", () => {
    // The row falling behind the finger is the signal that the threshold has
    // been crossed.
    const past = resolveSwipeOffset(SWIPE_ACTIVATE_PX + 30, true);
    expect(past).toBeGreaterThan(SWIPE_ACTIVATE_PX);
    expect(past).toBeLessThan(SWIPE_ACTIVATE_PX + 30);
  });

  it("never travels past the hard stop", () => {
    expect(resolveSwipeOffset(10_000, true)).toBe(SWIPE_MAX_PX);
    expect(resolveSwipeOffset(-10_000, true)).toBe(-SWIPE_MAX_PX);
  });

  it("does not move at all toward an unavailable action", () => {
    expect(resolveSwipeOffset(90, false)).toBe(0);
  });

  it("survives a non-finite delta", () => {
    expect(resolveSwipeOffset(Number.NaN, true)).toBe(0);
  });
});

describe("shouldCommitSwipe", () => {
  it("commits only at or past the activation point", () => {
    expect(shouldCommitSwipe(SWIPE_ACTIVATE_PX - 1, true)).toBe(false);
    expect(shouldCommitSwipe(SWIPE_ACTIVATE_PX, true)).toBe(true);
    expect(shouldCommitSwipe(-SWIPE_ACTIVATE_PX, true)).toBe(true);
  });

  it("never commits without an action", () => {
    // The row did not move, so releasing must not fire anything.
    expect(shouldCommitSwipe(500, false)).toBe(false);
  });
});

describe("swipeProgress", () => {
  it("ramps to 1 at the activation point and stays there", () => {
    expect(swipeProgress(0, true)).toBe(0);
    expect(swipeProgress(SWIPE_ACTIVATE_PX / 2, true)).toBeCloseTo(0.5, 10);
    expect(swipeProgress(SWIPE_ACTIVATE_PX * 4, true)).toBe(1);
  });

  it("is 0 with no action, so nothing fades in", () => {
    expect(swipeProgress(SWIPE_ACTIVATE_PX, false)).toBe(0);
  });
});

describe("describeSwipeAction", () => {
  it("labels every action and keeps undo on its axis's tone", () => {
    expect(describeSwipeAction("settle")).toEqual({ label: "Settle", tone: "settle" });
    expect(describeSwipeAction("unsettle")).toEqual({ label: "Un-settle", tone: "settle" });
    expect(describeSwipeAction("snooze")).toEqual({ label: "Snooze", tone: "snooze" });
    expect(describeSwipeAction("unsnooze")).toEqual({ label: "Wake", tone: "snooze" });
  });
});
