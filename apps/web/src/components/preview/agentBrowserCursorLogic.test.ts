import { describe, expect, it } from "vite-plus/test";

import { agentBrowserCursorOffset, agentBrowserCursorOpacity } from "./agentBrowserCursorLogic";

describe("agentBrowserCursorOpacity", () => {
  it("keeps active movement fully visible", () => {
    expect(agentBrowserCursorOpacity(true, "agent")).toBe(1);
    expect(agentBrowserCursorOpacity(true, "human")).toBe(1);
  });

  it("settles to a visible idle state", () => {
    expect(agentBrowserCursorOpacity(false, "none")).toBe(0.35);
    expect(agentBrowserCursorOpacity(false, "agent")).toBe(0.35);
  });

  it("dims further while the human controls the page", () => {
    expect(agentBrowserCursorOpacity(false, "human")).toBe(0.18);
  });
});

describe("agentBrowserCursorOffset", () => {
  // A 1280x800 freeform viewport in a panel too narrow for it: the webview is
  // laid out at the full 1280 and shrunk with `transform: scale(0.9133)`
  // (HostedBrowserWebview). A CSS transform leaves the guest's layout
  // viewport untouched, so the guest still reports coordinates in 1280-space
  // and the drawn position is coordinate × scale + panel offset.
  const fitted = { x: 40, y: 12, scale: 0.9133, scrollLeft: 0, scrollTop: 0 };

  it("puts the cursor on the click in a scaled-down panel", () => {
    // The guest's right edge (1280) must land on the drawn viewport's right
    // edge: 40 + 1280 × 0.9133. Without the fit scale the cursor overshot the
    // drawn page by the inverse amount, drifting further from the real click
    // toward the bottom-right (reported 2026-08-30 against Doodle Dungeon).
    const offset = agentBrowserCursorOffset({ x: 1280, y: 800, zoomFactor: 1, surface: fitted });
    expect(offset.x).toBeCloseTo(40 + 1280 * 0.9133, 6);
    expect(offset.y).toBeCloseTo(12 + 800 * 0.9133, 6);
  });

  it("still lands on the origin of the drawn viewport", () => {
    expect(agentBrowserCursorOffset({ x: 0, y: 0, zoomFactor: 1, surface: fitted })).toEqual({
      x: 40,
      y: 12,
    });
  });

  it("scales by page zoom, which the guest does not fold into its own pixels", () => {
    expect(
      agentBrowserCursorOffset({
        x: 100,
        y: 50,
        zoomFactor: 1.5,
        surface: { x: 0, y: 0, scale: 1, scrollLeft: 0, scrollTop: 0 },
      }),
    ).toEqual({ x: 150, y: 75 });
  });

  it("follows a scrolled surface", () => {
    expect(
      agentBrowserCursorOffset({
        x: 100,
        y: 100,
        zoomFactor: 1,
        surface: { x: 10, y: 20, scale: 1, scrollLeft: 30, scrollTop: 40 },
      }),
    ).toEqual({ x: 80, y: 80 });
  });

  it("pans the scaled canvas with the wrapper scrollbars", () => {
    // Scroll offsets are panel pixels on the already-scaled canvas, so they
    // subtract after the fit scale is applied.
    const offset = agentBrowserCursorOffset({
      x: 200,
      y: 100,
      zoomFactor: 1,
      surface: { x: 0, y: 0, scale: 0.5, scrollLeft: 25, scrollTop: 10 },
    });
    expect(offset).toEqual({ x: 200 * 0.5 - 25, y: 100 * 0.5 - 10 });
  });

  it("falls back to raw coordinates before any surface geometry arrives", () => {
    expect(agentBrowserCursorOffset({ x: 12, y: 34, zoomFactor: 1, surface: null })).toEqual({
      x: 12,
      y: 34,
    });
  });
});
