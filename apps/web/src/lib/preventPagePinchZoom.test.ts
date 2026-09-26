// @vitest-environment happy-dom
import { expect, it } from "vite-plus/test";
import { preventPagePinchZoom } from "./preventPagePinchZoom";

it("blocks page pinch defaults, preserves app gesture delivery and single-touch editing, and cleans up", () => {
  const dispose = preventPagePinchZoom(document);
  const surface = document.createElement("div");
  document.body.append(surface);
  let received = 0;
  surface.addEventListener("touchmove", () => received++);
  try {
    for (const type of ["gesturestart", "gesturechange"]) {
      const gesture = new Event(type, { bubbles: true, cancelable: true });
      surface.dispatchEvent(gesture);
      expect(gesture.defaultPrevented).toBe(true);
    }
    for (const count of [1, 2]) {
      const touch = new Event("touchmove", { bubbles: true, cancelable: true });
      Object.defineProperty(touch, "touches", { value: Array.from({ length: count }) });
      surface.dispatchEvent(touch);
      expect(touch.defaultPrevented).toBe(count === 2);
    }
    expect(received).toBe(2);
    dispose();
    const gesture = new Event("gesturestart", { bubbles: true, cancelable: true });
    surface.dispatchEvent(gesture);
    expect(gesture.defaultPrevented).toBe(false);
  } finally {
    dispose();
    surface.remove();
  }
});
