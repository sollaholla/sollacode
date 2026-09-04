// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { RemoteViewAdjustLayer, RemoteViewZoomToggle } from "./RemoteViewZoom.tsx";
import { REMOTE_VIEW_IDENTITY, type RemoteViewTransform } from "./remoteViewTransform.ts";

const ZOOMED: RemoteViewTransform = {
  zoom: 2,
  origin: { x: 25, y: 75 },
  pan: { x: -10, y: 4 },
};

const layer = (view: RemoteViewTransform): string =>
  renderToStaticMarkup(
    <RemoteViewAdjustLayer
      view={view}
      canZoomIn
      canZoomOut
      onZoomIn={() => undefined}
      onZoomOut={() => undefined}
      onReset={() => undefined}
      onPanBy={() => undefined}
      onPaneResize={() => undefined}
      onDone={() => undefined}
    />,
  );

describe("RemoteViewZoomToggle", () => {
  it("says what pressing it will do, in both states", () => {
    const idle = renderToStaticMarkup(
      <RemoteViewZoomToggle
        adjusting={false}
        view={REMOTE_VIEW_IDENTITY}
        onToggle={() => undefined}
      />,
    );
    expect(idle).toContain('aria-label="Zoom and move the picture"');
    expect(idle).toContain('aria-pressed="false"');

    const active = renderToStaticMarkup(
      <RemoteViewZoomToggle adjusting view={ZOOMED} onToggle={() => undefined} />,
    );
    expect(active).toContain('aria-label="Lock the zoom and position"');
    expect(active).toContain('aria-pressed="true"');
  });

  it("shows the factor only once there is one worth showing", () => {
    expect(
      renderToStaticMarkup(
        <RemoteViewZoomToggle
          adjusting={false}
          view={REMOTE_VIEW_IDENTITY}
          onToggle={() => undefined}
        />,
      ),
    ).not.toContain("×");
    expect(
      renderToStaticMarkup(
        <RemoteViewZoomToggle adjusting={false} view={ZOOMED} onToggle={() => undefined} />,
      ),
    ).toContain("2×");
  });
});

describe("RemoteViewAdjustLayer", () => {
  it("renders its controls without a host surface", () => {
    const markup = layer(ZOOMED);
    expect(markup).toContain('aria-label="Zoom in"');
    expect(markup).toContain('aria-label="Zoom out"');
    expect(markup).toContain('aria-label="Reset the view"');
    expect(markup).toContain("Lock in");
    expect(markup).toContain('data-remote-view-adjusting="true"');
  });

  it("tells the viewer that nothing is being sent while they adjust", () => {
    // The mode silently suspends remote input; saying so is the difference
    // between "safe to drag" and "why is my drag not doing anything".
    expect(layer(REMOTE_VIEW_IDENTITY)).toContain("nothing is sent while adjusting");
  });

  it("switches the hint once there is something to drag around", () => {
    expect(layer(ZOOMED)).toContain("Drag to move around");
  });
});
