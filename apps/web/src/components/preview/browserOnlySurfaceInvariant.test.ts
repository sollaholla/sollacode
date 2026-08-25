import { describe, expect, it } from "vite-plus/test";

import { shouldEnsureBrowserOnlySurface } from "./browserOnlySurfaceInvariant";

describe("browser-only surface invariant", () => {
  it("fills an open agent panel when its final tab disappears", () => {
    expect(
      shouldEnsureBrowserOnlySurface({
        browserOnly: true,
        browserAvailable: true,
        panelOpen: true,
        surfaceCount: 0,
      }),
    ).toBe(true);
  });

  it("leaves closed, unavailable, populated, and general-purpose panels alone", () => {
    for (const input of [
      { browserOnly: false, browserAvailable: true, panelOpen: true, surfaceCount: 0 },
      { browserOnly: true, browserAvailable: false, panelOpen: true, surfaceCount: 0 },
      { browserOnly: true, browserAvailable: true, panelOpen: false, surfaceCount: 0 },
      { browserOnly: true, browserAvailable: true, panelOpen: true, surfaceCount: 1 },
    ]) {
      expect(shouldEnsureBrowserOnlySurface(input)).toBe(false);
    }
  });
});
