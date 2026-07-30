import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ExpandedImageDialog } from "./ExpandedImageDialog";

const preview = {
  images: [{ src: "https://example.test/reference.png", name: "reference.png" }],
  index: 0,
};

describe("ExpandedImageDialog", () => {
  it("uses a safe-area full-screen viewer with both mobile dismissal controls", () => {
    const html = renderToStaticMarkup(
      <ExpandedImageDialog preview={preview} onClose={() => {}} fullScreenMobile />,
    );

    expect(html).toContain("data-mobile-fullscreen-image-viewer");
    expect(html).toContain("h-[100dvh]");
    expect(html).toContain("pt-safe");
    expect(html).toContain("pb-safe");
    expect(html).toContain('aria-label="Back from image preview"');
    expect(html).toContain('aria-label="Close image preview"');
    expect(html).toContain('role="dialog"');
  });

  it("retains the bounded desktop dialog presentation", () => {
    const html = renderToStaticMarkup(<ExpandedImageDialog preview={preview} onClose={() => {}} />);

    expect(html).not.toContain("data-mobile-fullscreen-image-viewer");
    expect(html).toContain("max-h-[92vh]");
    expect(html).toContain("max-w-[92vw]");
  });
});
