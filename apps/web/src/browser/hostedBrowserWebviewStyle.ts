import type { BrowserSurfaceRect } from "./browserSurfaceStore";

export interface HostedBrowserWebviewSize {
  readonly width: number;
  readonly height: number;
}

export interface HostedBrowserWebviewWrapperStyle {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly zIndex: number;
  readonly pointerEvents: "auto" | "none";
  readonly opacity?: number;
  readonly borderRadius?: number;
  readonly visibility?: "visible";
}

/**
 * The floating mini-player chrome is authored around this layer: backdrop at
 * 29, controls at 31+. Keep the selected guest here so those overlays still
 * own the pointer.
 */
export const HOSTED_BROWSER_WEBVIEW_ACTIVE_Z_INDEX = 30;

/**
 * Native snapshot fallback only. A compositor-visible layer has to sit above
 * in-flow chrome, but still below the selected guest and mini-player controls.
 */
export const HOSTED_BROWSER_WEBVIEW_STAGED_Z_INDEX = 29;

/**
 * Inactive guests keep their last on-window rect so Chromium retains a real
 * layout, but they must sit behind the opaque app shell. A positive z-index
 * here would composite every background tab over chat, files, and the sidebar.
 */
export const HOSTED_BROWSER_WEBVIEW_BACKGROUND_Z_INDEX = -1;

/**
 * Zero opacity removes an Electron guest from Chromium's compositor, which
 * defers first paint and navigation until the tab is focused. This alpha is
 * still invisible, including behind the opaque app shell.
 */
export const HOSTED_BROWSER_WEBVIEW_COMPOSITOR_ALPHA = 0.001;

export interface HostedBrowserWebviewAccessibilityState {
  readonly "aria-hidden"?: true;
  readonly inert?: true;
}

export function resolveHostedBrowserWebviewAccessibilityState(
  active: boolean,
): HostedBrowserWebviewAccessibilityState {
  return active ? {} : { "aria-hidden": true, inert: true };
}

export function resolveHostedBrowserWebviewTabIndex(active: boolean): -1 | undefined {
  return active ? undefined : -1;
}

export function resolveHostedBrowserWebviewContainerSize(
  rect: BrowserSurfaceRect | null,
  hiddenSize: HostedBrowserWebviewSize,
): HostedBrowserWebviewSize {
  return rect ?? hiddenSize;
}

export function resolveHostedBrowserWebviewBackgroundRect(
  rect: BrowserSurfaceRect | null,
  hiddenSize: HostedBrowserWebviewSize,
  hostSize?: HostedBrowserWebviewSize,
): BrowserSurfaceRect {
  const backgroundRect = rect ?? {
    x: 0,
    y: 0,
    width: hiddenSize.width,
    height: hiddenSize.height,
  };
  if (!hostSize) return backgroundRect;
  return {
    ...backgroundRect,
    x: Math.min(Math.max(0, backgroundRect.x), Math.max(0, hostSize.width - backgroundRect.width)),
    y: Math.min(
      Math.max(0, backgroundRect.y),
      Math.max(0, hostSize.height - backgroundRect.height),
    ),
  };
}

/**
 * A panel rect alone does not mean Chromium can present it: the owning app
 * window may be backgrounded. Releasing the presentation lease in that state
 * lets snapshots stage a fresh frame, and reacquiring it on return makes the
 * desktop host invalidate the guest compositor.
 *
 * Focusing a `<webview>` blurs the host document even though the same window
 * is still showing that guest. Treat that as presented so automation captures
 * the on-screen frame instead of a hidden CDP path that can disagree with it.
 */
export function readHostedBrowserHostWindowPresenting(doc: {
  readonly visibilityState: string;
  readonly hasFocus: () => boolean;
  readonly activeElement: { readonly tagName: string } | null;
}): boolean {
  if (doc.visibilityState === "hidden") return false;
  if (doc.hasFocus()) return true;
  return doc.activeElement?.tagName.toUpperCase() === "WEBVIEW";
}

export function isHostedBrowserWebviewPresented(
  surfaceActive: boolean,
  ownerWindowFocused: boolean,
): boolean {
  return surfaceActive && ownerWindowFocused;
}

export function resolveHostedBrowserWebviewWrapperStyle(input: {
  readonly active: boolean;
  readonly snapshotStaged?: boolean;
  readonly cornerRadius?: number;
  readonly rect: BrowserSurfaceRect | null;
  readonly hiddenSize: HostedBrowserWebviewSize;
  readonly hostSize?: HostedBrowserWebviewSize;
  /**
   * Whether the guest receives pointer input. The floating mini player presents
   * the same live surface as a preview thumbnail, where a stray click would
   * navigate the guest instead of moving the window, so it presents
   * non-interactively and promotes to the right panel to be used.
   */
  readonly interactive?: boolean;
}): HostedBrowserWebviewWrapperStyle {
  const {
    active,
    cornerRadius = 0,
    hiddenSize,
    hostSize,
    interactive = true,
    rect,
    snapshotStaged = false,
  } = input;
  if (active && rect) {
    return {
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
      zIndex: HOSTED_BROWSER_WEBVIEW_ACTIVE_Z_INDEX,
      pointerEvents: interactive ? "auto" : "none",
      ...(cornerRadius > 0 ? { borderRadius: cornerRadius } : {}),
    };
  }

  const backgroundRect = resolveHostedBrowserWebviewBackgroundRect(rect, hiddenSize, hostSize);

  return {
    // Keep the whole guest at its last presented geometry. A clipped,
    // offscreen, or zero-opacity Electron guest can defer its first paint and
    // can return with a stale compositor clip after focus. Park the layer
    // behind the opaque app shell at compositor-active alpha so a newly opened
    // background tab loads without focusing its thread and without stacking
    // translucent pages over chat or files.
    left: backgroundRect.x,
    top: backgroundRect.y,
    width: backgroundRect.width,
    height: backgroundRect.height,
    zIndex: snapshotStaged
      ? HOSTED_BROWSER_WEBVIEW_STAGED_Z_INDEX
      : HOSTED_BROWSER_WEBVIEW_BACKGROUND_Z_INDEX,
    pointerEvents: "none",
    opacity: HOSTED_BROWSER_WEBVIEW_COMPOSITOR_ALPHA,
    visibility: "visible",
    ...(cornerRadius > 0 ? { borderRadius: cornerRadius } : {}),
  };
}
