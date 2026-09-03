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
 *
 * It is also what every background tab costs. A compositor-active layer is
 * rasterized and blended every frame for as long as it is mounted, and this
 * host mounts a guest for every tab of every thread, not only the visible one.
 * Measured 2026-09-03: 21 full-window layers repainting forever across ten
 * threads, including a video still decoding in a thread nobody had open. So
 * this alpha is now the WARM-UP state only — held long enough to cover the
 * first paint and auth hydration it was introduced for, not the resting state.
 */
export const HOSTED_BROWSER_WEBVIEW_COMPOSITOR_ALPHA = 0.001;

/**
 * The resting state for a background guest: removed from Chromium's
 * compositor, so it stops rasterizing, blending, and decoding video. The page
 * stays alive — this is opacity, not unmounting, so the live document and its
 * authenticated session survive exactly as they did before.
 */
export const HOSTED_BROWSER_WEBVIEW_PARKED_ALPHA = 0;

/**
 * How long a background guest stays compositor-active after it mounts or
 * navigates. Chromium defers first paint and navigation for a zero-opacity
 * guest, so a tab opened behind the user's back still needs a window in which
 * to load and let auth SDKs hydrate; that window just must not be unbounded.
 */
export const HOSTED_BROWSER_WEBVIEW_WARMUP_MS = 10_000;

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
  /**
   * Whether this background guest still needs the compositor: it is loading or
   * has just navigated, or automation is driving it while its thread is off
   * screen. Resting background guests are parked instead.
   */
  readonly warming?: boolean;
}): HostedBrowserWebviewWrapperStyle {
  const {
    active,
    cornerRadius = 0,
    hiddenSize,
    hostSize,
    interactive = true,
    rect,
    snapshotStaged = false,
    warming = false,
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
    // Keep the whole guest at its last presented geometry. A clipped or
    // offscreen Electron guest can return with a stale compositor clip after
    // focus, so geometry stays put in every state and only the alpha changes.
    //
    // A guest that is warming, or staging a native snapshot, keeps the
    // compositor-active alpha: Chromium defers first paint and navigation for
    // a zero-opacity guest, which is what that alpha was introduced to avoid.
    // Everything at rest is parked off the compositor instead of repainting
    // behind the opaque app shell for the lifetime of the app.
    left: backgroundRect.x,
    top: backgroundRect.y,
    width: backgroundRect.width,
    height: backgroundRect.height,
    zIndex: snapshotStaged
      ? HOSTED_BROWSER_WEBVIEW_STAGED_Z_INDEX
      : HOSTED_BROWSER_WEBVIEW_BACKGROUND_Z_INDEX,
    pointerEvents: "none",
    opacity:
      warming || snapshotStaged
        ? HOSTED_BROWSER_WEBVIEW_COMPOSITOR_ALPHA
        : HOSTED_BROWSER_WEBVIEW_PARKED_ALPHA,
    visibility: "visible",
    ...(cornerRadius > 0 ? { borderRadius: cornerRadius } : {}),
  };
}
