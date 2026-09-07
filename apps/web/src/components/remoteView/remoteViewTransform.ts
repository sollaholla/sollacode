/**
 * Zoom and pan for a mirrored remote surface.
 *
 * Both the remote desktop viewer and the phone's browser mirror show a picture
 * of someone else's screen, scaled to fit. On a phone that fit is small enough
 * that hitting a link or a menu item is guesswork, so the viewer needs to
 * magnify a corner and move around inside it - and moving around is the part
 * that cannot coexist with forwarding drags to the remote machine. Hence the
 * split by finger count: one finger belongs to the remote machine, two
 * fingers belong to the picture (pinch to zoom, drag both to move), and
 * nothing reaches the host while two are down.
 *
 * The transform is expressed as `translate(pan) scale(zoom)` about a percentage
 * origin. Panning is a pure screen-space translation, which keeps it
 * independent of the anchor the zoom was taken about, and both operations are
 * reflected in `getBoundingClientRect()` - so the pointer mapping that both
 * callers already do against the picture element stays correct with no extra
 * arithmetic.
 */

export const REMOTE_VIEW_ZOOM_STEPS = [1, 1.5, 2, 3, 4] as const;

/**
 * Where a pinch stops. Higher than the last button step: a pinch is
 * continuous, so there is no "one more press" to worry about, and a phone
 * reading a 4K desktop needs the extra reach to hit a menu item.
 */
export const REMOTE_VIEW_MAX_ZOOM = 6;

/** Below this a pinch snaps back to a clean fit rather than a 1.02x with a pan. */
const REMOTE_VIEW_SNAP_TO_FIT_ZOOM = 1.05;

export type RemoteViewPoint = { readonly x: number; readonly y: number };

export type RemoteViewTransform = {
  /** 1 = fit the pane. Above that the picture is magnified about `origin`. */
  readonly zoom: number;
  /** Transform origin, in percent of the picture element. */
  readonly origin: RemoteViewPoint;
  /** Screen-space offset in CSS pixels, applied after the scale. */
  readonly pan: RemoteViewPoint;
};

export type RemoteViewSize = { readonly width: number; readonly height: number };

export const REMOTE_VIEW_IDENTITY: RemoteViewTransform = {
  zoom: 1,
  origin: { x: 50, y: 50 },
  pan: { x: 0, y: 0 },
};

export function isRemoteViewIdentity(view: RemoteViewTransform): boolean {
  return view.zoom === 1 && view.pan.x === 0 && view.pan.y === 0;
}

/**
 * Keep the magnified picture covering the pane.
 *
 * A point at fraction `f` of the element renders at `f*size*zoom +
 * origin*(1-zoom)`, so the scaled element spans `[o*(1-z), size*z + o*(1-z)]`
 * where `o` is the origin in pixels. Requiring that span to contain `[0, size]`
 * gives the bounds below; at zoom 1 they collapse to zero, which is what pins
 * an unzoomed picture in place.
 *
 * The bound is the element box, not the picture inside it. A letterboxed
 * source can therefore be panned a little way into its own bars - harmless,
 * and far cheaper than threading the intrinsic aspect ratio through every
 * caller for a few pixels of travel.
 */
export function clampRemoteViewPan(input: {
  readonly pan: RemoteViewPoint;
  readonly zoom: number;
  readonly origin: RemoteViewPoint;
  readonly pane: RemoteViewSize | null;
}): RemoteViewPoint {
  const pane = input.pane;
  if (pane === null || pane.width <= 0 || pane.height <= 0) return { x: 0, y: 0 };
  const travel = input.zoom - 1;
  if (travel <= 0) return { x: 0, y: 0 };
  const axis = (value: number, originPercent: number, size: number): number => {
    const originFraction = originPercent / 100;
    const min = (originFraction - 1) * size * travel;
    const max = originFraction * size * travel;
    return Math.min(max, Math.max(min, value));
  };
  return {
    x: axis(input.pan.x, input.origin.x, pane.width),
    y: axis(input.pan.y, input.origin.y, pane.height),
  };
}

/**
 * Step in, anchoring on where the viewer last touched.
 *
 * Only when leaving 1x: re-anchoring on every step would slide the picture out
 * from under a viewer who is stepping in on one spot, which is the opposite of
 * what repeated presses are asking for.
 */
export function zoomInRemoteView(input: {
  readonly view: RemoteViewTransform;
  readonly anchor?: RemoteViewPoint;
  readonly pane: RemoteViewSize | null;
}): RemoteViewTransform {
  const next = REMOTE_VIEW_ZOOM_STEPS.find((step) => step > input.view.zoom + 0.001);
  if (next === undefined) return input.view;
  const origin =
    input.view.zoom === 1 && input.anchor
      ? {
          x: Math.round(Math.min(1, Math.max(0, input.anchor.x)) * 100),
          y: Math.round(Math.min(1, Math.max(0, input.anchor.y)) * 100),
        }
      : input.view.origin;
  return {
    zoom: next,
    origin,
    pan: clampRemoteViewPan({ pan: input.view.pan, zoom: next, origin, pane: input.pane }),
  };
}

/** Step out, and snap back to a clean fit once there is nothing left to zoom. */
export function zoomOutRemoteView(input: {
  readonly view: RemoteViewTransform;
  readonly pane: RemoteViewSize | null;
}): RemoteViewTransform {
  const next =
    REMOTE_VIEW_ZOOM_STEPS.toReversed().find((step) => step < input.view.zoom - 0.001) ?? 1;
  if (next === input.view.zoom) return input.view;
  if (next === 1) return REMOTE_VIEW_IDENTITY;
  return {
    zoom: next,
    origin: input.view.origin,
    pan: clampRemoteViewPan({
      pan: input.view.pan,
      zoom: next,
      origin: input.view.origin,
      pane: input.pane,
    }),
  };
}

/** Two fingers on the pane: where they are between, and how far apart. */
export type RemoteViewPinch = {
  /** Midpoint in pane pixels, measured from the pane's top-left corner. */
  readonly midpoint: RemoteViewPoint;
  /** Distance between the fingers in pixels. */
  readonly distance: number;
};

export function remoteViewPinchOf(a: RemoteViewPoint, b: RemoteViewPoint): RemoteViewPinch {
  return {
    midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    distance: Math.hypot(b.x - a.x, b.y - a.y),
  };
}

/**
 * Follow a pinch from where it started.
 *
 * Everything is computed from the gesture's starting view rather than the
 * previous sample, so a jittery pair of fingers cannot accumulate drift: the
 * zoom is the start zoom scaled by how far the fingers have spread, and the
 * pan is whatever keeps the picture that was under the fingers' first midpoint
 * under their current midpoint. Fingers that move together without spreading
 * are therefore a pure pan, which is what makes "hold both and drag" work
 * without a separate mode.
 *
 * With the picture rendering a point at fraction `f` of itself at
 * `f*size*zoom + origin*(1-zoom) + pan`, the fraction under the start midpoint
 * is recovered from the start view, and the new pan is solved from the same
 * equation at the new zoom and the new midpoint.
 */
export function pinchRemoteView(input: {
  readonly start: RemoteViewTransform;
  readonly from: RemoteViewPinch;
  readonly to: RemoteViewPinch;
  readonly pane: RemoteViewSize | null;
}): RemoteViewTransform {
  const pane = input.pane;
  if (pane === null || pane.width <= 0 || pane.height <= 0) return input.start;
  const ratio = input.from.distance > 0 ? input.to.distance / input.from.distance : 1;
  const zoom = Math.min(REMOTE_VIEW_MAX_ZOOM, Math.max(1, input.start.zoom * ratio));
  if (zoom < REMOTE_VIEW_SNAP_TO_FIT_ZOOM) return REMOTE_VIEW_IDENTITY;
  const origin = input.start.origin;
  const axis = (
    startMid: number,
    mid: number,
    originPercent: number,
    size: number,
    startPan: number,
  ): number => {
    const originPx = (originPercent / 100) * size;
    const fraction =
      (startMid - originPx * (1 - input.start.zoom) - startPan) / (size * input.start.zoom);
    return mid - fraction * size * zoom - originPx * (1 - zoom);
  };
  const pan = {
    x: axis(input.from.midpoint.x, input.to.midpoint.x, origin.x, pane.width, input.start.pan.x),
    y: axis(input.from.midpoint.y, input.to.midpoint.y, origin.y, pane.height, input.start.pan.y),
  };
  return { zoom, origin, pan: clampRemoteViewPan({ pan, zoom, origin, pane }) };
}

/** Move the picture by a screen-space drag, staying within the pane. */
export function panRemoteView(input: {
  readonly view: RemoteViewTransform;
  readonly by: RemoteViewPoint;
  readonly pane: RemoteViewSize | null;
}): RemoteViewTransform {
  if (input.view.zoom === 1) return input.view;
  return {
    zoom: input.view.zoom,
    origin: input.view.origin,
    pan: clampRemoteViewPan({
      pan: { x: input.view.pan.x + input.by.x, y: input.view.pan.y + input.by.y },
      zoom: input.view.zoom,
      origin: input.view.origin,
      pane: input.pane,
    }),
  };
}

/**
 * `undefined` at rest so an unzoomed surface renders with no transform at all -
 * a `scale(1)` still promotes the element to its own layer, which on a phone
 * costs memory and can soften the very text the zoom exists to make readable.
 */
export function remoteViewTransformStyle(view: RemoteViewTransform):
  | {
      readonly transform: string;
      readonly transformOrigin: string;
    }
  | undefined {
  if (isRemoteViewIdentity(view)) return undefined;
  return {
    transform: `translate(${String(view.pan.x)}px, ${String(view.pan.y)}px) scale(${String(view.zoom)})`,
    transformOrigin: `${String(view.origin.x)}% ${String(view.origin.y)}%`,
  };
}

/** Rounded for a readout: continuous values would jitter the button width. */
export function formatRemoteViewZoom(zoom: number): string {
  return `${String(Math.round(zoom * 10) / 10)}×`;
}
