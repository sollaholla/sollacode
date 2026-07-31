import { describe, expect, it } from "vite-plus/test";

import {
  isRemoteImageReferenceContext,
  resolveImageReferenceAssetPath,
  shouldOpenImageReferenceInFullScreen,
  THIN_PORTRAIT_MOBILE_MEDIA_QUERY,
} from "./mobileImageViewer";

describe("mobile image viewer routing", () => {
  it("recognizes only the thin portrait coarse-pointer surface", () => {
    expect(THIN_PORTRAIT_MOBILE_MEDIA_QUERY).toBe(
      "(max-width: 639px) and (orientation: portrait) and (pointer: coarse)",
    );
  });

  it("treats browser-hosted threads and persisted desktop hosts as remote image sources", () => {
    expect(
      isRemoteImageReferenceContext({
        hasThreadContext: true,
        isDesktopRuntime: false,
        environmentKind: "primary",
        differsFromPrimaryEnvironment: false,
      }),
    ).toBe(true);
    expect(
      isRemoteImageReferenceContext({
        hasThreadContext: true,
        isDesktopRuntime: true,
        environmentKind: "remote",
        differsFromPrimaryEnvironment: false,
      }),
    ).toBe(true);
  });

  it("keeps primary and secondary host-managed desktop images on the local route", () => {
    expect(
      isRemoteImageReferenceContext({
        hasThreadContext: true,
        isDesktopRuntime: true,
        environmentKind: "primary",
        differsFromPrimaryEnvironment: false,
      }),
    ).toBe(false);
    expect(
      isRemoteImageReferenceContext({
        hasThreadContext: true,
        isDesktopRuntime: true,
        environmentKind: "desktop-local",
        differsFromPrimaryEnvironment: true,
      }),
    ).toBe(false);
  });

  it("routes workspace image references to the full-screen viewer on thin portrait mobile", () => {
    expect(
      shouldOpenImageReferenceInFullScreen({
        isThinPortraitMobile: true,
        isRemoteThread: false,
        filePath: "art/reference.PNG",
        assetPath: "art/reference.PNG",
        hasThreadContext: true,
        hasImageViewer: true,
      }),
    ).toBe(true);
  });

  it("routes connected remote workspace images to the full-screen viewer on desktop", () => {
    expect(
      shouldOpenImageReferenceInFullScreen({
        isThinPortraitMobile: false,
        isRemoteThread: true,
        filePath: "D:/TerraGen/Temp/reference.png",
        assetPath: "Temp/reference.png",
        hasThreadContext: true,
        hasImageViewer: true,
      }),
    ).toBe(true);
  });

  it("routes a message-authorized absolute remote /tmp image to the full-screen viewer", () => {
    const filePath = "/tmp/live_billboard_move_sweep/move_sweep_mosaic.png";
    const assetPath = resolveImageReferenceAssetPath({
      filePath,
      workspaceRelativePath: null,
      isRemoteThread: true,
      hasSourceMessage: true,
    });
    expect(assetPath).toBe(filePath);
    expect(
      shouldOpenImageReferenceInFullScreen({
        isThinPortraitMobile: false,
        isRemoteThread: true,
        filePath,
        assetPath,
        hasThreadContext: true,
        hasImageViewer: true,
      }),
    ).toBe(true);
  });

  it("does not route an unproven absolute remote path into the asset API", () => {
    expect(
      resolveImageReferenceAssetPath({
        filePath: "/tmp/unlinked.png",
        workspaceRelativePath: null,
        isRemoteThread: true,
        hasSourceMessage: false,
      }),
    ).toBeNull();
  });

  it.each([
    {
      label: "wide desktop",
      input: {
        isThinPortraitMobile: false,
        isRemoteThread: false,
        filePath: "art/reference.png",
        assetPath: "art/reference.png",
        hasThreadContext: true,
        hasImageViewer: true,
      },
    },
    {
      label: "non-image reference",
      input: {
        isThinPortraitMobile: true,
        isRemoteThread: false,
        filePath: "src/index.ts",
        assetPath: "src/index.ts",
        hasThreadContext: true,
        hasImageViewer: true,
      },
    },
    {
      label: "outside the workspace",
      input: {
        isThinPortraitMobile: true,
        isRemoteThread: false,
        filePath: "/tmp/reference.png",
        assetPath: null,
        hasThreadContext: true,
        hasImageViewer: true,
      },
    },
    {
      label: "missing thread context",
      input: {
        isThinPortraitMobile: true,
        isRemoteThread: false,
        filePath: "art/reference.png",
        assetPath: "art/reference.png",
        hasThreadContext: false,
        hasImageViewer: true,
      },
    },
    {
      label: "missing image viewer",
      input: {
        isThinPortraitMobile: true,
        isRemoteThread: false,
        filePath: "art/reference.png",
        assetPath: "art/reference.png",
        hasThreadContext: true,
        hasImageViewer: false,
      },
    },
  ])("retains the existing file action for $label", ({ input }) => {
    expect(shouldOpenImageReferenceInFullScreen(input)).toBe(false);
  });
});
