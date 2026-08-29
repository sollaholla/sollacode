import { describe, expect, it } from "vite-plus/test";

import { mapRemotePointerToViewport } from "./remotePointerMapping";

// A 2x-DPR guest: 1600x1000 device pixels for an 800x500 CSS viewport.
const RETINA = {
  frame: { width: 1600, height: 1000 },
  viewport: { width: 800, height: 500 },
} as const;

describe("remote pointer mapping", () => {
  it("maps the centre of an exactly-fitted frame to the centre of the page", () => {
    expect(
      mapRemotePointerToViewport(
        { clientX: 400, clientY: 250 },
        { ...RETINA, element: { x: 0, y: 0, width: 800, height: 500 } },
      ),
    ).toEqual({ x: 400, y: 250 });
  });

  it("undoes the letterbox when the element is taller than the frame", () => {
    // 800x700 element, 16:10 frame paints 800x500 centred: 100px bars.
    const geometry = { ...RETINA, element: { x: 0, y: 0, width: 800, height: 700 } };
    expect(mapRemotePointerToViewport({ clientX: 400, clientY: 350 }, geometry)).toEqual({
      x: 400,
      y: 250,
    });
    // Top edge of the painted area, not of the element.
    expect(mapRemotePointerToViewport({ clientX: 0, clientY: 100 }, geometry)).toEqual({
      x: 0,
      y: 0,
    });
  });

  it("accounts for the element's own offset in the page", () => {
    expect(
      mapRemotePointerToViewport(
        { clientX: 340, clientY: 130 },
        { ...RETINA, element: { x: 340, y: 130, width: 800, height: 500 } },
      ),
    ).toEqual({ x: 0, y: 0 });
  });

  it("rejects a point in the letterbox rather than aiming off the page", () => {
    const geometry = { ...RETINA, element: { x: 0, y: 0, width: 800, height: 700 } };
    expect(mapRemotePointerToViewport({ clientX: 400, clientY: 50 }, geometry)).toBeNull();
    expect(mapRemotePointerToViewport({ clientX: 400, clientY: 650 }, geometry)).toBeNull();
  });

  it("refuses degenerate geometry instead of sending NaN to the host", () => {
    for (const geometry of [
      {
        ...RETINA,
        frame: { width: 0, height: 0 },
        element: { x: 0, y: 0, width: 800, height: 500 },
      },
      { ...RETINA, element: { x: 0, y: 0, width: 0, height: 0 } },
      {
        ...RETINA,
        viewport: { width: 0, height: 0 },
        element: { x: 0, y: 0, width: 800, height: 500 },
      },
    ]) {
      expect(mapRemotePointerToViewport({ clientX: 10, clientY: 10 }, geometry)).toBeNull();
    }
  });
});
