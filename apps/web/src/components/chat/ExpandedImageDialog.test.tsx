import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ExpandedImageDialog } from "./ExpandedImageDialog";

const preview = {
  images: [{ src: "https://example.test/reference.png", name: "reference.png" }],
  index: 0,
};

describe("ExpandedImageDialog", () => {
  it("uses a safe-area full-screen viewer with exactly one dismissal control", () => {
    const html = renderToStaticMarkup(
      <ExpandedImageDialog preview={preview} onClose={() => {}} fullScreenMobile />,
    );

    expect(html).toContain("data-mobile-fullscreen-image-viewer");
    expect(html).toContain("h-[100dvh]");
    expect(html).toContain("pt-safe");
    expect(html).toContain("pb-safe");
    expect(html).toContain('aria-label="Back from image preview"');
    // Reported 2026-09-18: the header carried a back arrow AND an X, both
    // wired to the same dismiss.
    expect(html).not.toContain('aria-label="Close image preview"');
    expect(html).toContain('role="dialog"');
    // The page is pinned at its initial scale, so the viewer owns pinch zoom.
    expect(html).toContain('data-zoomable-image="fit"');
    expect(html).toContain("touch-none");
  });

  it("retains the bounded desktop dialog presentation", () => {
    const html = renderToStaticMarkup(<ExpandedImageDialog preview={preview} onClose={() => {}} />);

    expect(html).not.toContain("data-mobile-fullscreen-image-viewer");
    expect(html).toContain("max-h-[92vh]");
    expect(html).toContain("max-w-[92vw]");
  });
});
