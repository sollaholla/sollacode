// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ZoomableImage } from "./ZoomableImage";

let container: HTMLDivElement;
let root: Root;

function sized(element: Element, width: number, height: number) {
  for (const [key, value] of Object.entries({
    offsetWidth: width,
    offsetHeight: height,
    clientWidth: width,
    clientHeight: height,
  })) {
    Object.defineProperty(element, key, { configurable: true, value });
  }
}

function pointer(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup",
  pointerId: number,
  clientX: number,
  clientY: number,
) {
  target.dispatchEvent(
    new PointerEvent(type, { bubbles: true, pointerId, pointerType: "touch", clientX, clientY }),
  );
}

async function renderImage() {
  await act(async () => root.render(<ZoomableImage src="shot.png" alt="Screenshot" />));
  const surface = container.querySelector("[data-zoomable-image]")!;
  const image = container.querySelector("img")!;
  // A landscape screenshot fitted to a phone-sized viewer.
  sized(surface, 400, 700);
  sized(image, 400, 225);
  return { surface, image };
}

describe("ZoomableImage", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    // happy-dom has no pointer capture; the component only needs the call to exist.
    HTMLElement.prototype.setPointerCapture ??= () => {};
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("claims touches so the page cannot zoom or scroll instead", async () => {
    const { surface } = await renderImage();
    expect(surface.className).toContain("touch-none");
    expect(surface.getAttribute("data-zoomable-image")).toBe("fit");
  });

  it("pinches in with two fingers and pans with one once zoomed", async () => {
    const { surface, image } = await renderImage();
    await act(async () => {
      pointer(surface, "pointerdown", 1, -50, 0);
      pointer(surface, "pointerdown", 2, 50, 0);
      pointer(surface, "pointermove", 2, 150, 0);
    });
    // The fingers spread from 100 to 200 px apart: twice the size.
    expect(image.style.transform).toContain("scale(2)");
    expect(surface.getAttribute("data-zoomable-image")).toBe("zoomed");

    await act(async () => {
      pointer(surface, "pointerup", 2, 150, 0);
      pointer(surface, "pointermove", 1, -20, 0);
    });
    // The remaining finger drags the zoomed image 30 px to the right.
    expect(image.style.transform).toBe("translate3d(80px, 0px, 0) scale(2)");
    await act(async () => pointer(surface, "pointerup", 1, -20, 0));
  });

  it("ignores a one-finger drag on an unzoomed image", async () => {
    const { surface, image } = await renderImage();
    await act(async () => {
      pointer(surface, "pointerdown", 1, 0, 0);
      pointer(surface, "pointermove", 1, 120, 40);
      pointer(surface, "pointerup", 1, 120, 40);
    });
    expect(image.style.transform).toBe("");
  });

  it("double tap zooms in and a second double tap fits it again", async () => {
    const { surface, image } = await renderImage();
    const tap = () => {
      pointer(surface, "pointerdown", 1, 40, 0);
      pointer(surface, "pointerup", 1, 40, 0);
    };
    await act(async () => {
      tap();
      tap();
    });
    expect(image.style.transform).toContain("scale(2.5)");
    await act(async () => {
      tap();
      tap();
    });
    expect(image.style.transform).toBe("");
    expect(surface.getAttribute("data-zoomable-image")).toBe("fit");
  });
});
