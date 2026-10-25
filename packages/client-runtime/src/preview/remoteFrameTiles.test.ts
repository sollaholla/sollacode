import { describe, expect, it } from "vite-plus/test";

import { changedShare, changedTiles, rectsArea, tileRects } from "./remoteFrameTiles.ts";

const picture = (width: number, height: number, fill = 0xffffffff) =>
  new Uint32Array(width * height).fill(fill);

const paint = (
  pixels: Uint32Array,
  width: number,
  rect: { x: number; y: number; width: number; height: number },
  value = 0xff000000,
) => {
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) pixels[y * width + x] = value;
  }
};

describe("changedTiles", () => {
  it("finds nothing when the pictures are identical", () => {
    const grid = changedTiles(picture(100, 70), picture(100, 70), 100, 70);
    expect(grid.columns).toBe(4);
    expect(grid.rows).toBe(3);
    expect(changedShare(grid)).toBe(0);
  });

  it("marks exactly the tiles a change touches, including partial edge tiles", () => {
    const previous = picture(100, 70);
    const next = picture(100, 70);
    // One pixel in the bottom-right partial tile, and a run across two tiles.
    paint(next, 100, { x: 99, y: 69, width: 1, height: 1 });
    paint(next, 100, { x: 30, y: 5, width: 4, height: 1 });
    const grid = changedTiles(previous, next, 100, 70);
    const dirty = Array.from(grid.dirty.entries())
      .filter(([, flag]) => flag === 1)
      .map(([index]) => index);
    expect(dirty).toEqual([0, 1, 11]);
  });
});

describe("tileRects", () => {
  it("covers a block of changed tiles with one rectangle clipped to the picture", () => {
    const previous = picture(100, 70);
    const next = picture(100, 70);
    paint(next, 100, { x: 40, y: 40, width: 60, height: 30 });
    const rects = tileRects(changedTiles(previous, next, 100, 70), 100, 70, 16);
    expect(rects).toEqual([{ x: 32, y: 32, width: 68, height: 38 }]);
  });

  it("keeps separate changes separate", () => {
    const previous = picture(200, 200);
    const next = picture(200, 200);
    paint(next, 200, { x: 0, y: 0, width: 10, height: 10 });
    paint(next, 200, { x: 150, y: 150, width: 10, height: 10 });
    const rects = tileRects(changedTiles(previous, next, 200, 200), 200, 200, 16);
    expect(rects).toEqual([
      { x: 0, y: 0, width: 32, height: 32 },
      { x: 128, y: 128, width: 32, height: 32 },
    ]);
    expect(rectsArea(rects)).toBe(2 * 32 * 32);
  });

  it("falls back to one bounding box past the rectangle limit", () => {
    const previous = picture(256, 32);
    const next = picture(256, 32);
    // Every other tile changes: four separate runs.
    for (let tile = 0; tile < 8; tile += 2)
      paint(next, 256, { x: tile * 32, y: 0, width: 1, height: 1 });
    const rects = tileRects(changedTiles(previous, next, 256, 32), 256, 32, 3);
    expect(rects).toEqual([{ x: 0, y: 0, width: 224, height: 32 }]);
  });
});
