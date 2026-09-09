export interface BrowserViewportHostScale {
  readonly width: number;
  readonly height: number;
}

/** Convert guest CSS dimensions to host CSS using the actual embedder zoom. */
export function resolveBrowserViewportHostScale(appZoomFactor: number): BrowserViewportHostScale {
  const scale = Number.isFinite(appZoomFactor) && appZoomFactor > 0 ? 1 / appZoomFactor : 1;
  return { width: scale, height: scale };
}

/** Keep the compensated guest inside the same visible frame and resize rails. */
export function resolveBrowserViewportHostTransform(
  presentationScale: number,
  hostScale: BrowserViewportHostScale,
): string {
  return `scale(${presentationScale / hostScale.width}, ${presentationScale / hostScale.height})`;
}
