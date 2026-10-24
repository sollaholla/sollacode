import { describe, expect, it } from "vite-plus/test";

import { imageSwipeDirection } from "./imageSwipe";

describe("imageSwipeDirection", () => {
  it("moves to the next image on a drag left and the previous on a drag right", () => {
    expect(imageSwipeDirection({ dx: -90, dy: 10, elapsedMs: 600 })).toBe(1);
    expect(imageSwipeDirection({ dx: 90, dy: -10, elapsedMs: 600 })).toBe(-1);
  });

  it("takes a short drag only when it is a quick flick", () => {
    expect(imageSwipeDirection({ dx: -30, dy: 0, elapsedMs: 120 })).toBe(1);
    expect(imageSwipeDirection({ dx: -30, dy: 0, elapsedMs: 600 })).toBeNull();
    expect(imageSwipeDirection({ dx: -10, dy: 0, elapsedMs: 50 })).toBeNull();
  });

  it("ignores a drag that is mostly up or down", () => {
    expect(imageSwipeDirection({ dx: -90, dy: 80, elapsedMs: 120 })).toBeNull();
    expect(imageSwipeDirection({ dx: 0, dy: 200, elapsedMs: 120 })).toBeNull();
  });
});
