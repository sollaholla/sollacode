import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createTouchActionMenu, TOUCH_MENU_HOLD_MS, TOUCH_MENU_DWELL_MS } from "./touchActionMenu";
const origin = { x: 200, y: 300 };
function harness() {
  const callbacks = { menu: vi.fn(), pointer: vi.fn(), scroll: vi.fn() };
  return { ...callbacks, gesture: createTouchActionMenu(callbacks) };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
describe("remote touch action menu", () => {
  it("scrolls a pan when asked, counting the travel inside the slop", () => {
    const callbacks = { menu: vi.fn(), pointer: vi.fn(), scroll: vi.fn(), panScrolls: true };
    const gesture = createTouchActionMenu(callbacks);
    gesture.start(origin, origin);
    gesture.move({ x: 200, y: 285 });
    expect(callbacks.scroll).toHaveBeenLastCalledWith(origin, { x: 0, y: 15 });
    gesture.move({ x: 200, y: 280 });
    expect(callbacks.scroll.mock.lastCall?.[1].y).toBe(5);
    vi.advanceTimersByTime(TOUCH_MENU_HOLD_MS * 2);
    expect(callbacks.menu).not.toHaveBeenCalledWith(expect.objectContaining({ center: origin }));
    gesture.end();
    expect(callbacks.pointer).not.toHaveBeenCalled();
  });
  it("only clicks on quick tap release, sending down then up", () => {
    const h = harness();
    h.gesture.start(origin, origin);
    vi.advanceTimersByTime(200);
    expect(h.pointer).not.toHaveBeenCalled();
    h.gesture.end();
    expect(h.pointer.mock.calls).toEqual([
      ["down", origin, "left"],
      ["up", origin, "left"],
    ]);
    vi.runAllTimers();
    expect(h.pointer).toHaveBeenCalledTimes(2);
  });
  it("holding and releasing the menu never performs a click", () => {
    const h = harness();
    h.gesture.start(origin, origin);
    vi.advanceTimersByTime(20_000);
    expect(h.menu).toHaveBeenLastCalledWith({
      center: origin,
      layer: "main",
      hovered: null,
      activated: null,
    });
    h.gesture.end();
    expect(h.pointer).not.toHaveBeenCalled();
  });
  it("activates scroll by dwell without release and anchors wheel input", () => {
    const h = harness();
    h.gesture.start(origin, origin);
    vi.advanceTimersByTime(TOUCH_MENU_HOLD_MS);
    h.gesture.move({ x: 200, y: 234 });
    vi.advanceTimersByTime(TOUCH_MENU_DWELL_MS);
    h.gesture.move({ x: 210, y: 214 });
    expect(h.scroll).toHaveBeenCalledWith(origin, { x: -10, y: 20 });
    h.gesture.end();
    expect(h.pointer).not.toHaveBeenCalled();
  });
  it("starts drag at the original target, excludes menu travel, and releases once", () => {
    const h = harness();
    h.gesture.start(origin, origin);
    vi.advanceTimersByTime(TOUCH_MENU_HOLD_MS);
    h.gesture.move({ x: 134, y: 310 });
    vi.advanceTimersByTime(TOUCH_MENU_DWELL_MS);
    expect(h.pointer.mock.calls).toEqual([["down", origin, "left"]]);
    h.gesture.move({ x: 144, y: 315 });
    h.gesture.end();
    h.gesture.cancel();
    expect(h.pointer.mock.calls).toEqual([
      ["down", origin, "left"],
      ["move", { x: 210, y: 305 }, "left"],
      ["up", { x: 210, y: 305 }, "left"],
    ]);
  });
  it("right-clicks once on completed dwell, never again on release", () => {
    const h = harness();
    h.gesture.start(origin, origin);
    vi.advanceTimersByTime(TOUCH_MENU_HOLD_MS);
    h.gesture.move({ x: 266, y: 310 });
    vi.advanceTimersByTime(TOUCH_MENU_DWELL_MS);
    expect(h.pointer.mock.calls).toEqual([
      ["down", origin, "right"],
      ["up", origin, "right"],
    ]);
    h.gesture.end();
    expect(h.pointer).toHaveBeenCalledTimes(2);
  });
  it("resets dwell when leaving an option and cancels safely for pinch or lost capture", () => {
    const h = harness();
    h.gesture.start(origin, origin);
    vi.advanceTimersByTime(TOUCH_MENU_HOLD_MS);
    h.gesture.move({ x: 134, y: 310 });
    vi.advanceTimersByTime(300);
    h.gesture.move(origin);
    vi.advanceTimersByTime(1000);
    expect(h.pointer).not.toHaveBeenCalled();
    h.gesture.move({ x: 134, y: 310 });
    h.gesture.cancel();
    vi.runAllTimers();
    expect(h.pointer).not.toHaveBeenCalled();
  });
  it("does not turn finger movement before the hold into a click or drag", () => {
    const h = harness();
    h.gesture.start(origin, origin);
    h.gesture.move({ x: 220, y: 300 });
    vi.runAllTimers();
    h.gesture.end();
    expect(h.pointer).not.toHaveBeenCalled();
  });
  it.each(["left", "right"] as const)(
    "holds %s at the anchor and releases on cancellation",
    (button) => {
      const h = harness();
      h.gesture.start(origin, origin);
      vi.advanceTimersByTime(TOUCH_MENU_HOLD_MS);
      h.gesture.move({ x: 200, y: 376 });
      vi.advanceTimersByTime(TOUCH_MENU_DWELL_MS);
      expect(h.pointer).not.toHaveBeenCalled();
      expect(h.menu).toHaveBeenLastCalledWith({
        center: origin,
        layer: "hold",
        hovered: null,
        activated: null,
      });
      h.gesture.move({ x: button === "left" ? 148 : 252, y: 300 });
      vi.advanceTimersByTime(TOUCH_MENU_DWELL_MS);
      h.gesture.move({ x: 320, y: 420 });
      vi.advanceTimersByTime(30_000);
      expect(h.pointer.mock.calls).toEqual([["down", origin, button]]);
      h.gesture.cancel();
      h.gesture.end();
      expect(h.pointer.mock.calls).toEqual([
        ["down", origin, button],
        ["up", origin, button],
      ]);
    },
  );
  it("does not click after a long hold even if the timer was delayed", () => {
    const h = harness();
    h.gesture.start(origin, origin);
    vi.setSystemTime(Date.now() + 2000);
    h.gesture.end();
    expect(h.pointer).not.toHaveBeenCalled();
  });
});
