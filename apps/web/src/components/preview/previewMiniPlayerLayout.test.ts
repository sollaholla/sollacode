import { describe, expect, it } from "vite-plus/test";

import {
  clampPreviewMiniPlayerPosition,
  clampPreviewMiniPlayerSize,
  PREVIEW_MINI_PLAYER_EDGE_GAP,
  PREVIEW_MINI_PLAYER_MIN_SIZE,
  resolvePreviewMiniPlayerResize,
} from "./previewMiniPlayerLayout";

describe("clampPreviewMiniPlayerPosition", () => {
  it("keeps a dragged player within the chat viewport", () => {
    expect(
      clampPreviewMiniPlayerPosition(
        { x: 900, y: -40 },
        { width: 1_000, height: 700 },
        { width: 360, height: 240 },
      ),
    ).toEqual({
      x: 628,
      y: PREVIEW_MINI_PLAYER_EDGE_GAP,
    });
  });

  it("keeps an edge gap when the player is larger than its container", () => {
    expect(
      clampPreviewMiniPlayerPosition(
        { x: 20, y: 30 },
        { width: 200, height: 160 },
        { width: 360, height: 240 },
      ),
    ).toEqual({
      x: PREVIEW_MINI_PLAYER_EDGE_GAP,
      y: PREVIEW_MINI_PLAYER_EDGE_GAP,
    });
  });

  it("keeps the player above a growing composer inset", () => {
    expect(
      clampPreviewMiniPlayerPosition(
        { x: 500, y: 448 },
        { width: 1_000, height: 700 },
        { width: 360, height: 240 },
        160,
      ),
    ).toEqual({
      x: 500,
      y: 288,
    });
  });
});

describe("clampPreviewMiniPlayerSize", () => {
  it("allows resizing within the available chat viewport", () => {
    expect(
      clampPreviewMiniPlayerSize({ width: 520, height: 360 }, { width: 1_000, height: 700 }, 120),
    ).toEqual({ width: 520, height: 360 });
  });

  it("bounds oversized players above the composer", () => {
    expect(
      clampPreviewMiniPlayerSize(
        { width: 2_000, height: 2_000 },
        { width: 1_000, height: 700 },
        120,
      ),
    ).toEqual({ width: 976, height: 556 });
  });

  it("lets a tiny container win over the preferred minimum", () => {
    expect(
      clampPreviewMiniPlayerSize({ width: 360, height: 239 }, { width: 250, height: 180 }, 20),
    ).toEqual({ width: 226, height: 136 });
  });
});

describe("resolvePreviewMiniPlayerResize", () => {
  const container = { width: 1000, height: 800 };
  const origin = { position: { x: 400, y: 300 }, size: { width: 320, height: 200 } };

  it("grows down and right from a fixed top-left when dragging the right corner", () => {
    const next = resolvePreviewMiniPlayerResize({
      corner: "right",
      origin,
      delta: { x: 60, y: 40 },
      container,
    });
    expect(next.size).toEqual({ width: 380, height: 240 });
    expect(next.position).toEqual({ x: 400, y: 300 });
  });

  it("pins the right edge when dragging the left corner", () => {
    const next = resolvePreviewMiniPlayerResize({
      corner: "left",
      origin,
      delta: { x: -60, y: 40 },
      container,
    });
    // Dragging left widens the box; the right edge is the anchor and must not move.
    expect(next.size).toEqual({ width: 380, height: 240 });
    expect(next.position).toEqual({ x: 340, y: 300 });
    expect(next.position.x + next.size.width).toBe(origin.position.x + origin.size.width);
  });

  it("shrinks toward the anchored right edge when the left corner drags inward", () => {
    const next = resolvePreviewMiniPlayerResize({
      corner: "left",
      origin,
      delta: { x: 60, y: 0 },
      container,
    });
    expect(next.size.width).toBe(260);
    expect(next.position.x + next.size.width).toBe(origin.position.x + origin.size.width);
  });

  it("stops a left drag at the edge gap instead of walking the anchored edge", () => {
    const next = resolvePreviewMiniPlayerResize({
      corner: "left",
      origin,
      delta: { x: -10_000, y: 0 },
      container,
    });
    expect(next.position.x).toBe(PREVIEW_MINI_PLAYER_EDGE_GAP);
    // The right edge stayed put rather than being pushed across the viewport.
    expect(next.position.x + next.size.width).toBe(origin.position.x + origin.size.width);
  });

  it("honours the minimum size from either corner", () => {
    for (const corner of ["left", "right"] as const) {
      const next = resolvePreviewMiniPlayerResize({
        corner,
        origin,
        delta: { x: corner === "left" ? 10_000 : -10_000, y: -10_000 },
        container,
      });
      expect(next.size).toEqual(PREVIEW_MINI_PLAYER_MIN_SIZE);
    }
  });

  it("keeps the box clear of the composer inset while resizing", () => {
    const next = resolvePreviewMiniPlayerResize({
      corner: "right",
      origin: { position: { x: 400, y: 300 }, size: { width: 320, height: 200 } },
      delta: { x: 0, y: 10_000 },
      container,
      bottomInset: 200,
    });
    expect(next.position.y + next.size.height).toBeLessThanOrEqual(
      container.height - 200 - PREVIEW_MINI_PLAYER_EDGE_GAP,
    );
  });
});
