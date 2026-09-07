// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { RemoteViewZoomReadout } from "./RemoteViewZoom.tsx";
import { REMOTE_VIEW_IDENTITY, type RemoteViewTransform } from "./remoteViewTransform.ts";

const ZOOMED: RemoteViewTransform = {
  zoom: 2,
  origin: { x: 25, y: 75 },
  pan: { x: -10, y: 4 },
};

describe("RemoteViewZoomReadout", () => {
  it("stays out of the way until there is a zoom to show", () => {
    expect(
      renderToStaticMarkup(
        <RemoteViewZoomReadout view={REMOTE_VIEW_IDENTITY} onReset={() => undefined} />,
      ),
    ).toBe("");
  });

  it("shows the factor and says that pressing it resets", () => {
    const markup = renderToStaticMarkup(
      <RemoteViewZoomReadout view={ZOOMED} onReset={() => undefined} />,
    );
    expect(markup).toContain("2×");
    expect(markup).toContain("Reset the view");
  });
});
