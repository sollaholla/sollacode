import type { MediaRegion, MediaViewport } from "@t3tools/contracts";

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
  /** The crop being encoded; the bounds below then apply to it, not the whole source. */
  readonly region?: MediaRegion | null;
  readonly maxPixels?: number;
}): PixelSize {
  let scale = input.viewports.length === 0 ? 1 : 0;
  for (const view of input.viewports) {
    const fit = Math.min(view.width / input.source.width, view.height / input.source.height);
    scale = Math.max(scale, fit * view.devicePixelRatio * view.zoom * VIEW_SAMPLING_MARGIN);
  }
  const source = input.region
    ? {
        width: input.source.width * input.region.width,
        height: input.source.height * input.region.height,
      }
    : input.source;
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

/** Encoded around the visible part on every side, so a small pan is already sharp. */
const REGION_PAN_MARGIN = 0.15;
/** A crop this close to the whole picture saves too little to be worth it. */
const REGION_MAX_AREA = 0.75;
/** How much larger than needed the current crop may be before it is cut again. */
const REGION_MAX_SLACK = 1.4;
const REGION_MATCH_TOLERANCE = 0.001;

const regionArea = (region: MediaRegion) => region.width * region.height;

const regionContains = (outer: MediaRegion, inner: MediaRegion) =>
  inner.x >= outer.x - REGION_MATCH_TOLERANCE &&
  inner.y >= outer.y - REGION_MATCH_TOLERANCE &&
  inner.x + inner.width <= outer.x + outer.width + REGION_MATCH_TOLERANCE &&
  inner.y + inner.height <= outer.y + outer.height + REGION_MATCH_TOLERANCE;

export function sameMediaRegion(left: MediaRegion | null, right: MediaRegion | null): boolean {
  if (!left || !right) return left === right;
  return (
    Math.abs(left.x - right.x) <= REGION_MATCH_TOLERANCE &&
    Math.abs(left.y - right.y) <= REGION_MATCH_TOLERANCE &&
    Math.abs(left.width - right.width) <= REGION_MATCH_TOLERANCE &&
    Math.abs(left.height - right.height) <= REGION_MATCH_TOLERANCE
  );
}

/**
 * The crop to encode, or null for the whole picture.
 *
 * One encoder serves every viewer, so the crop has to cover all of them, and a
 * viewer that reports no region (not magnified, or too old to show a crop)
 * keeps the whole picture. Each new crop costs a key frame, so the current one
 * stays while it still covers what is on screen and is not much too large.
 */
export function targetEncodeRegion(input: {
  readonly viewports: ReadonlyArray<MediaViewport>;
  readonly current: MediaRegion | null;
}): MediaRegion | null {
  if (input.viewports.length === 0) return null;
  let left = 1;
  let top = 1;
  let right = 0;
  let bottom = 0;
  for (const view of input.viewports) {
    if (!view.region) return null;
    left = Math.min(left, view.region.x);
    top = Math.min(top, view.region.y);
    right = Math.max(right, view.region.x + view.region.width);
    bottom = Math.max(bottom, view.region.y + view.region.height);
  }
  const visible = { x: left, y: top, width: right - left, height: bottom - top };
  if (visible.width <= 0 || visible.height <= 0) return null;
  const axis = (start: number, size: number) => {
    const grown = Math.min(1, size * (1 + 2 * REGION_PAN_MARGIN));
    const from = Math.min(1 - grown, Math.max(0, start - size * REGION_PAN_MARGIN));
    return { from, size: grown };
  };
  const across = axis(visible.x, visible.width);
  const down = axis(visible.y, visible.height);
  const wanted = { x: across.from, y: down.from, width: across.size, height: down.size };
  if (regionArea(wanted) >= REGION_MAX_AREA) return null;
  const { current } = input;
  if (
    current &&
    regionContains(current, visible) &&
    regionArea(current) <= regionArea(wanted) * REGION_MAX_SLACK
  ) {
    return current;
  }
  return wanted;
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
