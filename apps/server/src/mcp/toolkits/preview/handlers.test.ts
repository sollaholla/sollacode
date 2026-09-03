import { describe, expect, it } from "vite-plus/test";

import {
  PREVIEW_WAIT_SLICE_MS,
  boundedPreviewWaitMs,
  normalizePreviewOpenInput,
} from "./handlers.ts";

describe("normalizePreviewOpenInput", () => {
  it("opens the inline preview and reuses the current tab by default", () => {
    expect(normalizePreviewOpenInput({})).toEqual({
      open: true,
      reuseExistingTab: true,
      show: true,
    });
  });

  it("preserves an explicit background-only opt-out", () => {
    expect(normalizePreviewOpenInput({ open: false })).toEqual({
      open: false,
      reuseExistingTab: true,
      show: false,
    });
  });

  it("supports show as a legacy alias while preferring open", () => {
    expect(normalizePreviewOpenInput({ show: false })).toEqual({
      open: false,
      reuseExistingTab: true,
      show: false,
    });
    expect(normalizePreviewOpenInput({ open: true, show: false })).toEqual({
      open: true,
      reuseExistingTab: true,
      show: true,
    });
  });
});

describe("boundedPreviewWaitMs", () => {
  it("serves a long wait one slice at a time so the call answers inside the MCP budget", () => {
    // 120s default for a download wait: the MCP client gives up at 60s and
    // discards the answer the desktop then produces.
    expect(boundedPreviewWaitMs(undefined, 120_000)).toBe(PREVIEW_WAIT_SLICE_MS);
    expect(boundedPreviewWaitMs(600_000, 120_000)).toBe(PREVIEW_WAIT_SLICE_MS);
    expect(boundedPreviewWaitMs(60_000, 15_000)).toBe(PREVIEW_WAIT_SLICE_MS);
  });

  it("leaves a short wait alone", () => {
    expect(boundedPreviewWaitMs(undefined, 15_000)).toBe(15_000);
    expect(boundedPreviewWaitMs(2_500, 15_000)).toBe(2_500);
    expect(boundedPreviewWaitMs(0.4, 15_000)).toBe(1);
  });

  it("stays under the client's limit with room for the hop back", () => {
    expect(PREVIEW_WAIT_SLICE_MS).toBeLessThan(60_000);
  });
});
