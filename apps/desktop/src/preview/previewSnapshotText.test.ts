import { describe, expect, it } from "vite-plus/test";

import {
  collectFrameIdsFromTree,
  isPdfPreviewDocument,
  mergeAccessibilityTrees,
  visibleTextFromAccessibilityTree,
} from "./previewSnapshotText.ts";

describe("preview snapshot text", () => {
  it("recognizes PDF viewers from URL, title, and content type", () => {
    expect(
      isPdfPreviewDocument({
        url: "https://example.com/report.pdf",
        title: "report.pdf",
      }),
    ).toBe(true);
    expect(
      isPdfPreviewDocument({
        url: "https://example.com/view",
        title: "Invoice",
        contentType: "application/pdf",
      }),
    ).toBe(true);
    expect(isPdfPreviewDocument({ url: "https://example.com/", title: "Home" })).toBe(false);
  });

  it("joins Chromium AX StaticText nodes for PDF-style trees", () => {
    const text = visibleTextFromAccessibilityTree(
      {
        nodes: [
          { role: { value: "StaticText" }, name: { value: "Chapter 1" } },
          { role: { value: "StaticText" }, name: { value: "The aisle board" } },
        ],
      },
      200,
    );
    expect(text).toBe("Chapter 1 The aisle board");
  });

  it("walks nested Chromium frame trees", () => {
    expect(
      collectFrameIdsFromTree({
        frameTree: {
          frame: { id: "main" },
          childFrames: [
            { frame: { id: "pdf-plugin" } },
            {
              frame: { id: "sidebar" },
              childFrames: [{ frame: { id: "nested" } }],
            },
          ],
        },
      }),
    ).toEqual(["main", "pdf-plugin", "sidebar", "nested"]);
  });

  it("joins AX trees from the plugin frame when the main frame is an empty iframe", () => {
    const tree = mergeAccessibilityTrees([
      {
        nodes: [{ role: { value: "Iframe" }, name: { value: "" }, childIds: [] }],
      },
      {
        nodes: [
          { role: { value: "paragraph" }, name: { value: "Trace-based Just-in-Time" } },
          { role: { value: "StaticText" }, name: { value: "Dynamic languages" } },
        ],
      },
    ]);
    expect(visibleTextFromAccessibilityTree(tree, 200)).toBe("Dynamic languages");
  });

  it("falls back to paragraph names when StaticText is missing", () => {
    expect(
      visibleTextFromAccessibilityTree(
        {
          nodes: [{ role: { value: "paragraph" }, name: { value: "Abstract" } }],
        },
        200,
      ),
    ).toBe("Abstract");
  });
});
