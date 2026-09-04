import { describe, expect, it } from "vite-plus/test";

import {
  clampRemoteViewPan,
  formatRemoteViewZoom,
  isRemoteViewIdentity,
  panRemoteView,
  REMOTE_VIEW_IDENTITY,
  remoteViewTransformStyle,
  zoomInRemoteView,
  zoomOutRemoteView,
} from "./remoteViewTransform.ts";

const PANE = { width: 100, height: 200 } as const;

describe("clampRemoteViewPan", () => {
  it("pins an unzoomed picture in place", () => {
    expect(
      clampRemoteViewPan({
        pan: { x: 40, y: 40 },
        zoom: 1,
        origin: { x: 50, y: 50 },
        pane: PANE,
      }),
    ).toEqual({ x: 0, y: 0 });
  });

  it("allows exactly the travel that keeps the pane covered", () => {
    // Centre origin at 2x on a 100px axis: the scaled element spans -50..150,
    // so it can slide 50px either way before a bar of background appears. The
    // 200px axis travels twice as far for the same reason.
    const clamped = clampRemoteViewPan({
      pan: { x: 999, y: -999 },
      zoom: 2,
      origin: { x: 50, y: 50 },
      pane: PANE,
    });
    expect(clamped).toEqual({ x: 50, y: -100 });
  });

  it("shifts the travel with an off-centre origin", () => {
    // Anchored on the left edge, there is nothing to the left to reveal.
    expect(
      clampRemoteViewPan({ pan: { x: 30, y: 0 }, zoom: 2, origin: { x: 0, y: 50 }, pane: PANE }),
    ).toEqual({ x: 0, y: 0 });
    expect(
      clampRemoteViewPan({ pan: { x: -30, y: 0 }, zoom: 2, origin: { x: 0, y: 50 }, pane: PANE }),
    ).toEqual({ x: -30, y: 0 });
  });

  it("refuses to guess before the pane has been measured", () => {
    expect(
      clampRemoteViewPan({ pan: { x: 10, y: 10 }, zoom: 2, origin: { x: 50, y: 50 }, pane: null }),
    ).toEqual({ x: 0, y: 0 });
  });
});

describe("zoomInRemoteView", () => {
  it("anchors on the last touch when leaving 1x", () => {
    const next = zoomInRemoteView({
      view: REMOTE_VIEW_IDENTITY,
      anchor: { x: 0.25, y: 0.8 },
      pane: PANE,
    });
    expect(next.zoom).toBe(1.5);
    expect(next.origin).toEqual({ x: 25, y: 80 });
  });

  it("keeps the original anchor on every step after the first", () => {
    // Re-anchoring mid-sequence slides the picture out from under someone
    // stepping in on one spot.
    const first = zoomInRemoteView({
      view: REMOTE_VIEW_IDENTITY,
      anchor: { x: 0.25, y: 0.8 },
      pane: PANE,
    });
    const second = zoomInRemoteView({ view: first, anchor: { x: 0.9, y: 0.1 }, pane: PANE });
    expect(second.zoom).toBe(2);
    expect(second.origin).toEqual({ x: 25, y: 80 });
  });

  it("stops at the last step", () => {
    const maxed = { zoom: 4, origin: { x: 50, y: 50 }, pan: { x: 0, y: 0 } };
    expect(zoomInRemoteView({ view: maxed, pane: PANE })).toBe(maxed);
  });

  it("re-clamps a pan that the tighter zoom no longer allows", () => {
    const wide = { zoom: 4, origin: { x: 50, y: 50 }, pan: { x: 150, y: 0 } };
    const out = zoomOutRemoteView({ view: wide, pane: PANE });
    expect(out.zoom).toBe(3);
    expect(out.pan.x).toBe(100);
  });
});

describe("zoomOutRemoteView", () => {
  it("returns to a clean fit rather than a zoom of 1 with a stale pan", () => {
    const nudged = { zoom: 1.5, origin: { x: 10, y: 90 }, pan: { x: -20, y: 5 } };
    expect(zoomOutRemoteView({ view: nudged, pane: PANE })).toEqual(REMOTE_VIEW_IDENTITY);
  });

  it("is a no-op once already fitted", () => {
    expect(zoomOutRemoteView({ view: REMOTE_VIEW_IDENTITY, pane: PANE })).toBe(
      REMOTE_VIEW_IDENTITY,
    );
  });
});

describe("panRemoteView", () => {
  it("moves by the drag and stays inside the pane", () => {
    const zoomed = zoomInRemoteView({ view: REMOTE_VIEW_IDENTITY, pane: PANE });
    const panned = panRemoteView({ view: zoomed, by: { x: 10, y: -10 }, pane: PANE });
    expect(panned.pan).toEqual({ x: 10, y: -10 });
    expect(panned.zoom).toBe(zoomed.zoom);
  });

  it("does nothing at 1x, where there is nothing hidden to reveal", () => {
    expect(panRemoteView({ view: REMOTE_VIEW_IDENTITY, by: { x: 25, y: 25 }, pane: PANE })).toBe(
      REMOTE_VIEW_IDENTITY,
    );
  });
});

describe("remoteViewTransformStyle", () => {
  it("emits no transform at rest", () => {
    // A bare scale(1) still promotes the element to its own layer, which
    // softens the text the zoom exists to make readable.
    expect(remoteViewTransformStyle(REMOTE_VIEW_IDENTITY)).toBeUndefined();
    expect(isRemoteViewIdentity(REMOTE_VIEW_IDENTITY)).toBe(true);
  });

  it("translates after scaling so a pan is pure screen-space movement", () => {
    expect(
      remoteViewTransformStyle({ zoom: 2, origin: { x: 25, y: 75 }, pan: { x: -8, y: 4 } }),
    ).toEqual({
      transform: "translate(-8px, 4px) scale(2)",
      transformOrigin: "25% 75%",
    });
  });

  it("still renders while panned at 1x is impossible but zoomed at rest is not", () => {
    expect(remoteViewTransformStyle({ ...REMOTE_VIEW_IDENTITY, zoom: 1.5 })?.transform).toBe(
      "translate(0px, 0px) scale(1.5)",
    );
  });
});

describe("formatRemoteViewZoom", () => {
  it("reads as a round number of times", () => {
    expect(formatRemoteViewZoom(1.5)).toBe("1.5×");
    expect(formatRemoteViewZoom(3)).toBe("3×");
  });
});
