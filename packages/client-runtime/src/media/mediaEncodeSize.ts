import type { MediaViewport } from "@t3tools/contracts";

export interface PixelSize {
  readonly width: number;
  readonly height: number;
}

/** Never encode more than a 2560x1600 desktop's worth of pixels. */
export const MEDIA_MAX_ENCODE_PIXELS = 2_560 * 1_600;
const MIN_ENCODE_EDGE = 64;
// A modest sampling margin preserves fine strokes after the viewer resizes the video.
const VIEW_SAMPLING_MARGIN = 1.5;

/**
 * Size the encoded picture for the largest viewer, with a sampling margin
 * for text and bounds from the source and pixel budget.
 *
 * A phone shows a 2560x1600 desktop letterboxed into ~390 CSS pixels at 3x,
 * about 1170x731 device pixels. Encoding somewhat above that display size
 * avoids two resizing filters erasing thin strokes, while still sending
 * fewer pixels than the full desktop. Pinch zoom raises the need up to the
 * source itself. Encoder alignment only slightly rounds the aspect ratio.
 */
export function targetEncodeSize(input: {
  readonly source: PixelSize;
  readonly viewports: ReadonlyArray<MediaViewport>;
  readonly maxPixels?: number;
}): PixelSize {
  const { source } = input;
  let scale = input.viewports.length === 0 ? 1 : 0;
  for (const view of input.viewports) {
    const fit = Math.min(view.width / source.width, view.height / source.height);
    scale = Math.max(scale, fit * view.devicePixelRatio * view.zoom * VIEW_SAMPLING_MARGIN);
  }
  const maxPixels = input.maxPixels ?? MEDIA_MAX_ENCODE_PIXELS;
  const maxScale = Math.min(1, Math.sqrt(maxPixels / (source.width * source.height)));
  const minScale = MIN_ENCODE_EDGE / Math.min(source.width, source.height);
  scale = Math.min(maxScale, Math.max(scale, Math.min(1, minScale)));

  // Mac HEVC frames at width 1122 appeared horizontally stretched in WebKit;
  // four-pixel-aligned widths avoided that loss with the same encoder quality.
  // Height still needs only even alignment. Tiny sources may only fit width 2.
  const maxWidth = Math.min(source.width, Math.floor(maxPixels / 2));
  const widthAlignment = maxWidth >= 4 ? 4 : 2;
  const width = Math.max(
    widthAlignment,
    Math.min(
      Math.floor((source.width * scale) / widthAlignment) * widthAlignment,
      Math.floor(maxWidth / widthAlignment) * widthAlignment,
    ),
  );
  // Derive height from the aligned width, then retain the source/pixel bounds
  // when either encoder rounding would otherwise exceed them.
  const maxHeight = Math.min(source.height, Math.floor(maxPixels / width));
  const height = Math.max(
    2,
    Math.min(
      Math.round((source.height * width) / source.width / 2) * 2,
      Math.floor(maxHeight / 2) * 2,
    ),
  );
  return { width, height };
}

/**
 * Whether a new target is different enough to pay for a reconfigure (which
 * costs a key frame). Small proportional resizes keep the current size;
 * a changed source aspect ratio needs a new shape even when width is stable.
 */
export function shouldReconfigureSize(current: PixelSize | null, next: PixelSize): boolean {
  if (!current) return true;
  const aspectChange = (next.width * current.height) / (next.height * current.width);
  if (Math.abs(aspectChange - 1) > 0.02) return true;
  const changed = (before: number, after: number) =>
    after > before ? after / before > 1.08 : before / after > 1.2;
  return changed(current.width, next.width) || changed(current.height, next.height);
}
