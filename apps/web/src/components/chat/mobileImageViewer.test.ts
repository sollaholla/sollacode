import { describe, expect, it } from "vite-plus/test";

import {
  shouldOpenImageReferenceInFullScreen,
  THIN_PORTRAIT_MOBILE_MEDIA_QUERY,
} from "./mobileImageViewer";

describe("mobile image viewer routing", () => {
  it("recognizes only the thin portrait coarse-pointer surface", () => {
    expect(THIN_PORTRAIT_MOBILE_MEDIA_QUERY).toBe(
      "(max-width: 639px) and (orientation: portrait) and (pointer: coarse)",
    );
  });

  it("routes workspace image references to the full-screen viewer on thin portrait mobile", () => {
    expect(
      shouldOpenImageReferenceInFullScreen({
        isThinPortraitMobile: true,
        filePath: "art/reference.PNG",
        workspaceRelativePath: "art/reference.PNG",
        hasThreadContext: true,
        hasImageViewer: true,
      }),
    ).toBe(true);
  });

  it.each([
    {
      label: "wide desktop",
      input: {
        isThinPortraitMobile: false,
        filePath: "art/reference.png",
        workspaceRelativePath: "art/reference.png",
        hasThreadContext: true,
        hasImageViewer: true,
      },
    },
    {
      label: "non-image reference",
      input: {
        isThinPortraitMobile: true,
        filePath: "src/index.ts",
        workspaceRelativePath: "src/index.ts",
        hasThreadContext: true,
        hasImageViewer: true,
      },
    },
    {
      label: "outside the workspace",
      input: {
        isThinPortraitMobile: true,
        filePath: "/tmp/reference.png",
        workspaceRelativePath: null,
        hasThreadContext: true,
        hasImageViewer: true,
      },
    },
    {
      label: "missing thread context",
      input: {
        isThinPortraitMobile: true,
        filePath: "art/reference.png",
        workspaceRelativePath: "art/reference.png",
        hasThreadContext: false,
        hasImageViewer: true,
      },
    },
    {
      label: "missing image viewer",
      input: {
        isThinPortraitMobile: true,
        filePath: "art/reference.png",
        workspaceRelativePath: "art/reference.png",
        hasThreadContext: true,
        hasImageViewer: false,
      },
    },
  ])("retains the existing file action for $label", ({ input }) => {
    expect(shouldOpenImageReferenceInFullScreen(input)).toBe(false);
  });
});
