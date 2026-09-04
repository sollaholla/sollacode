/**
 * Zoom and pan for a mirrored remote surface.
 *
 * Both the remote desktop viewer and the phone's browser mirror show a picture
 * of someone else's screen, scaled to fit. On a phone that fit is small enough
 * that hitting a link or a menu item is guesswork, so the viewer needs to
 * magnify a corner and move around inside it - and moving around is the part
 * that cannot coexist with forwarding drags to the remote machine. Hence a
 * mode: while the view is being adjusted, drags pan the picture and nothing
 * reaches the host; leaving the mode locks the view in and gives the drags
 * back.
 *
 * The transform is expressed as `translate(pan) scale(zoom)` about a percentage
 * origin. Panning is a pure screen-space translation, which keeps it
 * independent of the anchor the zoom was taken about, and both operations are
 * reflected in `getBoundingClientRect()` - so the pointer mapping that both
 * callers already do against the picture element stays correct with no extra
 * arithmetic.
 */

export const REMOTE_VIEW_ZOOM_STEPS = [1, 1.5, 2, 3, 4] as const;

export const REMOTE_VIEW_MAX_ZOOM: number =
  REMOTE_VIEW_ZOOM_STEPS[REMOTE_VIEW_ZOOM_STEPS.length - 1] ?? 1;

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
