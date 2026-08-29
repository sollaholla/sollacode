import { describe, expect, it } from "vite-plus/test";

import { resolvePreviewSurfaceMode } from "./previewSurfaceMode";

describe("preview surface mode", () => {
  it("renders its own guest on the machine that owns the environment", () => {
    expect(resolvePreviewSurfaceMode({ canRenderLocalGuest: true, environmentLocal: true })).toBe(
      "local-guest",
    );
  });

  it("mirrors the real guest rather than opening a divergent one elsewhere", () => {
    expect(resolvePreviewSurfaceMode({ canRenderLocalGuest: true, environmentLocal: false })).toBe(
      "remote-mirror",
    );
  });

  it("mirrors in a plain browser, which can host no guest of its own", () => {
    for (const environmentLocal of [true, false, null]) {
      expect(resolvePreviewSurfaceMode({ canRenderLocalGuest: false, environmentLocal })).toBe(
        "remote-mirror",
      );
    }
  });

  it("keeps the local surface while the primary environment is still resolving", () => {
    expect(resolvePreviewSurfaceMode({ canRenderLocalGuest: true, environmentLocal: null })).toBe(
      "local-guest",
    );
  });
});
