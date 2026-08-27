import { describe, expect, it } from "vite-plus/test";

import { shouldAutoCollapseOnEmptyPanel } from "./SidebarAutoCollapseOnEmptyPanel.logic.ts";

describe("shouldAutoCollapseOnEmptyPanel", () => {
  const base = {
    previousSurfaceCount: 1,
    surfaceCount: 0,
    alreadyCollapsedOnce: false,
    sidebarVisible: true,
  };

  it("collapses when the last tab closes", () => {
    expect(shouldAutoCollapseOnEmptyPanel(base)).toBe(true);
  });

  it("does not collapse a second time, so the sidebar can be reopened and kept", () => {
    expect(shouldAutoCollapseOnEmptyPanel({ ...base, alreadyCollapsedOnce: true })).toBe(false);
  });

  it("ignores a panel that was already empty", () => {
    expect(shouldAutoCollapseOnEmptyPanel({ ...base, previousSurfaceCount: 0 })).toBe(false);
    expect(shouldAutoCollapseOnEmptyPanel({ ...base, previousSurfaceCount: null })).toBe(false);
  });

  it("ignores a close that leaves tabs behind", () => {
    expect(
      shouldAutoCollapseOnEmptyPanel({ ...base, previousSurfaceCount: 3, surfaceCount: 2 }),
    ).toBe(false);
  });

  it("does nothing when the sidebar is already closed", () => {
    expect(shouldAutoCollapseOnEmptyPanel({ ...base, sidebarVisible: false })).toBe(false);
  });
});
