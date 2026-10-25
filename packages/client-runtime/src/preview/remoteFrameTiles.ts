/**
 * Finding what changed between two pictures of a browser tab, for the
 * desktop that streams it. Pure arithmetic over RGBA pixels, so it runs in a
 * worker and in tests alike; the encoder around it decodes and encodes.
 *
 * Tiles are aligned to 16 pixels because the pictures come from JPEG: a
 * region that did not change decodes to exactly the same pixels, block for
 * block, so an exact comparison finds real changes and nothing else.
 */

export const REMOTE_FRAME_TILE_SIZE = 32;

export interface TileRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface TileGrid {
  readonly columns: number;
  readonly rows: number;
  /** One flag per tile, row-major: 1 when any pixel in it changed. */
  readonly dirty: Uint8Array;
}

/**
 * Marks every tile whose pixels differ. `previous` and `next` are the same
 * size, one 32-bit RGBA value per pixel.
 */
export function changedTiles(
  previous: Uint32Array,
  next: Uint32Array,
  width: number,
  height: number,
  tileSize: number = REMOTE_FRAME_TILE_SIZE,
): TileGrid {
  const columns = Math.ceil(width / tileSize);
  const rows = Math.ceil(height / tileSize);
  const dirty = new Uint8Array(columns * rows);
  for (let row = 0; row < rows; row++) {
    const top = row * tileSize;
    const bottom = Math.min(height, top + tileSize);
    for (let column = 0; column < columns; column++) {
      const left = column * tileSize;
      const right = Math.min(width, left + tileSize);
      search: for (let y = top; y < bottom; y++) {
        const offset = y * width;
        for (let x = left; x < right; x++) {
          if (previous[offset + x] !== next[offset + x]) {
            dirty[row * columns + column] = 1;
            break search;
          }
        }
      }
    }
  }
  return { columns, rows, dirty };
}

/** Share of tiles that changed, 0..1. */
export function changedShare(grid: TileGrid): number {
  let count = 0;
  for (const flag of grid.dirty) count += flag;
  return grid.dirty.length === 0 ? 0 : count / grid.dirty.length;
}

/**
 * Covers the changed tiles with few rectangles: runs of changed tiles in a
 * row, stacked into one rectangle while the run below spans the same
 * columns. Each rectangle becomes one small JPEG, and each JPEG carries a
 * header of a few hundred bytes, so fewer is cheaper. Past `maxRects` the
 * tightest single box around every change is returned instead.
 */
export function tileRects(
  grid: TileGrid,
  width: number,
  height: number,
  maxRects: number,
  tileSize: number = REMOTE_FRAME_TILE_SIZE,
): ReadonlyArray<TileRect> {
  interface Open {
    readonly start: number;
    readonly end: number;
    readonly firstRow: number;
    lastRow: number;
  }
  const finished: Array<Open> = [];
  let open: Array<Open> = [];
  for (let row = 0; row < grid.rows; row++) {
    const runs: Array<{ start: number; end: number }> = [];
    let column = 0;
    while (column < grid.columns) {
      if (grid.dirty[row * grid.columns + column] === 0) {
        column++;
        continue;
      }
      const start = column;
      while (column < grid.columns && grid.dirty[row * grid.columns + column] === 1) column++;
      runs.push({ start, end: column });
    }
    const stillOpen: Array<Open> = [];
    for (const run of runs) {
      const above = open.find((rect) => rect.start === run.start && rect.end === run.end);
      if (above !== undefined) {
        above.lastRow = row;
        stillOpen.push(above);
      } else {
        stillOpen.push({ start: run.start, end: run.end, firstRow: row, lastRow: row });
      }
    }
    for (const rect of open) if (!stillOpen.includes(rect)) finished.push(rect);
    open = stillOpen;
  }
  finished.push(...open);
  const toPixels = (rect: Open): TileRect => {
    const x = rect.start * tileSize;
    const y = rect.firstRow * tileSize;
    return {
      x,
      y,
      width: Math.min(width, rect.end * tileSize) - x,
      height: Math.min(height, (rect.lastRow + 1) * tileSize) - y,
    };
  };
  const rects = finished.map(toPixels).sort((left, right) => left.y - right.y || left.x - right.x);
  if (rects.length <= maxRects) return rects;
  let left = width;
  let top = height;
  let right = 0;
  let bottom = 0;
  for (const rect of rects) {
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.width);
    bottom = Math.max(bottom, rect.y + rect.height);
  }
  return [{ x: left, y: top, width: right - left, height: bottom - top }];
}

/** Pixel area of a set of rectangles that do not overlap. */
export const rectsArea = (rects: ReadonlyArray<TileRect>) =>
  rects.reduce((total, rect) => total + rect.width * rect.height, 0);
