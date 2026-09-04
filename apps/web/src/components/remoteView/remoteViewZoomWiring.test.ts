// @effect-diagnostics nodeBuiltinImport:off - this test reads sources to assert
// wiring invariants, which is a build-time concern rather than app runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

/**
 * The zoom is only as good as the two things each surface has to remember: put
 * the transform on the picture element, and stop forwarding input while the
 * view is being moved. Miss the first and the control does nothing; miss the
 * second and every pan drags on the remote machine instead.
 *
 * The mirror has a third: its pointer mapping reads a bounding rect, and it
 * must read the element that actually carries the transform, or a zoomed tap
 * lands wherever the picture used to be.
 */
const COMPONENTS = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

const read = (...segments: readonly string[]): string =>
  NodeFS.readFileSync(NodePath.join(COMPONENTS, ...segments), "utf8");

const SURFACES = [
  { name: "remote desktop viewer", file: ["remoteControl", "RemoteControlViewerDialog.tsx"] },
  { name: "phone browser mirror", file: ["preview", "RemoteBrowserFrame.tsx"] },
] as const;

describe("remote view zoom wiring", () => {
  for (const surface of SURFACES) {
    it(`applies the transform to the picture in the ${surface.name}`, () => {
      const source = read(...surface.file);
      expect(
        source,
        "the surface builds a transform it never puts on the picture, so the control does nothing",
      ).toContain("zoomView.style");
      expect(source).toContain("useRemoteViewZoom()");
    });

    it(`stops sending input while the ${surface.name} view is being moved`, () => {
      const source = read(...surface.file);
      expect(
        source,
        "nothing suspends host input during an adjust, so every pan also drags on the remote machine",
      ).toMatch(/viewAdjusting|zoomAdjustingRef\.current/);
    });

    it(`offers the toggle in the ${surface.name}`, () => {
      expect(read(...surface.file)).toContain("<RemoteViewZoomToggle");
    });
  }

  it("maps the mirror's taps against the element that carries the transform", () => {
    const source = read("preview", "RemoteBrowserFrame.tsx");
    const geometry = source.slice(source.indexOf("const contentGeometry"));
    const body = geometry.slice(0, geometry.indexOf("}, []);"));
    expect(
      body,
      "the mirror measures the untransformed container, so a zoomed tap lands where the picture used to be",
    ).toContain("imageRef.current");
  });

  it("gates every one of the mirror's input paths, not just the obvious one", () => {
    // The mirror sends on four separate paths and they do not share a gate:
    // pointer down/move/up are React handlers, wheel is a NATIVE non-passive
    // listener registered in an effect, and keys are their own handler. Gating
    // only pointer-down still let a trackpad scroll and a keystroke through to
    // the page while the viewer was moving their own picture around.
    const source = read("preview", "RemoteBrowserFrame.tsx");
    const handlers = [
      "const handlePointerDown",
      "const handlePointerMove",
      "const handlePointerUp",
      "const handleKeyDown",
      "const onWheel",
    ];
    for (const handler of handlers) {
      const start = source.indexOf(handler);
      expect(start, `${handler} is gone; this check is stale`).toBeGreaterThan(-1);
      const body = source.slice(start, start + 700);
      expect(
        body,
        `${handler} dispatches to the desktop tab without checking whether the viewer is ` +
          `adjusting their own view`,
      ).toContain("zoomAdjustingRef.current");
    }
  });

  it("releases held input when the desktop viewer enters the mode", () => {
    // Forwarding stops the instant the mode is entered, which strands whatever
    // was down at that moment: the remote machine sits on a held W or a
    // pressed mouse button for as long as the viewer spends panning.
    const source = read("remoteControl", "RemoteControlViewerDialog.tsx");
    expect(source).toMatch(/if \(zoomAdjusting\) releasePressedInputs\(\);/);
  });

  it("gates the desktop viewer's on-screen keyboard too", () => {
    // It writes straight to enqueueInput rather than through the surface's
    // handlers, so the central gate never sees it.
    const source = read("remoteControl", "RemoteControlViewerDialog.tsx");
    const start = source.indexOf("onBeforeInput={(event) => {");
    expect(start).toBeGreaterThan(-1);
    expect(
      source.slice(start, start + 500),
      "typing on the on-screen keyboard still reaches the host while the view is being adjusted",
    ).toContain("zoomViewAdjustingRef.current");
  });

  it("writes arbitrary media variants Tailwind can actually compile", () => {
    // Tailwind turns `_` into a space. Written without them, the condition
    // reaches the stylesheet as `(orientation:landscape)and(max-height:34rem)`,
    // which is invalid CSS the browser drops on the floor - the class compiles,
    // ships, and does nothing, which is exactly how this one was first written.
    const sources = [
      read("remoteControl", "RemoteControlViewerDialog.tsx"),
      read("preview", "RemoteBrowserFrame.tsx"),
      read("remoteView", "RemoteViewZoom.tsx"),
    ].join("\n");
    for (const variant of sources.match(/\[@media\([^\]]+\)\]/g) ?? []) {
      expect(
        variant,
        `${variant} joins its media conditions without Tailwind's underscore, so it emits ` +
          `invalid CSS and silently does nothing`,
      ).not.toMatch(/\)and\(|\)or\(/);
    }
  });

  it("keeps the toggle reachable while the adjust layer is up", () => {
    // "Press it again to lock it in" is the whole interaction; a layer stacked
    // over the toggle would strand the viewer in the mode.
    const layer = read("remoteView", "RemoteViewZoom.tsx");
    const stack = layer.slice(layer.indexOf("data-remote-view-adjusting"));
    expect(stack).toContain("z-[35]");
    expect(stack).not.toContain("z-50");
  });
});
