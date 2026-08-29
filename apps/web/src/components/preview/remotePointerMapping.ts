export interface RemoteFrameGeometry {
  /** The `<img>` element's box, in client coordinates. */
  readonly element: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  /** The captured frame's size, in device pixels. */
  readonly frame: { readonly width: number; readonly height: number };
  /** The guest's viewport, in CSS pixels. */
  readonly viewport: { readonly width: number; readonly height: number };
}

/**
 * Turns a point on the mirrored picture into a point on the page.
 *
 * The frame is letterboxed: it is painted `object-contain`, so it is centred
 * inside the element with bars on whichever axis has slack, and it arrives in
 * device pixels while the guest is driven in CSS pixels. Both have to be undone
 * or a click lands somewhere the person did not aim.
 *
 * Returns null for a point in the letterbox, which is off the page entirely,
 * and for degenerate geometry rather than dividing by zero and sending NaN to
 * the host.
 */
export function mapRemotePointerToViewport(
  point: { readonly clientX: number; readonly clientY: number },
  geometry: RemoteFrameGeometry,
): { readonly x: number; readonly y: number } | null {
  const { element, frame, viewport } = geometry;
  if (frame.width <= 0 || frame.height <= 0) return null;
  if (element.width <= 0 || element.height <= 0) return null;
  if (viewport.width <= 0 || viewport.height <= 0) return null;

  const scale = Math.min(element.width / frame.width, element.height / frame.height);
  const paintedWidth = frame.width * scale;
  const paintedHeight = frame.height * scale;
  const originX = element.x + (element.width - paintedWidth) / 2;
  const originY = element.y + (element.height - paintedHeight) / 2;

  const fractionX = (point.clientX - originX) / paintedWidth;
  const fractionY = (point.clientY - originY) / paintedHeight;
  if (fractionX < 0 || fractionX > 1 || fractionY < 0 || fractionY > 1) return null;

  return {
    x: Math.round(fractionX * viewport.width),
    y: Math.round(fractionY * viewport.height),
  };
}
