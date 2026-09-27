/**
 * Zoom state for an image centred in a viewport, applied as
 * `translate(x, y) scale(scale)` around the image's own centre. Points are
 * measured from the viewport's centre, which is where the unzoomed image sits.
 */
export interface ImageZoom {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

export interface ImageZoomPoint {
  readonly x: number;
  readonly y: number;
}

/** The image's unzoomed size and the viewport it is shown in, in CSS pixels. */
export interface ImageZoomBounds {
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

export const IMAGE_ZOOM_RESET: ImageZoom = { scale: 1, x: 0, y: 0 };
export const IMAGE_ZOOM_MAX = 6;
/** Where a double tap on an unzoomed image goes. */
export const IMAGE_ZOOM_DOUBLE_TAP_SCALE = 2.5;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function isImageZoomed(zoom: ImageZoom): boolean {
  return zoom.scale > 1;
}

/**
 * Keeps the scale between fit and the maximum, and the image covering the
 * viewport: an image smaller than the viewport on an axis stays centred on
 * it, and a larger one can pan only until its edge reaches the viewport's.
 */
export function clampImageZoom(zoom: ImageZoom, bounds: ImageZoomBounds): ImageZoom {
  const scale = clamp(zoom.scale, 1, IMAGE_ZOOM_MAX);
  const maxX = Math.max(0, (bounds.imageWidth * scale - bounds.viewportWidth) / 2);
  const maxY = Math.max(0, (bounds.imageHeight * scale - bounds.viewportHeight) / 2);
  return {
    scale,
    x: maxX === 0 ? 0 : clamp(zoom.x, -maxX, maxX),
    y: maxY === 0 ? 0 : clamp(zoom.y, -maxY, maxY),
  };
}

/** Scales to `scale` while the image point under `focus` stays under it. */
export function zoomImageAt(
  zoom: ImageZoom,
  focus: ImageZoomPoint,
  scale: number,
  bounds: ImageZoomBounds,
): ImageZoom {
  const next = clamp(scale, 1, IMAGE_ZOOM_MAX);
  const imageX = (focus.x - zoom.x) / zoom.scale;
  const imageY = (focus.y - zoom.y) / zoom.scale;
  return clampImageZoom(
    { scale: next, x: focus.x - next * imageX, y: focus.y - next * imageY },
    bounds,
  );
}

export interface ImagePinchStart {
  readonly zoom: ImageZoom;
  readonly midpoint: ImageZoomPoint;
  readonly distance: number;
}

/**
 * Two fingers move and spread together: the image point that was between
 * them when the pinch began follows their midpoint, scaled by how far they
 * have spread since.
 */
export function pinchImageZoom(
  start: ImagePinchStart,
  midpoint: ImageZoomPoint,
  distance: number,
  bounds: ImageZoomBounds,
): ImageZoom {
  const scale = clamp(
    start.zoom.scale * (start.distance > 0 ? distance / start.distance : 1),
    1,
    IMAGE_ZOOM_MAX,
  );
  const imageX = (start.midpoint.x - start.zoom.x) / start.zoom.scale;
  const imageY = (start.midpoint.y - start.zoom.y) / start.zoom.scale;
  return clampImageZoom(
    { scale, x: midpoint.x - scale * imageX, y: midpoint.y - scale * imageY },
    bounds,
  );
}

/** A double tap zooms in on the tapped point, or back out when already zoomed. */
export function toggleImageZoomAt(
  zoom: ImageZoom,
  focus: ImageZoomPoint,
  bounds: ImageZoomBounds,
): ImageZoom {
  return isImageZoomed(zoom)
    ? IMAGE_ZOOM_RESET
    : zoomImageAt(zoom, focus, IMAGE_ZOOM_DOUBLE_TAP_SCALE, bounds);
}
