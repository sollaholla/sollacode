import { describe, expect, it } from "vite-plus/test";

import { resolvePreviewSurfaceMode } from "./previewSurfaceMode";

describe("preview surface mode", () => {
  it("renders its own guest on the machine that owns the environment", () => {
    expect(resolvePreviewSurfaceMode({ environmentLocal: true })).toBe("local-guest");
  });

  it("mirrors the real guest rather than opening a divergent one elsewhere", () => {
    expect(resolvePreviewSurfaceMode({ environmentLocal: false })).toBe("remote-mirror");
  });

  it("keeps the local surface when no primary environment has resolved", () => {
    expect(resolvePreviewSurfaceMode({ environmentLocal: null })).toBe("local-guest");
  });
});
