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
  // Measured from a live 1280x800 freeform viewport in a panel too narrow for
  // it: the fit scale lands on 0.913, and the guest itself then reports
  // window.innerWidth === 1169 rather than 1280.
  const fitted = { x: 40, y: 12, scale: 0.9133, scrollLeft: 0, scrollTop: 0 };

  it("puts the cursor on the click, not short of it, in a scaled-down panel", () => {
    // The guest reported 1169 as its own right edge, so 1169 has to land on
    // the right edge of the drawn viewport — 40 + 1169. Re-applying the fit
    // scale here put it at 40 + 1068, over a hundred pixels adrift, and the
    // error grew with distance from the top-left.
    expect(agentBrowserCursorOffset({ x: 1169, y: 730, zoomFactor: 1, surface: fitted })).toEqual({
      x: 40 + 1169,
      y: 12 + 730,
    });
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

  it("falls back to raw coordinates before any surface geometry arrives", () => {
    expect(agentBrowserCursorOffset({ x: 12, y: 34, zoomFactor: 1, surface: null })).toEqual({
      x: 12,
      y: 34,
    });
  });
});
