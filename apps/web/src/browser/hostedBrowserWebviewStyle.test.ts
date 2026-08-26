import { describe, expect, it } from "vite-plus/test";

import {
  HIDDEN_BROWSER_WEBVIEW_OFFSET,
  resolveHostedBrowserWebviewWrapperStyle,
} from "./hostedBrowserWebviewStyle";

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
      zIndex: 30,
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

  it("keeps an inactive webview paintable while moving it offscreen", () => {
    const style = resolveHostedBrowserWebviewWrapperStyle({
      active: false,
      rect: { x: 12, y: 34, width: 800, height: 600 },
      hiddenSize: { width: 393, height: 852 },
    });

    expect(style).toEqual({
      left: HIDDEN_BROWSER_WEBVIEW_OFFSET,
      top: HIDDEN_BROWSER_WEBVIEW_OFFSET,
      width: 393,
      height: 852,
      zIndex: -1,
      pointerEvents: "none",
      visibility: "visible",
    });
  });

  it("silently stages an inactive webview on-window for a compositor snapshot", () => {
    expect(
      resolveHostedBrowserWebviewWrapperStyle({
        active: false,
        snapshotStaged: true,
        rect: null,
        hiddenSize: { width: 1280, height: 800 },
      }),
    ).toEqual({
      left: 0,
      top: 0,
      width: 1280,
      height: 800,
      zIndex: -1,
      pointerEvents: "none",
      visibility: "visible",
    });
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
    expect(style.zIndex).toBe(30);
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
});
