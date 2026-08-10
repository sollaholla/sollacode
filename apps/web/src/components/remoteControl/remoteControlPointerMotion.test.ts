import { describe, expect, it } from "vite-plus/test";

import {
  clampPointerDelta,
  coalescePointerFrame,
  REMOTE_CONTROL_POINTER_DELTA_LIMIT,
} from "./remoteControlPointerMotion.ts";

const move = (extra: { readonly dx?: number; readonly dy?: number } = {}) =>
  ({
    type: "pointer",
    action: "move",
    x: 0.5,
    y: 0.5,
    button: "left",
    ...extra,
  }) as const;

describe("fresh pointer motion", () => {
  it("keeps the newest absolute destination", () => {
    expect(coalescePointerFrame(move(), { ...move(), x: 0.1, y: 0.9 })).toMatchObject({
      x: 0.1,
      y: 0.9,
    });
  });

  it("combines relative samples only inside one display frame", () => {
    expect(coalescePointerFrame(move({ dx: 12, dy: -7 }), move({ dx: 5, dy: 3 }))).toMatchObject({
      dx: 17,
      dy: -4,
    });
  });

  it("clips a frame instead of splitting it into delayed follow-up events", () => {
    expect(
      coalescePointerFrame(
        move({ dx: REMOTE_CONTROL_POINTER_DELTA_LIMIT, dy: 0 }),
        move({ dx: 50, dy: -REMOTE_CONTROL_POINTER_DELTA_LIMIT - 50 }),
      ),
    ).toMatchObject({
      dx: REMOTE_CONTROL_POINTER_DELTA_LIMIT,
      dy: -REMOTE_CONTROL_POINTER_DELTA_LIMIT,
    });
    expect(clampPointerDelta(Number.NaN)).toBe(0);
  });

  it("uses the newest mode at an absolute-relative transition", () => {
    expect(coalescePointerFrame(move({ dx: 4, dy: 4 }), move())).toEqual(move());
    expect(coalescePointerFrame(move(), move({ dx: 4, dy: 4 }))).toEqual(move({ dx: 4, dy: 4 }));
  });
});
