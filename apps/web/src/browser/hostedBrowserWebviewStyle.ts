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

export const HIDDEN_BROWSER_WEBVIEW_VISIBLE_EDGE = 1;

/**
 * A panel rect alone does not mean Chromium can present it: the owning app
 * window may be backgrounded. Releasing the presentation lease in that state
 * lets snapshots stage a fresh frame, and reacquiring it on return makes the
 * desktop host invalidate the guest compositor.
 */
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
      zIndex: 30,
      pointerEvents: interactive ? "auto" : "none",
      ...(cornerRadius > 0 ? { borderRadius: cornerRadius } : {}),
    };
  }

  if (snapshotStaged) {
    return {
      left: 0,
      top: 0,
      width: hiddenSize.width,
      height: hiddenSize.height,
      // A fully occluded or zero-opacity guest is removed from Chromium's
      // compositor, so Electron cannot capture it. Keep the guest in the
      // foreground surface tree at an imperceptible alpha while snapshotting;
      // pointer input and audio remain disabled because this is not `active`.
      zIndex: 30,
      pointerEvents: "none",
      opacity: 0.001,
      visibility: "visible",
    };
  }

  return {
    // Keep a one-pixel edge in the foreground compositor. Moving an Electron
    // guest fully offscreen makes Chromium defer its first paint/navigation
    // until the user focuses the tab, even with background throttling off.
    left: HIDDEN_BROWSER_WEBVIEW_VISIBLE_EDGE - hiddenSize.width,
    top: 0,
    width: hiddenSize.width,
    height: hiddenSize.height,
    zIndex: 30,
    pointerEvents: "none",
    opacity: 0.001,
    visibility: "visible",
  };
}
