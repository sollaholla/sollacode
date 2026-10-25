import type { MediaViewport } from "@t3tools/contracts";

export interface PixelSize {
  readonly width: number;
  readonly height: number;
}

/** Never encode more than a 2560x1600 desktop's worth of pixels. */
export const MEDIA_MAX_ENCODE_PIXELS = 2_560 * 1_600;
const MIN_ENCODE_EDGE = 64;

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

/**
 * The size to encode a `source` picture at so the largest viewer gets one
 * encoded pixel per device pixel, and no more.
 *
 * A phone shows a 2560x1600 desktop letterboxed into ~390 CSS pixels at 3x,
 * about 1170x731 device pixels; streaming it the full desktop spends five
 * times the bytes on pixels the phone throws away. Pinch zoom raises the
 * need, up to the source itself - zooming past 1:1 has nothing more to show.
 * Aspect ratio is the source's, so pointer mapping stays exact.
 */
export function targetEncodeSize(input: {
  readonly source: PixelSize;
  readonly viewports: ReadonlyArray<MediaViewport>;
  readonly maxPixels?: number;
}): PixelSize {
  const { source } = input;
  if (input.viewports.length === 0)
    return { width: even(source.width), height: even(source.height) };
  let scale = 0;
  for (const view of input.viewports) {
    const fit = Math.min(view.width / source.width, view.height / source.height);
    scale = Math.max(scale, fit * view.devicePixelRatio * view.zoom);
  }
  const maxPixels = input.maxPixels ?? MEDIA_MAX_ENCODE_PIXELS;
  scale = Math.min(1, scale, Math.sqrt(maxPixels / (source.width * source.height)));
  const minScale = MIN_ENCODE_EDGE / Math.min(source.width, source.height);
  scale = Math.max(scale, Math.min(1, minScale));
  return { width: even(source.width * scale), height: even(source.height * scale) };
}

/**
 * Whether a new target is different enough to pay for a reconfigure (which
 * costs a key frame). Small resizes - a scrollbar appearing, a few pixels of
 * pinch - keep the current size.
 */
export function shouldReconfigureSize(current: PixelSize | null, next: PixelSize): boolean {
  if (!current) return true;
  if (next.width > current.width) return next.width / current.width > 1.08;
  return current.width / next.width > 1.2;
}
