import { describe, expect, it } from "vite-plus/test";

import {
  sameMediaRegion,
  shouldReconfigureSize,
  targetEncodeRegion,
  targetEncodeSize,
} from "./mediaEncodeSize.ts";

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

describe("encoding only the magnified part", () => {
  const retina = { width: 3_024, height: 1_964 };
  const region = { x: 0.4, y: 0.4, width: 1 / 6, height: 1 / 6 };
  const zoomed = { ...laptop, zoom: 6, region };

  it("spends pixels on the visible part, at the source's own sharpness", () => {
    const crop = targetEncodeRegion({ viewports: [zoomed], current: null })!;
    const size = targetEncodeSize({ source: retina, viewports: [zoomed], region: crop });
    const whole = targetEncodeSize({ source: retina, viewports: [zoomed] });
    expect(size.width).toBeGreaterThan(retina.width * crop.width - 5);
    expect(size.width).toBeLessThanOrEqual(retina.width * crop.width);
    expect(size.width * size.height).toBeLessThan((whole.width * whole.height) / 8);
  });

  it("leaves a margin for small pans and stays inside the picture", () => {
    expect(targetEncodeRegion({ viewports: [zoomed], current: null })).toMatchObject({
      x: expect.closeTo(0.375, 5),
      width: expect.closeTo(0.2167, 3),
    });
    const corner = { ...zoomed, region: { x: 0.9, y: 0, width: 0.1, height: 0.1 } };
    const crop = targetEncodeRegion({ viewports: [corner], current: null })!;
    expect(crop.x + crop.width).toBeCloseTo(1, 5);
    expect(crop.y).toBe(0);
  });

  it("keeps the whole picture when a crop would save little", () => {
    const slight = { ...laptop, zoom: 1.2, region: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } };
    expect(targetEncodeRegion({ viewports: [slight], current: null })).toBeNull();
  });

  it("keeps the whole picture for a viewer that reports no region", () => {
    expect(targetEncodeRegion({ viewports: [zoomed, laptop], current: null })).toBeNull();
    expect(targetEncodeRegion({ viewports: [], current: null })).toBeNull();
  });

  it("covers every magnified viewer", () => {
    const other = { ...zoomed, region: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } };
    const crop = targetEncodeRegion({ viewports: [zoomed, other], current: null })!;
    expect(crop.x).toBeLessThanOrEqual(0.1);
    expect(crop.x + crop.width).toBeGreaterThanOrEqual(region.x + region.width);
  });

  it("does not cut a new crop, or pay a key frame, for a pan inside the margin", () => {
    const crop = targetEncodeRegion({ viewports: [zoomed], current: null })!;
    const nudged = { ...zoomed, region: { ...region, x: region.x + 0.01 } };
    expect(targetEncodeRegion({ viewports: [nudged], current: crop })).toBe(crop);
    const away = { ...zoomed, region: { ...region, x: 0.05 } };
    expect(sameMediaRegion(targetEncodeRegion({ viewports: [away], current: crop }), crop)).toBe(
      false,
    );
  });

  it("cuts a tighter crop once magnified much further", () => {
    const wide = targetEncodeRegion({
      viewports: [{ ...laptop, zoom: 2, region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } }],
      current: null,
    })!;
    expect(targetEncodeRegion({ viewports: [zoomed], current: wide })?.width).toBeLessThan(0.3);
  });
});
