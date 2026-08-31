import { describe, expect, it } from "vite-plus/test";

import {
  FRAME_DRAG_HOLD_MS,
  FRAME_TAP_SLOP_PX,
  containedFrameFraction,
  containedFrameRect,
  frameFraction,
  resolveFrameGesture,
  type FrameGestureSample,
} from "./remoteFrameGestures.ts";

const size = { width: 400, height: 300 };

function sample(overrides: Partial<FrameGestureSample>): FrameGestureSample {
  return {
    startedAt: 1_000,
    start: { x: 100, y: 150 },
    end: { x: 100, y: 150 },
    maxDistancePx: 0,
    firstMovedAt: null,
    ...overrides,
  };
}

describe("frameFraction", () => {
  it("maps layout pixels to fractions and clamps to the frame", () => {
    expect(frameFraction(size, { x: 100, y: 150 })).toEqual({ x: 0.25, y: 0.5 });
    expect(frameFraction(size, { x: -20, y: 900 })).toEqual({ x: 0, y: 1 });
  });

  it("refuses an unmeasured layout instead of dividing by zero", () => {
    expect(frameFraction({ width: 0, height: 300 }, { x: 10, y: 10 })).toBeNull();
    expect(frameFraction({ width: 400, height: 0 }, { x: 10, y: 10 })).toBeNull();
  });
});

describe("containedFrameRect", () => {
  it("pillarboxes a wide container around a narrower image", () => {
    // 1000×500 container, 800×600 image → scale 5/6 → 666.67×500 centered.
    const rect = containedFrameRect({ width: 1000, height: 500 }, { width: 800, height: 600 });
    expect(rect).not.toBeNull();
    expect(rect?.top).toBe(0);
    expect(rect?.height).toBe(500);
    expect(rect?.width).toBeCloseTo(1000 / 1.5, 5);
    expect(rect?.left).toBeCloseTo((1000 - 1000 / 1.5) / 2, 5);
  });

  it("letterboxes a tall container above and below a wider image", () => {
    const rect = containedFrameRect({ width: 400, height: 800 }, { width: 800, height: 600 });
    expect(rect).toEqual({ left: 0, top: 250, width: 400, height: 300 });
  });

  it("returns null for unusable geometry", () => {
    expect(containedFrameRect({ width: 0, height: 10 }, { width: 8, height: 6 })).toBeNull();
    expect(containedFrameRect({ width: 10, height: 10 }, { width: 0, height: 6 })).toBeNull();
  });
});

describe("containedFrameFraction", () => {
  const container = { width: 400, height: 800 };
  const image = { width: 800, height: 600 };
  // Content rect: 400×300 at top 250.

  it("maps points inside the content rect through the letterbox", () => {
    expect(containedFrameFraction(container, image, { x: 100, y: 400 })).toEqual({
      x: 0.25,
      y: 0.5,
    });
    expect(containedFrameFraction(container, image, { x: 0, y: 250 })).toEqual({ x: 0, y: 0 });
    expect(containedFrameFraction(container, image, { x: 400, y: 550 })).toEqual({ x: 1, y: 1 });
  });

  it("ignores input landing in the letterbox bars", () => {
    expect(containedFrameFraction(container, image, { x: 100, y: 100 })).toBeNull();
    expect(containedFrameFraction(container, image, { x: 100, y: 700 })).toBeNull();
  });
});

describe("resolveFrameGesture", () => {
  it("treats movement within the tap slop as a click at the start point", () => {
    const action = resolveFrameGesture(
      size,
      sample({ end: { x: 104, y: 153 }, maxDistancePx: FRAME_TAP_SLOP_PX }),
    );
    expect(action).toEqual({ kind: "click", position: { x: 0.25, y: 0.5 } });
  });

  it("keeps a stationary long-press a click, not a drag", () => {
    const action = resolveFrameGesture(size, sample({ maxDistancePx: 2, firstMovedAt: null }));
    expect(action).toEqual({ kind: "click", position: { x: 0.25, y: 0.5 } });
  });

  it("turns an immediate movement into a natural-direction scroll", () => {
    const action = resolveFrameGesture(
      size,
      sample({
        end: { x: 100, y: 250 },
        maxDistancePx: 100,
        firstMovedAt: 1_050,
      }),
    );
    // Finger travels down 100px in a 300px frame: reveal content above.
    expect(action).toEqual({ kind: "scroll", deltaX: 0, deltaY: -(100 / 300) });
  });

  it("scrolls horizontally with the same sign convention", () => {
    const action = resolveFrameGesture(
      size,
      sample({ end: { x: 0, y: 150 }, maxDistancePx: 100, firstMovedAt: 1_020 }),
    );
    expect(action).toEqual({ kind: "scroll", deltaX: 100 / 400, deltaY: 0 });
  });

  it("turns a held-then-moved touch into a drag between both fractions", () => {
    const action = resolveFrameGesture(
      size,
      sample({
        end: { x: 300, y: 75 },
        maxDistancePx: 220,
        firstMovedAt: 1_000 + FRAME_DRAG_HOLD_MS,
      }),
    );
    expect(action).toEqual({
      kind: "drag",
      from: { x: 0.25, y: 0.5 },
      to: { x: 0.75, y: 0.25 },
    });
  });

  it("returns null when the frame layout is unusable", () => {
    expect(resolveFrameGesture({ width: 0, height: 0 }, sample({}))).toBeNull();
  });
});
