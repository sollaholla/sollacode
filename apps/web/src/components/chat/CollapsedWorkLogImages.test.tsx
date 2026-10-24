// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, type AssetResource } from "@t3tools/contracts";
import { workLogThreadImage } from "@t3tools/client-runtime/state/thread-images";
import { collectWorkLogImages } from "@t3tools/client-runtime/state/work-log-images";
import { CollapsedWorkLogImages } from "./CollapsedWorkLogImages";
import { ExpandedImageDialog } from "./ExpandedImageDialog";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { expandedImageItem } from "./timelineImageGallery";

const assets = vi.hoisted(() => ({ paths: new Set<string>(), fail: false }));
vi.mock("../../assets/assetUrls", () => ({
  useAssetUrlState: (_environment: unknown, resource: AssetResource) => {
    const path = resource._tag === "workspace-file" ? resource.path : "attachment";
    assets.paths.add(path);
    return assets.fail
      ? { _tag: "Failure" }
      : { _tag: "Success", url: `https://host.example/${path}` };
  },
  withAssetRevision: (url: string) => url,
}));

describe("collapsed image index", () => {
  let root: Root;
  let container: HTMLDivElement;
  let width: number;
  let resized: () => void;
  let disconnect: ReturnType<typeof vi.fn>;
  const images = collectWorkLogImages(
    Array.from({ length: 50 }, (_, index) => ({
      id: `${index}`,
      readImagePath: `image-${index}.png`,
    })),
  );
  const openImage = vi.fn();
  const toggleLog = vi.fn();
  const ctx = {
    environmentId: EnvironmentId.make("host"),
    threadId: ThreadId.make("thread"),
    onImageOpen: openImage,
  };

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    // happy-dom has no pointer capture; the image only needs the call to exist.
    HTMLElement.prototype.setPointerCapture ??= () => {};
    assets.paths.clear();
    assets.fail = false;
    openImage.mockClear();
    toggleLog.mockClear();
    width = 326;
    disconnect = vi.fn();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      width,
      height: 52,
      top: 0,
      left: 0,
      right: width,
      bottom: 52,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }));
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resized = callback;
        }
        observe() {}
        unobserve() {}
        disconnect = disconnect;
      },
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const render = async (selected = images) =>
    act(async () =>
      root.render(
        <div onClick={toggleLog} onKeyDown={toggleLog}>
          <CollapsedWorkLogImages images={selected} {...ctx} />
        </div>,
      ),
    );
  const click = async (label: string) => {
    const button = [...document.querySelectorAll("button")].find(
      (element) => element.getAttribute("aria-label") === label || element.textContent === label,
    );
    if (!button) throw new Error(`Missing button: ${label}`);
    await act(async () => button.click());
  };

  it("loads only one bounded row and reflows its count without changing row height", async () => {
    await render();
    expect(container.querySelectorAll("img")).toHaveLength(5);
    expect(assets.paths.size).toBe(5);
    expect(container.textContent).toContain("+45 more");
    const row = container.querySelector('[aria-label="50 images viewed"]');
    expect(row?.classList.contains("h-[52px]")).toBe(true);
    width = 176;
    await act(async () => resized());
    expect(container.querySelectorAll("img")).toHaveLength(2);
    expect(container.textContent).toContain("+48 more");
    expect(row?.classList.contains("h-[52px]")).toBe(true);
  });

  it("opens a thumbnail with the usual image viewer without expanding its log", async () => {
    await render();
    const button = container.querySelector<HTMLButtonElement>(
      '[aria-label="Open image: image-0.png"]',
    )!;
    await act(async () =>
      button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    await click("Open image: image-0.png");
    expect(toggleLog).not.toHaveBeenCalled();
    expect(openImage).toHaveBeenCalledWith("file:0:image-0.png", {
      images: [{ src: "https://host.example/image-0.png", name: "image-0.png" }],
      index: 0,
    });
  });

  it("opens overflow independently, loads in batches, and opens a gallery image", async () => {
    await render();
    await click("View all 50 images");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Images viewed");
    expect(assets.paths.size).toBe(24);
    await click("Load more images");
    expect(assets.paths.size).toBe(48);
    await click("Open image: image-30.png");
    expect(openImage).toHaveBeenCalledWith("file:30:image-30.png", {
      images: [{ src: "https://host.example/image-30.png", name: "image-30.png" }],
      index: 0,
    });
    expect(toggleLog).not.toHaveBeenCalled();
  });

  it("draws a small copy of the file, and opens the whole image", async () => {
    await render(collectWorkLogImages([{ id: "read", readImagePath: "shot.png" }]));
    expect(container.querySelector("img")?.src).toBe("https://host.example/shot.png?thumbnail=1");
    await click("Open image: shot.png");
    expect(openImage).toHaveBeenCalledWith("file:read:shot.png", {
      images: [{ src: "https://host.example/shot.png", name: "shot.png" }],
      index: 0,
    });
  });

  it("falls back to the stored copy, then drops an image nothing can show", async () => {
    await render(
      collectWorkLogImages([
        { id: "kept", readImagePath: "kept.png" },
        {
          id: "stored",
          readImagePath: "gone.png",
          readImageInlineSrc: "data:image/png;base64,AAAA",
        },
      ]),
    );
    const gone = () => container.querySelector<HTMLImageElement>('img[alt="gone.png"]');
    await act(async () => gone()!.dispatchEvent(new Event("error")));
    expect(gone()?.src).toBe("data:image/png;base64,AAAA");
    await act(async () => gone()!.dispatchEvent(new Event("error")));
    // Reported 2026-10-11: blank tiles read as broken images. It leaves the row.
    expect(gone()).toBeNull();
    expect(container.querySelector('[aria-label="Open image: gone.png"]')).toBeNull();
    expect(container.querySelectorAll("img")).toHaveLength(1);
    // The last image going takes the row with it.
    await act(async () => container.querySelector("img")!.dispatchEvent(new Event("error")));
    expect(container.querySelector("[data-work-log-images]")).toBeNull();
  });

  it("draws a browser snapshot straight from its stored bytes", async () => {
    const src = "data:image/jpeg;base64,/9j/";
    await render(collectWorkLogImages([{ id: "snapshot", snapshotImageSrc: src }]));
    // Nothing to fetch: the tool result is the only copy of the page.
    expect(assets.paths.size).toBe(0);
    expect(container.querySelector("img")?.src).toBe(src);
    await click("Open image: Browser snapshot");
    expect(openImage).toHaveBeenCalledWith("stored:snapshot", {
      images: [{ src, name: "Browser snapshot" }],
      index: 0,
    });
    // A copy that cannot decode is not shown at all.
    await act(async () => container.querySelector("img")!.dispatchEvent(new Event("error")));
    expect(container.querySelector("[data-work-log-images]")).toBeNull();
  });

  it("closes the gallery with Escape from a focused thumbnail", async () => {
    await render();
    await click("View all 50 images");
    const thumbnail = document.querySelector<HTMLButtonElement>(
      '[role="dialog"] button[aria-label="Open image: image-0.png"]',
    );
    await act(async () => {
      thumbnail!.focus();
      thumbnail!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"] img')).toBeNull();
  });

  it("keeps a thousand-image log to one row without resolving its overflow", async () => {
    const many = collectWorkLogImages(
      Array.from({ length: 1000 }, (_, index) => ({
        id: `${index}`,
        readImagePath: `image-${index}.png`,
      })),
    );
    await render(many);
    expect(container.querySelectorAll("img")).toHaveLength(5);
    expect(assets.paths.size).toBe(5);
    expect(container.textContent).toContain("+995 more");
    await click("View all 1000 images");
    expect(assets.paths.size).toBe(24);
    expect(document.querySelectorAll('[role="dialog"] img')).toHaveLength(24);
  });

  function ViewerHarness(props: { readonly mobile: boolean }) {
    const [preview, setPreview] = useState<ExpandedImagePreview | null>(null);
    return (
      <>
        <CollapsedWorkLogImages
          images={images}
          {...ctx}
          onImageOpen={(imageId, fallback) => {
            // As the timeline does: open on the image among all of them.
            const index = images.findIndex((image) => image.id === imageId);
            setPreview(
              index < 0
                ? fallback
                : {
                    images: images.flatMap((image) => {
                      const item = workLogThreadImage(image, ctx.threadId);
                      return item ? [expandedImageItem(item, ctx.environmentId)] : [];
                    }),
                    index,
                  },
            );
          }}
        />
        {preview ? (
          <ExpandedImageDialog
            preview={preview}
            fullScreenMobile={props.mobile}
            onClose={() => setPreview(null)}
          />
        ) : null}
      </>
    );
  }
  const viewer = () => document.querySelector('[aria-label="Expanded image preview"]');
  const shownImage = () =>
    viewer()?.querySelector<HTMLImageElement>("[data-zoomable-image] img")?.src;
  const drag = async (
    path: readonly number[],
    options: { readonly pointerType?: string; readonly pointerId?: number } = {},
  ) => {
    const surface = viewer()!.querySelector("[data-zoomable-image]")!;
    const pointer = (type: string, clientX: number) =>
      surface.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          isPrimary: true,
          pointerId: options.pointerId ?? 1,
          pointerType: options.pointerType ?? "touch",
          clientX,
          clientY: 300,
        }),
      );
    await act(async () => {
      pointer("pointerdown", path[0]!);
      for (const x of path.slice(1)) pointer("pointermove", x);
      pointer("pointerup", path.at(-1)!);
    });
  };

  it.each([false, true])(
    "hands gallery selection to the actual image viewer (mobile=%s)",
    async (mobile) => {
      await act(async () => root.render(<ViewerHarness mobile={mobile} />));
      await click("View all 50 images");
      await click("Open image: image-10.png");
      expect(shownImage()).toBe("https://host.example/image-10.png");
      expect(viewer()?.textContent).toContain("image-10.png (11/50)");
      expect(document.querySelector('[data-slot="dialog-popup"] img')).toBeNull();
      if (mobile) {
        expect(viewer()?.hasAttribute("data-mobile-fullscreen-image-viewer")).toBe(true);
        await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
      } else {
        await click("Close image preview");
      }
      expect(viewer()).toBeNull();
      expect(container.querySelector("[data-work-log-images]")).not.toBeNull();
    },
  );

  it.each([false, true])(
    "swipes a finger sideways to the next and previous image (mobile=%s)",
    async (mobile) => {
      await act(async () => root.render(<ViewerHarness mobile={mobile} />));
      await click("Open image: image-1.png");
      // Images the row never drew are fetched as they come up.
      expect(assets.paths.has("image-2.png")).toBe(true);
      await drag([200, 160, 80]);
      expect(shownImage()).toBe("https://host.example/image-2.png");
      expect(viewer()?.textContent).toContain("(3/50)");
      await drag([80, 120, 200]);
      await drag([80, 120, 200]);
      expect(shownImage()).toBe("https://host.example/image-0.png");
      // A drag that falls short settles back on the same image.
      await drag([200, 195, 190]);
      expect(shownImage()).toBe("https://host.example/image-0.png");
      // A mouse drag never changes the image.
      await drag([200, 100, 20], { pointerType: "mouse" });
      expect(shownImage()).toBe("https://host.example/image-0.png");
    },
  );

  it("drops an image the viewer finds it can't show, ahead of the swipe or on screen", async () => {
    await act(async () => root.render(<ViewerHarness mobile />));
    await click("Open image: image-1.png");
    expect(viewer()?.textContent).toContain("(2/50)");
    // The next image fails while it preloads: the swipe skips it.
    const preload = viewer()!.querySelector<HTMLImageElement>(
      'img[aria-hidden="true"][src="https://host.example/image-2.png"]',
    );
    expect(preload).not.toBeNull();
    await act(async () => preload!.dispatchEvent(new Event("error")));
    expect(viewer()?.textContent).toContain("(2/49)");
    await drag([200, 160, 80]);
    expect(shownImage()).toBe("https://host.example/image-3.png");
    // The shown image fails: the next one takes its place.
    const shown = viewer()!.querySelector("[data-zoomable-image] img")!;
    await act(async () => shown.dispatchEvent(new Event("error")));
    expect(shownImage()).toBe("https://host.example/image-4.png");
    expect(viewer()?.textContent).toContain("(3/48)");
  });

  it("pans a zoomed image instead of swiping away from it", async () => {
    await act(async () => root.render(<ViewerHarness mobile />));
    await click("Open image: image-3.png");
    viewer()!.querySelector("[data-zoomable-image]")!.setAttribute("data-zoomable-image", "zoomed");
    await drag([200, 160, 80]);
    expect(shownImage()).toBe("https://host.example/image-3.png");
  });

  it("renders nothing without images and disconnects measurement when unmounted", async () => {
    await render([]);
    expect(container.querySelector("[data-work-log-images]")).toBeNull();
    await render();
    await act(async () => root.render(null));
    expect(disconnect).toHaveBeenCalled();
  });
});
