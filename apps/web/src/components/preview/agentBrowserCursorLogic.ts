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
 * The guest's coordinates are already in the same pixels the panel draws in,
 * because the fit-to-panel `scale()` on the `<webview>` shrinks the guest's own
 * layout viewport with it — a 1280-wide freeform viewport measures
 * `window.innerWidth === 1169` once it is scaled to 0.913 to fit. Applying that
 * scale here too shrank the cursor's travel a second time, so it drifted
 * further from the real click the further it got from the top-left while the
 * click itself, which uses the guest coordinates directly, always landed
 * correctly.
 *
 * Zoom is different and does belong: the element is laid out at
 * `width * zoomFactor` CSS pixels and the guest reports `width`, so one guest
 * pixel really is `zoomFactor` panel pixels.
 *
 * `scale` stays in the surface type because the caller has it; it is
 * deliberately unused.
 */
export function agentBrowserCursorOffset(input: {
  readonly x: number;
  readonly y: number;
  readonly zoomFactor: number;
  readonly surface: AgentBrowserCursorSurface | null;
}): { readonly x: number; readonly y: number } {
  const surface = input.surface;
  return {
    x: input.x * input.zoomFactor + (surface?.x ?? 0) - (surface?.scrollLeft ?? 0),
    y: input.y * input.zoomFactor + (surface?.y ?? 0) - (surface?.scrollTop ?? 0),
  };
}
