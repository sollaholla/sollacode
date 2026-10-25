import { describe, expect, it } from "vite-plus/test";

import { shouldReconfigureSize, targetEncodeSize } from "./mediaEncodeSize.ts";

const desktop = { width: 2_560, height: 1_600 };
const phone = { width: 374, height: 744, devicePixelRatio: 3, zoom: 1 };
const laptop = { width: 1_424, height: 800, devicePixelRatio: 2, zoom: 1 };

describe("media encode size", () => {
  it("encodes a phone's letterboxed picture at its device pixels, not the desktop's", () => {
    const size = targetEncodeSize({ source: desktop, viewports: [phone] });
    expect(size).toEqual({ width: 1_122, height: 702 });
    expect((size.width * size.height) / (desktop.width * desktop.height)).toBeLessThan(0.2);
  });

  it("never encodes more pixels than the source has", () => {
    expect(targetEncodeSize({ source: desktop, viewports: [laptop] })).toEqual(desktop);
  });

  it("raises the size while the viewer is zoomed in, up to the source", () => {
    const zoomed = targetEncodeSize({ source: desktop, viewports: [{ ...phone, zoom: 2 }] });
    expect(zoomed).toEqual({ width: 2_244, height: 1_402 });
    expect(targetEncodeSize({ source: desktop, viewports: [{ ...phone, zoom: 6 }] })).toEqual(
      desktop,
    );
  });

  it("serves the largest of several viewers and keeps the source's aspect ratio", () => {
    const size = targetEncodeSize({ source: desktop, viewports: [phone, laptop] });
    expect(size).toEqual(desktop);
    const portrait = targetEncodeSize({
      source: { width: 1_080, height: 1_920 },
      viewports: [phone],
    });
    expect(portrait.width / portrait.height).toBeCloseTo(1_080 / 1_920, 2);
    expect(portrait.width % 2).toBe(0);
    expect(portrait.height % 2).toBe(0);
  });

  it("caps very large sources at the pixel budget", () => {
    const size = targetEncodeSize({
      source: { width: 5_120, height: 2_880 },
      viewports: [{ width: 5_120, height: 2_880, devicePixelRatio: 2, zoom: 1 }],
    });
    expect(size.width * size.height).toBeLessThanOrEqual(2_560 * 1_600);
  });

  it("only reconfigures for a meaningful change", () => {
    const current = { width: 1_122, height: 702 };
    expect(shouldReconfigureSize(null, current)).toBe(true);
    expect(shouldReconfigureSize(current, { width: 1_160, height: 724 })).toBe(false);
    expect(shouldReconfigureSize(current, { width: 2_244, height: 1_402 })).toBe(true);
    expect(shouldReconfigureSize(current, { width: 1_000, height: 626 })).toBe(false);
    expect(shouldReconfigureSize(current, { width: 700, height: 438 })).toBe(true);
  });
});
