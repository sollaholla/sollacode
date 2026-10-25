/**
 * Deterministic synthetic "desktop" for the remote-control benchmark.
 *
 * Every pixel is drawn with integer-aligned `fillRect`/`drawImage` at 1:1 or
 * `putImageData`, never with anti-aliased text or arcs, so the same frame
 * number renders to the same pixels in Chromium (the host) and WebKit (the
 * phone viewer). That is what lets a viewer rebuild the ground truth for any
 * frame it received and score legibility against it.
 *
 * Each frame carries its number in a strip of black and white blocks in the
 * top-left corner. A viewer reads the strip back from whatever it displayed
 * and joins it to the host's draw log to get glass-to-glass latency.
 */

export const SOURCE_WIDTH = 2560;
export const SOURCE_HEIGHT = 1600;

export type BenchScene = "idle" | "caret" | "typing" | "scroll" | "video" | "input";

/** Milliseconds between scene repaints; every repaint is a new frame number. */
export const SCENE_REPAINT_MS: Record<BenchScene, number> = {
  // Truly static: no marker changes or caret blink.
  idle: Number.POSITIVE_INFINITY,
  caret: 530,
  // About nine characters a second.
  typing: 110,
  scroll: 1_000 / 30,
  video: 1_000 / 30,
  // Driven by remote input, not a timer.
  input: Number.POSITIVE_INFINITY,
};

const STRIP_BLOCK = 36;
const STRIP_DATA_BITS = 20;
const STRIP_BLOCKS = STRIP_DATA_BITS + 2;
export const STRIP_HEIGHT = STRIP_BLOCK;
export const STRIP_WIDTH = STRIP_BLOCK * STRIP_BLOCKS;

const CELL_W = 18;
const CELL_H = 30;
const GLYPH_SCALE = 3;
const TEXT_LEFT = 24;
const TEXT_TOP = 72;
const COLUMNS = Math.floor((SOURCE_WIDTH - TEXT_LEFT * 2) / CELL_W);
const ROWS = Math.floor((SOURCE_HEIGHT - TEXT_TOP - 24) / CELL_H);
const DOCUMENT_ROWS = 2_400;
const BACKGROUND = "#1e1e1e";
const PALETTE = ["#d4d4d4", "#569cd6", "#ce9178", "#6a9955", "#c586c0", "#dcdcaa", "#4ec9b0"];

/** Mulberry32: tiny, seedable, identical in every engine. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A 5x7 glyph per character code, procedurally shaped like letters. */
function glyphBits(code: number): number[] {
  const random = prng(code * 7_919 + 13);
  const rows: number[] = [];
  for (let row = 0; row < 7; row += 1) {
    let bits = 0;
    for (let column = 0; column < 5; column += 1) {
      // Mostly vertical strokes with some crossbars, like real type.
      const stroke = column === 0 || column === 4 ? 0.55 : 0.3;
      const crossbar = row === 0 || row === 3 || row === 6 ? 0.25 : 0;
      if (random() < stroke + crossbar) bits |= 1 << column;
    }
    rows.push(bits);
  }
  return rows;
}

interface GlyphAtlas {
  readonly canvas: OffscreenCanvas;
  /** Atlas x for (colour index, glyph index). */
  readonly cell: (colour: number, glyph: number) => number;
}

const GLYPHS = 64;
let atlasCache: GlyphAtlas | null = null;

function glyphAtlas(): GlyphAtlas {
  if (atlasCache) return atlasCache;
  const canvas = new OffscreenCanvas(CELL_W * GLYPHS, CELL_H * PALETTE.length);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let colour = 0; colour < PALETTE.length; colour += 1) {
    ctx.fillStyle = PALETTE[colour]!;
    for (let glyph = 0; glyph < GLYPHS; glyph += 1) {
      const bits = glyphBits(glyph + 33);
      for (let row = 0; row < 7; row += 1) {
        for (let column = 0; column < 5; column += 1) {
          if ((bits[row]! >> column) & 1) {
            ctx.fillRect(
              glyph * CELL_W + 2 + column * GLYPH_SCALE,
              colour * CELL_H + 4 + row * GLYPH_SCALE,
              GLYPH_SCALE,
              GLYPH_SCALE,
            );
          }
        }
      }
    }
  }
  atlasCache = { canvas, cell: (_colour, glyph) => glyph * CELL_W };
  return atlasCache;
}

const documentRows = new Map<number, Int16Array>();

/**
 * One document line: per column, `colour * GLYPHS + glyph`, or -1 for a
 * space. Indented lines of 2-9 character words, each word one colour.
 */
function documentRow(row: number): Int16Array {
  const cached = documentRows.get(row);
  if (cached) return cached;
  const cells = new Int16Array(COLUMNS).fill(-1);
  const random = prng(row * 104_729 + 7);
  const indent = Math.floor(random() * 6) * 2;
  const length = indent + 8 + Math.floor(random() * (COLUMNS - indent - 30));
  let cursor = indent;
  let word = 0;
  while (cursor < length) {
    const wordLength = 2 + Math.floor(prng(row * 31 + word * 7)() * 8);
    const colour = Math.floor(prng(row * 131 + word)() * PALETTE.length);
    for (let column = cursor; column < Math.min(length, cursor + wordLength); column += 1) {
      cells[column] = colour * GLYPHS + Math.floor(prng(row * 977 + column * 13)() * GLYPHS);
    }
    cursor += wordLength + 1;
    word += 1;
  }
  documentRows.set(row, cells);
  return cells;
}

function drawDocumentRows(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  firstRow: number,
  pixelOffset: number,
  top: number,
  bottom: number,
): void {
  const atlas = glyphAtlas();
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, top, SOURCE_WIDTH, bottom - top);
  const rows = Math.ceil((bottom - top) / CELL_H) + 1;
  for (let index = 0; index < rows; index += 1) {
    const row = firstRow + index;
    const y = top + index * CELL_H - pixelOffset;
    if (y + CELL_H <= top || y >= bottom) continue;
    const srcTop = Math.max(0, top - y);
    const srcBottom = Math.min(CELL_H, bottom - y);
    const cells = documentRow(row % DOCUMENT_ROWS);
    for (let column = 0; column < COLUMNS; column += 1) {
      const encoded = cells[column]!;
      if (encoded < 0) continue;
      const cell = { colour: Math.floor(encoded / GLYPHS), glyph: encoded % GLYPHS };
      ctx.drawImage(
        atlas.canvas,
        atlas.cell(cell.colour, cell.glyph),
        cell.colour * CELL_H + srcTop,
        CELL_W,
        srcBottom - srcTop,
        TEXT_LEFT + column * CELL_W,
        y + srcTop,
        CELL_W,
        srcBottom - srcTop,
      );
    }
  }
}

function drawChrome(ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D): void {
  // A title bar and a sidebar edge: large flat areas, like a real desktop.
  ctx.fillStyle = "#2d2d30";
  ctx.fillRect(0, 0, SOURCE_WIDTH, TEXT_TOP - 12);
  ctx.fillStyle = "#3c3c3c";
  ctx.fillRect(0, TEXT_TOP - 12, SOURCE_WIDTH, 4);
  ctx.fillStyle = "#007acc";
  ctx.fillRect(0, SOURCE_HEIGHT - 20, SOURCE_WIDTH, 20);
}

/** Frame-number strip: [white][black] + 16 bits of number + 4-bit checksum. */
export function drawFrameStrip(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  frame: number,
): void {
  const value = frame & 0xffff;
  const checksum = popcount(value) & 0xf;
  const bits = value | (checksum << 16);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, STRIP_BLOCK, STRIP_BLOCK);
  ctx.fillStyle = "#000000";
  ctx.fillRect(STRIP_BLOCK, 0, STRIP_BLOCK, STRIP_BLOCK);
  for (let bit = 0; bit < STRIP_DATA_BITS; bit += 1) {
    ctx.fillStyle = (bits >> bit) & 1 ? "#ffffff" : "#000000";
    ctx.fillRect((bit + 2) * STRIP_BLOCK, 0, STRIP_BLOCK, STRIP_BLOCK);
  }
}

function popcount(value: number): number {
  let count = 0;
  let rest = value;
  while (rest) {
    count += rest & 1;
    rest >>>= 1;
  }
  return count;
}

/**
 * Decodes block-average lumas (one per strip block, left to right) back to a
 * frame number, or null when the markers or checksum do not match.
 */
export function decodeFrameStrip(lumas: ArrayLike<number>): number | null {
  if (lumas.length < STRIP_BLOCKS) return null;
  if (lumas[0]! < 160 || lumas[1]! > 96) return null;
  let bits = 0;
  for (let bit = 0; bit < STRIP_DATA_BITS; bit += 1) {
    const luma = lumas[bit + 2]!;
    if (luma > 96 && luma < 160) return null;
    if (luma >= 160) bits |= 1 << bit;
  }
  const value = bits & 0xffff;
  return bits >>> 16 === (popcount(value) & 0xf) ? value : null;
}

const STRIP_SAMPLER = { canvas: null as OffscreenCanvas | null };

/**
 * Reads the frame number out of a displayed source (video element, image,
 * VideoFrame, canvas) whose pixels span `sourceWidth` x `sourceHeight`.
 */
export function readFrameNumber(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
): number | null {
  if (sourceWidth <= 0 || sourceHeight <= 0) return null;
  STRIP_SAMPLER.canvas ??= new OffscreenCanvas(STRIP_BLOCKS * 4, 4);
  const sampler = STRIP_SAMPLER.canvas;
  const ctx = sampler.getContext("2d", { willReadFrequently: true })!;
  const scaleX = sourceWidth / SOURCE_WIDTH;
  const scaleY = sourceHeight / SOURCE_HEIGHT;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(
    source,
    0,
    0,
    STRIP_WIDTH * scaleX,
    STRIP_HEIGHT * scaleY,
    0,
    0,
    sampler.width,
    sampler.height,
  );
  const pixels = ctx.getImageData(0, 1, sampler.width, 1).data;
  const lumas: number[] = [];
  for (let block = 0; block < STRIP_BLOCKS; block += 1) {
    // The middle two of each block's four samples, away from blurred edges.
    let sum = 0;
    for (const offset of [1, 2]) {
      const index = (block * 4 + offset) * 4;
      sum += 0.299 * pixels[index]! + 0.587 * pixels[index + 1]! + 0.114 * pixels[index + 2]!;
    }
    lumas.push(sum / 2);
  }
  return decodeFrameStrip(lumas);
}

/** Pre-rendered texture for the "video" scene: smooth value noise, in colour. */
let textureCache: OffscreenCanvas | null = null;
function videoTexture(): OffscreenCanvas {
  if (textureCache) return textureCache;
  const size = 2_048;
  const grid = 32;
  const random = prng(42);
  const lattice = Array.from({ length: (grid + 1) * (grid + 1) * 3 }, () => random() * 255);
  const image = new ImageData(size, size);
  const cell = size / grid;
  for (let y = 0; y < size; y += 1) {
    const gy = Math.floor(y / cell);
    const fy = (y % cell) / cell;
    const sy = fy * fy * (3 - 2 * fy);
    for (let x = 0; x < size; x += 1) {
      const gx = Math.floor(x / cell);
      const fx = (x % cell) / cell;
      const sx = fx * fx * (3 - 2 * fx);
      for (let channel = 0; channel < 3; channel += 1) {
        const at = (i: number, j: number) => lattice[((j * (grid + 1) + i) * 3 + channel) | 0]!;
        const top = at(gx, gy) * (1 - sx) + at(gx + 1, gy) * sx;
        const bottom = at(gx, gy + 1) * (1 - sx) + at(gx + 1, gy + 1) * sx;
        // Fine grain on top of the smooth field, like sensor noise in video.
        const grain = ((x * 7 + y * 13) % 17) - 8;
        image.data[(y * size + x) * 4 + channel] = Math.max(
          0,
          Math.min(255, top * (1 - sy) + bottom * sy + grain),
        );
      }
      image.data[(y * size + x) * 4 + 3] = 255;
    }
  }
  textureCache = new OffscreenCanvas(size, size);
  textureCache.getContext("2d")!.putImageData(image, 0, 0);
  return textureCache;
}

const VIDEO_X = 480;
const VIDEO_Y = 300;
const VIDEO_W = 1_600;
const VIDEO_H = 900;

function drawVideoWindow(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  frame: number,
): void {
  const texture = videoTexture();
  const t = frame / 30;
  const ax = Math.round(200 + 180 * Math.sin(t * 0.7));
  const ay = Math.round(300 + 200 * Math.cos(t * 0.5));
  ctx.drawImage(texture, ax, ay, VIDEO_W, VIDEO_H, VIDEO_X, VIDEO_Y, VIDEO_W, VIDEO_H);
  // A second layer drifting the other way, so motion is not one global pan.
  const bx = Math.round(260 + 220 * Math.cos(t * 0.9));
  const by = Math.round(180 + 160 * Math.sin(t * 1.1));
  for (let band = 0; band < 6; band += 1) {
    const bandY = VIDEO_Y + band * 150 + ((frame * 5 + band * 37) % 150);
    const height = Math.min(70, VIDEO_Y + VIDEO_H - bandY);
    if (height <= 0) continue;
    ctx.drawImage(
      texture,
      bx + band * 90,
      by + band * 40,
      VIDEO_W,
      height,
      VIDEO_X,
      bandY,
      VIDEO_W,
      height,
    );
  }
  for (let index = 0; index < 8; index += 1) {
    const x = VIDEO_X + Math.round((frame * (3 + index) * 7 + index * 211) % (VIDEO_W - 120));
    const y = VIDEO_Y + Math.round((frame * (2 + index) * 5 + index * 97) % (VIDEO_H - 120));
    ctx.fillStyle = PALETTE[index % PALETTE.length]!;
    ctx.fillRect(x, y, 120, 120);
  }
}

const TYPING_ROW = 30;
const TYPING_COLUMN = 8;

function caretPosition(scene: BenchScene, frame: number): { x: number; y: number } {
  if (scene === "typing" || scene === "input") {
    const column = TYPING_COLUMN + (frame % (COLUMNS - TYPING_COLUMN - 4));
    const row = TYPING_ROW + Math.floor(frame / (COLUMNS - TYPING_COLUMN - 4)) * 2;
    return { x: TEXT_LEFT + column * CELL_W, y: TEXT_TOP + (row % ROWS) * CELL_H };
  }
  return { x: TEXT_LEFT + 40 * CELL_W, y: TEXT_TOP + 20 * CELL_H };
}

function typedGlyph(index: number): { glyph: number; colour: number } {
  return { glyph: Math.floor(prng(index * 13 + 5)() * GLYPHS), colour: 0 };
}

/**
 * Renders frame `frame` of `scene` from scratch. The host draws frames
 * incrementally with `paintFrame`; both must land on identical pixels.
 */
export function renderFrame(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  scene: BenchScene,
  frame: number,
): void {
  const scrollPixels = scene === "scroll" ? frame * 16 : 0;
  drawChrome(ctx);
  drawDocumentRows(
    ctx,
    Math.floor(scrollPixels / CELL_H),
    scrollPixels % CELL_H,
    TEXT_TOP - 8,
    SOURCE_HEIGHT - 20,
  );
  if (scene === "typing" || scene === "input") {
    for (let index = 0; index < frame; index += 1) drawTypedCharacter(ctx, scene, index);
  }
  if (scene === "video") drawVideoWindow(ctx, frame);
  drawCaret(ctx, scene, frame);
  drawFrameStrip(ctx, frame);
}

function drawTypedCharacter(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  scene: BenchScene,
  index: number,
): void {
  const at = caretPosition(scene, index);
  const cell = typedGlyph(index);
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(at.x, at.y, CELL_W, CELL_H);
  ctx.drawImage(
    glyphAtlas().canvas,
    glyphAtlas().cell(cell.colour, cell.glyph),
    cell.colour * CELL_H,
    CELL_W,
    CELL_H,
    at.x,
    at.y,
    CELL_W,
    CELL_H,
  );
}

function drawCaret(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  scene: BenchScene,
  frame: number,
): void {
  const at = caretPosition(scene, frame);
  const visible = scene !== "caret" || frame % 2 === 0;
  ctx.fillStyle = visible ? "#aeafad" : BACKGROUND;
  ctx.fillRect(at.x, at.y + 2, 3, CELL_H - 4);
}

/**
 * Advances the host canvas from `frame - 1` to `frame` by drawing only what
 * changed, as a real screen would. Frame 0 is a full render.
 */
export function paintFrame(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  scene: BenchScene,
  frame: number,
): void {
  if (frame === 0) {
    renderFrame(ctx, scene, 0);
    return;
  }
  switch (scene) {
    case "idle":
    case "caret":
      drawCaret(ctx, scene, frame);
      break;
    case "typing":
    case "input": {
      // The previous caret cell becomes the typed character.
      drawTypedCharacter(ctx, scene, frame - 1);
      drawCaret(ctx, scene, frame);
      break;
    }
    case "scroll": {
      const scrollPixels = frame * 16;
      drawDocumentRows(
        ctx,
        Math.floor(scrollPixels / CELL_H),
        scrollPixels % CELL_H,
        TEXT_TOP - 8,
        SOURCE_HEIGHT - 20,
      );
      drawCaret(ctx, scene, frame);
      break;
    }
    case "video":
      drawVideoWindow(ctx, frame);
      break;
  }
  drawFrameStrip(ctx, frame);
}

/** Luma of an RGBA buffer. */
export function lumaOf(rgba: Uint8ClampedArray, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let index = 0; index < out.length; index += 1) {
    out[index] =
      0.299 * rgba[index * 4]! + 0.587 * rgba[index * 4 + 1]! + 0.114 * rgba[index * 4 + 2]!;
  }
  return out;
}

/**
 * Exact area-average downscale: every output pixel is the mean of the source
 * area it covers. The reference for "what a perfect display at this size
 * shows", independent of any browser's or encoder's resampling filter.
 */
export function boxDownscale(
  source: Float32Array,
  width: number,
  height: number,
  outWidth: number,
  outHeight: number,
): Float32Array {
  const pass = (
    input: Float32Array,
    inLength: number,
    outLength: number,
    lines: number,
    stride: (line: number, index: number) => number,
    outStride: (line: number, index: number) => number,
    output: Float32Array,
  ) => {
    const ratio = inLength / outLength;
    for (let out = 0; out < outLength; out += 1) {
      const start = out * ratio;
      const end = start + ratio;
      const first = Math.floor(start);
      const last = Math.min(inLength - 1, Math.ceil(end) - 1);
      for (let line = 0; line < lines; line += 1) {
        let sum = 0;
        for (let index = first; index <= last; index += 1) {
          const weight = Math.min(end, index + 1) - Math.max(start, index);
          if (weight > 0) sum += input[stride(line, index)]! * weight;
        }
        output[outStride(line, out)] = sum / ratio;
      }
    }
  };
  const horizontal = new Float32Array(outWidth * height);
  pass(
    source,
    width,
    outWidth,
    height,
    (line, index) => line * width + index,
    (line, index) => line * outWidth + index,
    horizontal,
  );
  const result = new Float32Array(outWidth * outHeight);
  pass(
    horizontal,
    height,
    outHeight,
    outWidth,
    (line, index) => index * outWidth + line,
    (line, index) => index * outWidth + line,
    result,
  );
  return result;
}

/** PSNR in dB between two luma planes, skipping the strip rows at the top. */
export function planePsnr(
  received: Float32Array,
  truth: Float32Array,
  width: number,
  height: number,
  skipTopRows: number,
): number {
  let squared = 0;
  let count = 0;
  for (let index = skipTopRows * width; index < width * height; index += 1) {
    const difference = received[index]! - truth[index]!;
    squared += difference * difference;
    count += 1;
  }
  const mse = squared / Math.max(1, count);
  return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
}

/** PSNR in dB over luma, skipping the strip rows at the top of the picture. */
export function lumaPsnr(
  received: Uint8ClampedArray,
  truth: Uint8ClampedArray,
  width: number,
  height: number,
  skipTopRows: number,
): number {
  let squared = 0;
  let count = 0;
  for (let y = skipTopRows; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const a =
        0.299 * received[index]! + 0.587 * received[index + 1]! + 0.114 * received[index + 2]!;
      const b = 0.299 * truth[index]! + 0.587 * truth[index + 1]! + 0.114 * truth[index + 2]!;
      squared += (a - b) * (a - b);
      count += 1;
    }
  }
  const mse = squared / Math.max(1, count);
  return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
}
