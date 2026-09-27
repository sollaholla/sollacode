import { describe, expect, it } from "vite-plus/test";

import {
  IMAGE_ZOOM_DOUBLE_TAP_SCALE,
  IMAGE_ZOOM_MAX,
  IMAGE_ZOOM_RESET,
  clampImageZoom,
  pinchImageZoom,
  toggleImageZoomAt,
  zoomImageAt,
  type ImageZoom,
  type ImageZoomPoint,
} from "./imageZoom";

// A landscape screenshot fitted to a phone: full width, letterboxed vertically.
const bounds = { imageWidth: 400, imageHeight: 225, viewportWidth: 400, viewportHeight: 700 };

/** Where an image point (relative to the image centre) lands on screen. */
function screenPoint(zoom: ImageZoom, imagePoint: ImageZoomPoint): ImageZoomPoint {
  return { x: zoom.x + zoom.scale * imagePoint.x, y: zoom.y + zoom.scale * imagePoint.y };
}

describe("image zoom", () => {
  it("keeps the point under the focus fixed while zooming in", () => {
    // At 4x the screenshot is taller than the phone, so both axes can move.
    const focus = { x: 120, y: 20 };
    const zoomed = zoomImageAt(IMAGE_ZOOM_RESET, focus, 4, bounds);
    expect(zoomed).toEqual({ scale: 4, x: -360, y: -60 });
    const underFocus = { x: (focus.x - zoomed.x) / 4, y: (focus.y - zoomed.y) / 4 };
    expect(screenPoint(zoomed, underFocus)).toEqual(focus);
  });

  it("follows the fingers: spread doubles the scale around the pinch midpoint", () => {
    const start = { zoom: IMAGE_ZOOM_RESET, midpoint: { x: 50, y: 20 }, distance: 100 };
    const zoomed = pinchImageZoom(start, { x: 50, y: 20 }, 200, bounds);
    expect(zoomed.scale).toBe(2);
    expect(zoomed.x).toBeCloseTo(-50);
    // Still shorter than the phone at 2x, so it stays vertically centred.
    expect(zoomed.y).toBe(0);

    // Moving both fingers pans with them.
    const moved = pinchImageZoom(start, { x: 30, y: 10 }, 200, bounds);
    expect(moved.x).toBeCloseTo(-70);
  });

  it("never zooms out past fit or in past the maximum", () => {
    const start = { zoom: IMAGE_ZOOM_RESET, midpoint: { x: 0, y: 0 }, distance: 100 };
    expect(pinchImageZoom(start, { x: 0, y: 0 }, 20, bounds)).toEqual(IMAGE_ZOOM_RESET);
    expect(pinchImageZoom(start, { x: 0, y: 0 }, 10_000, bounds).scale).toBe(IMAGE_ZOOM_MAX);
  });

  it("keeps a zoomed image covering the viewport and a short axis centred", () => {
    // 2x: 800 wide in a 400 viewport can pan 200 each way; 450 tall in 700 stays centred.
    expect(clampImageZoom({ scale: 2, x: 999, y: 80 }, bounds)).toEqual({
      scale: 2,
      x: 200,
      y: 0,
    });
    expect(clampImageZoom({ scale: 4, x: -999, y: -999 }, bounds)).toEqual({
      scale: 4,
      x: -600,
      y: -100,
    });
  });

  it("double tap zooms in on the tapped point and back out", () => {
    const zoomed = toggleImageZoomAt(IMAGE_ZOOM_RESET, { x: 100, y: 0 }, bounds);
    expect(zoomed.scale).toBe(IMAGE_ZOOM_DOUBLE_TAP_SCALE);
    expect(zoomed.x).toBeCloseTo(-150);
    expect(toggleImageZoomAt(zoomed, { x: 0, y: 0 }, bounds)).toEqual(IMAGE_ZOOM_RESET);
  });
});
