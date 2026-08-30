import { describe, expect, it } from "vite-plus/test";

import {
  TOUCH_LONG_PRESS_MS,
  TOUCH_SLOP_PX,
  beginTouchGesture,
  finishTouchGesture,
  isTouchLongPressDue,
  moveTouchGesture,
} from "./remoteTouchGestures";

const start = () => beginTouchGesture({ clientX: 100, clientY: 200, now: 1_000 });

describe("remoteTouchGestures", () => {
  it("a still, quick press ends as a tap", () => {
    const gesture = start();
    expect(finishTouchGesture(gesture)).toBe("tap");
  });

  it("jitter inside the slop stays a tap and scrolls nothing", () => {
    const moved = moveTouchGesture(start(), { clientX: 104, clientY: 196 });
    expect(moved.scrollDelta).toBeNull();
    expect(finishTouchGesture(moved.gesture)).toBe("tap");
  });

  it("moving past the slop becomes scrolling and never a tap", () => {
    const moved = moveTouchGesture(start(), {
      clientX: 100,
      clientY: 200 + TOUCH_SLOP_PX + 5,
    });
    expect(moved.gesture.mode).toBe("scrolling");
    expect(finishTouchGesture(moved.gesture)).toBe("none");
  });

  it("content follows the finger: dragging up scrolls the page down", () => {
    const moved = moveTouchGesture(start(), { clientX: 100, clientY: 160 });
    expect(moved.scrollDelta).toEqual({ deltaX: 0, deltaY: 40 });
  });

  it("scroll deltas chain from the previous position, not the start", () => {
    const first = moveTouchGesture(start(), { clientX: 100, clientY: 160 });
    const second = moveTouchGesture(first.gesture, { clientX: 90, clientY: 150 });
    expect(second.scrollDelta).toEqual({ deltaX: 10, deltaY: 10 });
  });

  it("a long, still press is due as a right-click; a moved one is not", () => {
    const held = start();
    expect(isTouchLongPressDue(held, 1_000 + TOUCH_LONG_PRESS_MS)).toBe(true);
    expect(isTouchLongPressDue(held, 1_000 + TOUCH_LONG_PRESS_MS - 1)).toBe(false);
    const moved = moveTouchGesture(held, { clientX: 130, clientY: 200 }).gesture;
    expect(isTouchLongPressDue(moved, 1_000 + TOUCH_LONG_PRESS_MS)).toBe(false);
  });

  it("a consumed gesture neither scrolls nor taps", () => {
    const consumed = { ...start(), mode: "consumed" as const };
    expect(moveTouchGesture(consumed, { clientX: 0, clientY: 0 }).scrollDelta).toBeNull();
    expect(finishTouchGesture(consumed)).toBe("none");
  });
});
