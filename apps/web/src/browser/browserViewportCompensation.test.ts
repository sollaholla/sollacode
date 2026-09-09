import { describe, expect, it } from "vite-plus/test";
import {
  resolveBrowserViewportHostScale,
  resolveBrowserViewportHostTransform,
} from "./browserViewportCompensation";

describe("responsive viewport zoom compensation", () => {
  it.each([0.5, 0.9, 1, 1.25, 2])(
    "keeps page dimensions and resize rails aligned at app zoom %s",
    (appZoom) => {
      const scale = resolveBrowserViewportHostScale(appZoom);
      const page = { width: 390, height: 844 };
      const guestZoom = 1.2;
      const fit = 0.5;
      for (const axis of ["width", "height"] as const) {
        const hostSize = page[axis] * guestZoom * scale[axis];
        expect((hostSize * appZoom) / guestZoom).toBeCloseTo(page[axis]);
        expect((hostSize * fit) / scale[axis]).toBeCloseTo(page[axis] * guestZoom * fit);
      }
      expect(resolveBrowserViewportHostTransform(fit, scale)).toBe(
        `scale(${fit / scale.width}, ${fit / scale.height})`,
      );
    },
  );
  it.each([0, -1, NaN, Infinity])("ignores invalid embedder zoom %s", (zoom) => {
    expect(resolveBrowserViewportHostScale(zoom)).toEqual({ width: 1, height: 1 });
  });
});
