import { describe, expect, it } from "vite-plus/test";

import {
  HOSTED_BROWSER_WEBVIEW_ACTIVE_Z_INDEX,
  HOSTED_BROWSER_WEBVIEW_BACKGROUND_Z_INDEX,
  HOSTED_BROWSER_WEBVIEW_COMPOSITOR_ALPHA,
  HOSTED_BROWSER_WEBVIEW_PARKED_ALPHA,
  HOSTED_BROWSER_WEBVIEW_STAGED_Z_INDEX,
  isHostedBrowserWebviewPresented,
  readHostedBrowserHostWindowPresenting,
  resolveHostedBrowserWebviewAccessibilityState,
  resolveHostedBrowserWebviewBackgroundRect,
  resolveHostedBrowserWebviewContainerSize,
  resolveHostedBrowserWebviewTabIndex,
  resolveHostedBrowserWebviewWrapperStyle,
} from "./hostedBrowserWebviewStyle";

describe("isHostedBrowserWebviewPresented", () => {
  it("releases a still-selected surface while the owning app window is blurred", () => {
    expect(isHostedBrowserWebviewPresented(true, true)).toBe(true);
    expect(isHostedBrowserWebviewPresented(true, false)).toBe(false);
    expect(isHostedBrowserWebviewPresented(false, true)).toBe(false);
  });
});

describe("readHostedBrowserHostWindowPresenting", () => {
  it("keeps the host presenting when focus moved into a guest webview", () => {
    expect(
      readHostedBrowserHostWindowPresenting({
        visibilityState: "visible",
        hasFocus: () => false,
        activeElement: { tagName: "WEBVIEW" },
      }),
    ).toBe(true);
  });

  it("releases presentation when the host window is actually backgrounded", () => {
    expect(
      readHostedBrowserHostWindowPresenting({
        visibilityState: "visible",
        hasFocus: () => false,
        activeElement: { tagName: "BODY" },
      }),
    ).toBe(false);
    expect(
      readHostedBrowserHostWindowPresenting({
        visibilityState: "hidden",
        hasFocus: () => true,
        activeElement: { tagName: "WEBVIEW" },
      }),
    ).toBe(false);
  });
});

describe("resolveHostedBrowserWebviewAccessibilityState", () => {
  it("removes an inactive guest subtree from accessibility", () => {
    expect(resolveHostedBrowserWebviewAccessibilityState(false)).toEqual({
      "aria-hidden": true,
      inert: true,
    });
  });

  it("removes only the inactive native guest from sequential keyboard focus", () => {
    expect(resolveHostedBrowserWebviewTabIndex(false)).toBe(-1);
    expect(resolveHostedBrowserWebviewTabIndex(true)).toBeUndefined();
  });

  it("keeps the active guest interactive", () => {
    expect(resolveHostedBrowserWebviewAccessibilityState(true)).toEqual({});
  });
});

describe("resolveHostedBrowserWebviewWrapperStyle", () => {
  it("places an active webview on its presented surface", () => {
    expect(
      resolveHostedBrowserWebviewWrapperStyle({
        active: true,
        rect: { x: 12, y: 34, width: 800, height: 600 },
        hiddenSize: { width: 1280, height: 800 },
      }),
    ).toEqual({
      left: 12,
      top: 34,
      width: 800,
      height: 600,
      zIndex: HOSTED_BROWSER_WEBVIEW_ACTIVE_Z_INDEX,
      pointerEvents: "auto",
    });
  });

  it("clips a floating webview to the mini-player frame", () => {
    expect(
      resolveHostedBrowserWebviewWrapperStyle({
        active: true,
        cornerRadius: 12,
        rect: { x: 12, y: 34, width: 360, height: 203 },
        hiddenSize: { width: 1280, height: 800 },
      }),
    ).toMatchObject({
      left: 12,
      top: 34,
      width: 360,
      height: 203,
      borderRadius: 12,
    });
  });

  it("keeps a warming webview compositor-active at its last full geometry", () => {
    const style = resolveHostedBrowserWebviewWrapperStyle({
      active: false,
      warming: true,
      rect: { x: 12, y: 34, width: 800, height: 600 },
      hiddenSize: { width: 393, height: 852 },
    });

    expect(style).toEqual({
      left: 12,
      top: 34,
      width: 800,
      height: 600,
      zIndex: HOSTED_BROWSER_WEBVIEW_BACKGROUND_Z_INDEX,
      pointerEvents: "none",
      opacity: HOSTED_BROWSER_WEBVIEW_COMPOSITOR_ALPHA,
      visibility: "visible",
    });
  });

  it("parks a resting background guest off the compositor at the same geometry", () => {
    const rect = { x: 12, y: 34, width: 800, height: 600 };
    const hiddenSize = { width: 393, height: 852 };
    const warming = resolveHostedBrowserWebviewWrapperStyle({
      active: false,
      warming: true,
      rect,
      hiddenSize,
    });
    const parked = resolveHostedBrowserWebviewWrapperStyle({ active: false, rect, hiddenSize });

    // Only the alpha may change. A guest returning with a stale compositor
    // clip is why geometry is held identical across every state.
    expect(parked).toEqual({ ...warming, opacity: HOSTED_BROWSER_WEBVIEW_PARKED_ALPHA });
    expect(HOSTED_BROWSER_WEBVIEW_PARKED_ALPHA).toBe(0);
  });

  it("keeps a staged guest compositor-active so its native capture can paint", () => {
    expect(
      resolveHostedBrowserWebviewWrapperStyle({
        active: false,
        snapshotStaged: true,
        rect: { x: 12, y: 34, width: 800, height: 600 },
        hiddenSize: { width: 393, height: 852 },
      }),
    ).toMatchObject({
      zIndex: HOSTED_BROWSER_WEBVIEW_STAGED_Z_INDEX,
      opacity: HOSTED_BROWSER_WEBVIEW_COMPOSITOR_ALPHA,
    });
  });

  it("keeps the native corner clip stable while a mini-player guest is inactive", () => {
    expect(
      resolveHostedBrowserWebviewWrapperStyle({
        active: false,
        cornerRadius: 12,
        rect: { x: 12, y: 34, width: 360, height: 203 },
        hiddenSize: { width: 1280, height: 800 },
      }),
    ).toMatchObject({
      left: 12,
      top: 34,
      width: 360,
      height: 203,
      borderRadius: 12,
    });
  });

  it("mounts a never-presented webview compositor-active at full fallback geometry", () => {
    expect(
      resolveHostedBrowserWebviewWrapperStyle({
        active: false,
        warming: true,
        rect: null,
        hiddenSize: { width: 1280, height: 800 },
      }),
    ).toEqual({
      left: 0,
      top: 0,
      width: 1280,
      height: 800,
      zIndex: HOSTED_BROWSER_WEBVIEW_BACKGROUND_Z_INDEX,
      pointerEvents: "none",
      opacity: HOSTED_BROWSER_WEBVIEW_COMPOSITOR_ALPHA,
      visibility: "visible",
    });
  });

  it("keeps repeated inactive presentation reads geometry-identical", () => {
    const input = {
      active: false,
      rect: { x: 24, y: 48, width: 900, height: 640 },
      hiddenSize: { width: 1280, height: 800 },
    } as const;

    const first = resolveHostedBrowserWebviewWrapperStyle(input);
    const second = resolveHostedBrowserWebviewWrapperStyle(input);

    expect(second).toEqual(first);
    expect(second).toEqual({
      left: 24,
      top: 48,
      width: 900,
      height: 640,
      zIndex: HOSTED_BROWSER_WEBVIEW_BACKGROUND_Z_INDEX,
      pointerEvents: "none",
      opacity: HOSTED_BROWSER_WEBVIEW_PARKED_ALPHA,
      visibility: "visible",
    });
  });

  it("stages native capture without changing inactive guest geometry", () => {
    const input = {
      active: false,
      rect: { x: 24, y: 48, width: 900, height: 640 },
      hiddenSize: { width: 1280, height: 800 },
    } as const;
    const inactive = resolveHostedBrowserWebviewWrapperStyle(input);
    const staged = resolveHostedBrowserWebviewWrapperStyle({ ...input, snapshotStaged: true });

    // Staging lifts the guest back onto the compositor so the capture has a
    // frame to take; the geometry it captures must not move.
    expect(staged).toEqual({
      ...inactive,
      zIndex: HOSTED_BROWSER_WEBVIEW_STAGED_Z_INDEX,
      opacity: HOSTED_BROWSER_WEBVIEW_COMPOSITOR_ALPHA,
    });
    // A resting guest is parked off the compositor; staging is what puts it
    // back, and it is the only thing that changes.
    expect(inactive.opacity).toBe(HOSTED_BROWSER_WEBVIEW_PARKED_ALPHA);
    expect(staged.opacity).toBeGreaterThan(0);
    expect(staged.left).toBe(inactive.left);
    expect(staged.top).toBe(inactive.top);
    expect(staged.width).toBe(inactive.width);
    expect(staged.height).toBe(inactive.height);
  });

  it("blocks guest input when the owner presents the surface non-interactively", () => {
    // The floating mini player presents the live guest as a thumbnail. Without
    // this the first click lands in the page instead of grabbing the window.
    const style = resolveHostedBrowserWebviewWrapperStyle({
      active: true,
      rect: { x: 12, y: 34, width: 320, height: 200 },
      hiddenSize: { width: 1280, height: 800 },
      interactive: false,
    });

    expect(style.pointerEvents).toBe("none");
    // Still presented at its real rect: non-interactive, not hidden.
    expect(style.left).toBe(12);
    expect(style.top).toBe(34);
    expect(style.zIndex).toBe(HOSTED_BROWSER_WEBVIEW_ACTIVE_Z_INDEX);
  });

  it("defaults to an interactive guest so the panel keeps accepting input", () => {
    expect(
      resolveHostedBrowserWebviewWrapperStyle({
        active: true,
        rect: { x: 0, y: 0, width: 320, height: 200 },
        hiddenSize: { width: 1280, height: 800 },
      }).pointerEvents,
    ).toBe("auto");
  });

  it("layers an active guest above every inactive guest", () => {
    const rect = { x: 0, y: 0, width: 800, height: 600 };
    const hiddenSize = { width: 1280, height: 800 };

    const active = resolveHostedBrowserWebviewWrapperStyle({
      active: true,
      rect,
      hiddenSize,
    });
    const inactive = resolveHostedBrowserWebviewWrapperStyle({
      active: false,
      rect,
      hiddenSize,
    });

    expect(active.zIndex).toBeGreaterThan(inactive.zIndex);
  });

  it("parks inactive guests behind the opaque app shell", () => {
    const inactive = resolveHostedBrowserWebviewWrapperStyle({
      active: false,
      rect: { x: 0, y: 0, width: 800, height: 600 },
      hiddenSize: { width: 1280, height: 800 },
    });
    const staged = resolveHostedBrowserWebviewWrapperStyle({
      active: false,
      snapshotStaged: true,
      rect: { x: 0, y: 0, width: 800, height: 600 },
      hiddenSize: { width: 1280, height: 800 },
    });

    expect(inactive.zIndex).toBeLessThan(0);
    expect(inactive.zIndex).toBe(HOSTED_BROWSER_WEBVIEW_BACKGROUND_Z_INDEX);
    expect(staged.zIndex).toBeGreaterThan(inactive.zIndex);
    expect(staged.zIndex).toBeLessThan(HOSTED_BROWSER_WEBVIEW_ACTIVE_Z_INDEX);
  });
});

describe("resolveHostedBrowserWebviewContainerSize", () => {
  it("retains the presented child layout while its guest is in the background", () => {
    const lastRect = { x: 24, y: 48, width: 900, height: 640 };
    expect(resolveHostedBrowserWebviewContainerSize(lastRect, { width: 393, height: 852 })).toEqual(
      lastRect,
    );
  });

  it("uses the viewport fallback before a guest has ever been presented", () => {
    expect(resolveHostedBrowserWebviewContainerSize(null, { width: 393, height: 852 })).toEqual({
      width: 393,
      height: 852,
    });
  });
});

describe("resolveHostedBrowserWebviewBackgroundRect", () => {
  it("parks a stale right-panel rect fully on-window after the host narrows", () => {
    expect(
      resolveHostedBrowserWebviewBackgroundRect(
        { x: 1000, y: 90, width: 500, height: 600 },
        { width: 1280, height: 800 },
        { width: 800, height: 700 },
      ),
    ).toEqual({ x: 300, y: 90, width: 500, height: 600 });
  });

  it("anchors a guest larger than the host at the on-window origin without resizing it", () => {
    expect(
      resolveHostedBrowserWebviewBackgroundRect(
        { x: 500, y: 400, width: 1280, height: 800 },
        { width: 1280, height: 800 },
        { width: 800, height: 600 },
      ),
    ).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
  });
});
