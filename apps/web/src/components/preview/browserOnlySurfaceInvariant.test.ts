import { describe, expect, it } from "vite-plus/test";

import {
  resolveBrowserOnlySurfaceTarget,
  shouldEnsureBrowserOnlySurface,
} from "./browserOnlySurfaceInvariant";

describe("browser-only surface invariant", () => {
  it("fills an agent panel that opened with nothing in it", () => {
    expect(
      shouldEnsureBrowserOnlySurface({
        browserOnly: true,
        browserAvailable: true,
        panelOpen: true,
        surfaceCount: 0,
        previousSurfaceCount: null,
      }),
    ).toBe(true);
  });

  it("lets the user close the last tab instead of snapping it back", () => {
    // The panel held one surface and now holds none: that is a deliberate
    // close, and refilling it made closing an agent's final tab impossible.
    expect(
      shouldEnsureBrowserOnlySurface({
        browserOnly: true,
        browserAvailable: true,
        panelOpen: true,
        surfaceCount: 0,
        previousSurfaceCount: 1,
      }),
    ).toBe(false);
  });

  it("still fills the panel when it is opened again afterwards", () => {
    // Reopening starts from zero rather than from the count it was closed at,
    // so an agent still lands on its browser rather than the empty chooser.
    expect(
      shouldEnsureBrowserOnlySurface({
        browserOnly: true,
        browserAvailable: true,
        panelOpen: true,
        surfaceCount: 0,
        previousSurfaceCount: 0,
      }),
    ).toBe(true);
  });

  it("leaves closed, unavailable, populated, and general-purpose panels alone", () => {
    for (const input of [
      {
        browserOnly: false,
        browserAvailable: true,
        panelOpen: true,
        surfaceCount: 0,
        previousSurfaceCount: null,
      },
      {
        browserOnly: true,
        browserAvailable: false,
        panelOpen: true,
        surfaceCount: 0,
        previousSurfaceCount: null,
      },
      {
        browserOnly: true,
        browserAvailable: true,
        panelOpen: false,
        surfaceCount: 0,
        previousSurfaceCount: null,
      },
      {
        browserOnly: true,
        browserAvailable: true,
        panelOpen: true,
        surfaceCount: 1,
        previousSurfaceCount: null,
      },
      // A side chat left open beside the browser: closing every browser tab
      // leaves that surface behind, so there is nothing to refill.
      {
        browserOnly: true,
        browserAvailable: true,
        panelOpen: true,
        surfaceCount: 1,
        previousSurfaceCount: 2,
      },
    ]) {
      expect(shouldEnsureBrowserOnlySurface(input)).toBe(false);
    }
  });
});

describe("browser-only surface refill target", () => {
  it("adopts the most recently updated existing tab instead of a blank one", () => {
    expect(
      resolveBrowserOnlySurfaceTarget({
        "tab-old": { updatedAt: "2026-08-31T00:00:00.000Z" },
        "tab-new": { updatedAt: "2026-08-31T00:05:00.000Z" },
        "tab-mid": { updatedAt: "2026-08-31T00:01:00.000Z" },
      }),
    ).toEqual({ kind: "existing", tabId: "tab-new" });
  });

  it("adopts a single surviving tab rather than stacking a blank beside it", () => {
    expect(
      resolveBrowserOnlySurfaceTarget({ "tab-1": { updatedAt: "2026-08-31T00:00:00.000Z" } }),
    ).toEqual({ kind: "existing", tabId: "tab-1" });
  });

  it("falls back to a blank tab only when the thread has no tabs at all", () => {
    expect(resolveBrowserOnlySurfaceTarget({})).toEqual({ kind: "blank" });
  });
});
