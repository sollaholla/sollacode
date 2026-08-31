import { describe, expect, it } from "vite-plus/test";

import { isTypingSurfaceInput } from "./userInputSurfaces.ts";

describe("isTypingSurfaceInput", () => {
  it("arms for typing into a focused field", () => {
    expect(
      isTypingSurfaceInput({
        eventType: "keydown",
        activeElementIsEditable: true,
        targetIsInsideEditable: false,
      }),
    ).toBe(true);
  });

  it("arms for a click that lands in a text field", () => {
    expect(
      isTypingSurfaceInput({
        eventType: "pointerdown",
        activeElementIsEditable: false,
        targetIsInsideEditable: true,
      }),
    ).toBe(true);
  });

  it("ignores reading the app: clicks on rows, tabs and buttons", () => {
    // The whole point of the change. Browsing threads used to re-arm a 5s
    // hold on every click and starve every agent.
    expect(
      isTypingSurfaceInput({
        eventType: "pointerdown",
        activeElementIsEditable: false,
        targetIsInsideEditable: false,
      }),
    ).toBe(false);
  });

  it("ignores shortcuts pressed outside a field", () => {
    expect(
      isTypingSurfaceInput({
        eventType: "keydown",
        activeElementIsEditable: false,
        targetIsInsideEditable: true,
      }),
    ).toBe(false);
  });

  it("ignores everything else, including movement and wheel", () => {
    for (const eventType of ["pointermove", "wheel", "mousemove", "focus"]) {
      expect(
        isTypingSurfaceInput({
          eventType,
          activeElementIsEditable: true,
          targetIsInsideEditable: true,
        }),
      ).toBe(false);
    }
  });
});
