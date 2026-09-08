import type { PreviewRenderedViewportSize } from "@t3tools/contracts";

export interface BrowserViewportHostScale {
  readonly width: number;
  readonly height: number;
}

const MIN_HOST_SCALE = 0.25;
const MAX_HOST_SCALE = 4;
const VIEWPORT_TOLERANCE_PX = 1;

const clampScale = (value: number): number =>
  Math.min(MAX_HOST_SCALE, Math.max(MIN_HOST_SCALE, value));

/**
 * Refine the host element size from the viewport Chromium actually rendered.
 *
 * Electron applies the embedder window's page zoom when it turns a `<webview>`
 * CSS box into guest bounds. That zoom is independent from the guest's own
 * zoom factor, so a 667px element can produce (for example) a 609px guest.
 * Feeding the measured ratio back into the host box keeps device presets in
 * page CSS pixels even when the Solla window itself is zoomed.
 */
export function refineBrowserViewportHostScale(input: {
  readonly current: BrowserViewportHostScale;
  readonly expected: PreviewRenderedViewportSize;
  readonly rendered: PreviewRenderedViewportSize;
}): BrowserViewportHostScale | null {
  const { current, expected, rendered } = input;
  if (
    Math.abs(expected.width - rendered.width) <= VIEWPORT_TOLERANCE_PX &&
    Math.abs(expected.height - rendered.height) <= VIEWPORT_TOLERANCE_PX
  ) {
    return null;
  }
  return {
    width: clampScale(current.width * (expected.width / rendered.width)),
    height: clampScale(current.height * (expected.height / rendered.height)),
  };
}
