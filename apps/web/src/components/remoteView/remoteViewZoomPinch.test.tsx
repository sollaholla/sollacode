// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useRemoteViewZoom } from "./RemoteViewZoom";

type Zoom = ReturnType<typeof useRemoteViewZoom>;

function Harness(props: { readonly onZoom: (zoom: Zoom) => void }) {
  const zoom = useRemoteViewZoom();
  const { onZoom } = props;
  useEffect(() => {
    onZoom(zoom);
  });
  return <div ref={zoom.paneRef} />;
}

const sample = (pointerId: number, clientX: number) => ({
  pointerId,
  pointerType: "touch",
  clientX,
  clientY: 300,
});

describe("what a pinch leaves behind", () => {
  let root: Root;
  let zoom: Zoom;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 800, 600),
    );
    root = createRoot(document.createElement("div"));
    await act(async () => {
      root.render(
        <Harness
          onZoom={(next) => {
            zoom = next;
          }}
        />,
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const pinch = async () => {
    await act(async () => {
      expect(zoom.onPointerDown(sample(1, 200))).toBe(false);
      expect(zoom.onPointerDown(sample(2, 500))).toBe(true);
      expect(zoom.onPointerUp(sample(1, 200))).toBe(true);
      expect(zoom.onPointerUp(sample(2, 500))).toBe(true);
    });
  };

  it("keeps a fingertip lifting off from reaching the page", async () => {
    await pinch();
    vi.advanceTimersByTime(249);
    expect(zoom.onPointerDown(sample(3, 210))).toBe(true);
    expect(zoom.onPointerMove(sample(3, 240))).toBe(true);
    expect(zoom.onPointerUp(sample(3, 240))).toBe(true);
  });

  it("gives the page the next touch once the pinch has settled", async () => {
    await pinch();
    vi.advanceTimersByTime(250);
    expect(zoom.onPointerDown(sample(3, 210))).toBe(false);
    expect(zoom.onPointerUp(sample(3, 210))).toBe(false);
  });

  it("lets two fingers pinch again straight away", async () => {
    await pinch();
    await act(async () => {
      expect(zoom.onPointerDown(sample(3, 210))).toBe(true);
      expect(zoom.onPointerDown(sample(4, 520))).toBe(true);
    });
    expect(zoom.pinchingRef.current).toBe(true);
  });
});
