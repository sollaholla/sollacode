export type BrowserController = "human" | "agent" | "none";

export function agentBrowserCursorOpacity(active: boolean, controller: BrowserController): number {
  if (active) return 1;
  return controller === "human" ? 0.18 : 0.35;
}

export interface AgentBrowserCursorSurface {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly scrollLeft: number;
  readonly scrollTop: number;
}

/**
 * Where to draw the agent cursor for a point the guest page reported.
 *
 * The `<webview>` element is laid out at the guest's full logical size
 * (`viewportWidth / viewportScale` — e.g. the whole 1280 of a freeform
 * viewport) and then shrunk visually with `transform: scale(viewportScale)`
 * (HostedBrowserWebview). A CSS transform does not change the guest's layout
 * viewport, so automation coordinates arrive in the UNSCALED guest space and
 * must be multiplied by the fit scale to land on the drawn pixels; skipping
 * it left the cursor increasingly short of the real click toward the
 * bottom-right of a scaled-down panel (reported 2026-08-30). In fill mode the
 * scale is 1, so this is exact there too.
 *
 * Zoom multiplies as well: the element is laid out at `width * zoomFactor`
 * CSS pixels while the guest reports `width`, so one guest pixel really is
 * `zoomFactor` panel pixels before the fit scale applies.
 *
 * The wrapper's own scrollbars pan the already-scaled canvas, so scroll
 * offsets subtract after scaling.
 */
export function agentBrowserCursorOffset(input: {
  readonly x: number;
  readonly y: number;
  readonly zoomFactor: number;
  readonly surface: AgentBrowserCursorSurface | null;
}): { readonly x: number; readonly y: number } {
  const surface = input.surface;
  const scale = surface !== null && surface.scale > 0 ? surface.scale : 1;
  return {
    x: input.x * input.zoomFactor * scale + (surface?.x ?? 0) - (surface?.scrollLeft ?? 0),
    y: input.y * input.zoomFactor * scale + (surface?.y ?? 0) - (surface?.scrollTop ?? 0),
  };
}

export interface DrawnRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Cursor position from a guest point and the rect the guest is drawn in.
 *
 * The guest's viewport always fills the element it is drawn in: zoom, the
 * fit transform and letterboxing all change the drawn rect, never the
 * guest's own coordinate space. So a click at `(x, y)` in a guest reporting
 * `viewportWidth × viewportHeight` lands at the same fraction of the drawn
 * rect, measured from `parent` (the overlay's containing block). No
 * mirrored scale or offset is involved, which is what let earlier versions
 * drift when that mirror was stale.
 */
export function agentBrowserCursorPoint(input: {
  readonly x: number;
  readonly y: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly drawn: DrawnRect;
  readonly parent: { readonly left: number; readonly top: number };
}): { readonly x: number; readonly y: number } | null {
  const { viewportWidth, viewportHeight, drawn } = input;
  if (
    !(viewportWidth > 0) ||
    !(viewportHeight > 0) ||
    !(drawn.width > 0) ||
    !(drawn.height > 0) ||
    !Number.isFinite(input.x) ||
    !Number.isFinite(input.y)
  ) {
    return null;
  }
  const fractionX = Math.min(1, Math.max(0, input.x / viewportWidth));
  const fractionY = Math.min(1, Math.max(0, input.y / viewportHeight));
  return {
    x: drawn.left - input.parent.left + fractionX * drawn.width,
    y: drawn.top - input.parent.top + fractionY * drawn.height,
  };
}
