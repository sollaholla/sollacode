import { describe, expect, it } from "vite-plus/test";

import { mapPointToVirtualDesktop } from "./remoteControl.ts";

// Two 1920x1080 monitors side by side: primary on the left, secondary to its
// right. The virtual desktop is therefore 3840x1080 starting at the origin.
const PRIMARY = { x: 0, y: 0, width: 1920, height: 1080 };
const SECONDARY = { x: 1920, y: 0, width: 1920, height: 1080 };
const ALL = [PRIMARY, SECONDARY];

describe("mapPointToVirtualDesktop", () => {
  it("maps the centre of the primary display to the left half of the desktop", () => {
    const point = mapPointToVirtualDesktop({ x: 0.5, y: 0.5 }, PRIMARY, ALL);
    expect(point.x).toBeCloseTo(0.25);
    expect(point.y).toBeCloseTo(0.5);
  });

  it("maps the centre of the secondary display to the right half", () => {
    // The regression: without this remap a click aimed at the middle of the
    // second monitor landed on the seam between the two, so only the taskbar
    // row — identical on both screens — appeared to respond.
    const point = mapPointToVirtualDesktop({ x: 0.5, y: 0.5 }, SECONDARY, ALL);
    expect(point.x).toBeCloseTo(0.75);
    expect(point.y).toBeCloseTo(0.5);
  });

  it("maps the corners of each display to the right desktop edges", () => {
    expect(mapPointToVirtualDesktop({ x: 0, y: 0 }, PRIMARY, ALL).x).toBeCloseTo(0);
    expect(mapPointToVirtualDesktop({ x: 1, y: 1 }, SECONDARY, ALL).x).toBeCloseTo(1);
    expect(mapPointToVirtualDesktop({ x: 1, y: 1 }, SECONDARY, ALL).y).toBeCloseTo(1);
    // The primary's right edge meets the secondary's left edge at the seam.
    expect(mapPointToVirtualDesktop({ x: 1, y: 0 }, PRIMARY, ALL).x).toBeCloseTo(0.5);
    expect(mapPointToVirtualDesktop({ x: 0, y: 0 }, SECONDARY, ALL).x).toBeCloseTo(0.5);
  });

  it("handles a secondary display positioned above and to the left", () => {
    // Negative origins are normal on Windows when a monitor sits left of or
    // above the primary, and must not produce out-of-range coordinates.
    const left = { x: -1920, y: -180, width: 1920, height: 1080 };
    const all = [PRIMARY, left];
    const point = mapPointToVirtualDesktop({ x: 0.5, y: 0.5 }, left, all);
    expect(point.x).toBeCloseTo(0.25);
    expect(point.x).toBeGreaterThanOrEqual(0);
    expect(point.y).toBeGreaterThanOrEqual(0);
    expect(point.y).toBeLessThanOrEqual(1);
  });

  it("is an identity mapping when a single display fills the desktop", () => {
    const point = mapPointToVirtualDesktop({ x: 0.3, y: 0.7 }, PRIMARY, [PRIMARY]);
    expect(point.x).toBeCloseTo(0.3);
    expect(point.y).toBeCloseTo(0.7);
  });

  it("clamps points that fall outside the desktop", () => {
    const point = mapPointToVirtualDesktop({ x: 5, y: -5 }, SECONDARY, ALL);
    expect(point.x).toBe(1);
    expect(point.y).toBe(0);
  });
});
