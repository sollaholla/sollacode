import { describe, expect, it } from "vite-plus/test";

import { shouldReconfigureSize, targetEncodeSize } from "./mediaEncodeSize.ts";

const desktop = { width: 2_560, height: 1_600 };
const phone = { width: 374, height: 744, devicePixelRatio: 3, zoom: 1 };
const laptop = { width: 1_424, height: 800, devicePixelRatio: 2, zoom: 1 };

describe("media encode size", () => {
  it("keeps a bounded text sampling margin for a phone below the full desktop size", () => {
    const size = targetEncodeSize({ source: desktop, viewports: [phone] });
    expect(size).toEqual({ width: 1_680, height: 1_050 });
    expect((size.width * size.height) / (desktop.width * desktop.height)).toBeLessThan(0.5);
  });

  it("never encodes more pixels than the source has", () => {
    expect(targetEncodeSize({ source: desktop, viewports: [laptop] })).toEqual(desktop);
  });

  it("keeps phone encoding widths on a four-pixel boundary without extra height alignment", () => {
    for (const width of [372, 374, 376, 378, 390]) {
      const size = targetEncodeSize({ source: desktop, viewports: [{ ...phone, width }] });
      expect(size.width % 4).toBe(0);
      expect(size.height % 2).toBe(0);
      expect(Math.abs(size.width - width * phone.devicePixelRatio * 1.5)).toBeLessThan(4);
      expect(
        Math.abs(size.height - (size.width * desktop.height) / desktop.width),
      ).toBeLessThanOrEqual(1);
    }
    const evenHeight = targetEncodeSize({ source: desktop, viewports: [{ ...phone, width: 376 }] });
    expect(evenHeight.height % 4).toBe(2);
  });

  it("rounds down at odd source bounds, including with no viewers", () => {
    for (const viewports of [[], [laptop]]) {
      const size = targetEncodeSize({ source: { width: 1_123, height: 703 }, viewports });
      expect(size.width % 4).toBe(0);
      expect(size.height % 2).toBe(0);
      expect(size.width).toBeLessThanOrEqual(1_123);
      expect(size.height).toBeLessThanOrEqual(703);
      expect(Math.abs(size.height - (size.width * 703) / 1_123)).toBeLessThanOrEqual(1);
    }
  });

  it("keeps alignment rounding inside the pixel budget", () => {
    const budget = 1_122 * 702;
    for (const viewports of [[phone], []]) {
      const size = targetEncodeSize({ source: desktop, viewports, maxPixels: budget });
      expect(size.width % 4).toBe(0);
      expect(size.height % 2).toBe(0);
      expect(size.width * size.height).toBeLessThanOrEqual(budget);
      expect(
        Math.abs(size.height - (size.width * desktop.height) / desktop.width),
      ).toBeLessThanOrEqual(2);
    }
  });

  it("respects tiny source and pixel bounds when four-pixel alignment cannot fit", () => {
    expect(targetEncodeSize({ source: { width: 4, height: 2 }, viewports: [] })).toEqual({
      width: 4,
      height: 2,
    });
    expect(targetEncodeSize({ source: { width: 2, height: 2 }, viewports: [] })).toEqual({
      width: 2,
      height: 2,
    });
    const tiny = targetEncodeSize({ source: desktop, viewports: [phone], maxPixels: 8 });
    expect(tiny).toEqual({ width: 4, height: 2 });
  });

  it("raises the size while the viewer is zoomed in, up to the source", () => {
    const zoomed = targetEncodeSize({ source: desktop, viewports: [{ ...phone, zoom: 1.2 }] });
    expect(zoomed).toEqual({ width: 2_016, height: 1_260 });
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

  it("reconfigures a height-only native source resize", () => {
    const viewports = [{ width: 390, height: 700, devicePixelRatio: 3, zoom: 1 }];
    const before = targetEncodeSize({ source: { width: 900, height: 1000 }, viewports });
    const after = targetEncodeSize({ source: { width: 900, height: 600 }, viewports });
    expect(before).toEqual({ width: 900, height: 1000 });
    expect(after).toEqual({ width: 900, height: 600 });
    expect(shouldReconfigureSize(before, after)).toBe(true);
  });

  it("does not retain an encoder with a changed source aspect ratio", () => {
    expect(shouldReconfigureSize({ width: 900, height: 1000 }, { width: 900, height: 950 })).toBe(
      true,
    );
    expect(shouldReconfigureSize({ width: 900, height: 1000 }, { width: 900, height: 995 })).toBe(
      false,
    );
  });
});
