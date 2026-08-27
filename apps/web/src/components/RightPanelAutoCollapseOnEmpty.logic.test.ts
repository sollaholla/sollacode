import { describe, expect, it } from "vite-plus/test";

import { shouldAutoCollapseRightPanelOnEmpty } from "./RightPanelAutoCollapseOnEmpty.logic.ts";

describe("shouldAutoCollapseRightPanelOnEmpty", () => {
  const base = {
    previousSurfaceCount: 1,
    surfaceCount: 0,
    alreadyCollapsedOnce: false,
    panelOpen: true,
  };

  it("collapses when the last tab closes", () => {
    expect(shouldAutoCollapseRightPanelOnEmpty(base)).toBe(true);
  });

  it("does not collapse a second time, so the panel can be reopened and kept", () => {
    expect(shouldAutoCollapseRightPanelOnEmpty({ ...base, alreadyCollapsedOnce: true })).toBe(
      false,
    );
  });

  it("ignores a panel that was already empty", () => {
    expect(shouldAutoCollapseRightPanelOnEmpty({ ...base, previousSurfaceCount: 0 })).toBe(false);
    expect(shouldAutoCollapseRightPanelOnEmpty({ ...base, previousSurfaceCount: null })).toBe(
      false,
    );
  });

  it("ignores a close that leaves tabs behind", () => {
    expect(
      shouldAutoCollapseRightPanelOnEmpty({ ...base, previousSurfaceCount: 3, surfaceCount: 2 }),
    ).toBe(false);
  });

  it("does nothing when the right panel is already closed", () => {
    expect(shouldAutoCollapseRightPanelOnEmpty({ ...base, panelOpen: false })).toBe(false);
  });
});
