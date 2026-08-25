import { describe, expect, it } from "vite-plus/test";

import {
  resolveLinkedFileAbsolutePath,
  resolveLinkedFilePrimaryAction,
  shouldRevealLinkedFileByDefault,
} from "./linkedFileBehavior";

describe("shouldRevealLinkedFileByDefault", () => {
  it.each([
    "/build/MedXRNativePrototype.apk",
    "/Applications/Solla Code.app",
    "release/client.dmg",
    "artifacts/client.zip",
    "C:\\build\\client.exe:12",
  ])("routes non-text artifact %s to the file explorer", (filePath) => {
    expect(shouldRevealLinkedFileByDefault(filePath)).toBe(true);
  });

  it.each([
    "/repo/src/App.tsx",
    "/repo/README.md",
    "/repo/package.json:14",
    "/repo/scripts/build",
    "/repo/image.png",
    "/repo/report.pdf",
  ])("keeps previewable file %s on its existing open path", (filePath) => {
    expect(shouldRevealLinkedFileByDefault(filePath)).toBe(false);
  });

  it.each([
    "/movies/clip.mp4",
    "/movies/clip.mov?download=1",
    "C:\\media\\clip.webm:12",
    "/audio/master.wav",
    "/documents/brief.docx",
  ])("routes non-text media/document %s away from the text preview", (filePath) => {
    expect(shouldRevealLinkedFileByDefault(filePath)).toBe(true);
  });
});

describe("resolveLinkedFilePrimaryAction", () => {
  const base = {
    filePath: "/movies/clip.mp4",
    workspaceRelativePath: "media/clip.mp4",
    hasImageAction: false,
    hasBrowserAction: false,
    canRevealOnThisDevice: true,
  };

  it("reveals local media instead of feeding it to the text preview", () => {
    expect(resolveLinkedFilePrimaryAction(base)).toBe("reveal");
  });

  it("never sends a remote media path to the local file explorer", () => {
    expect(resolveLinkedFilePrimaryAction({ ...base, canRevealOnThisDevice: false })).toBe(
      "editor",
    );
  });

  it("reveals any same-machine path outside the current workspace", () => {
    expect(
      resolveLinkedFilePrimaryAction({
        ...base,
        filePath: "/Downloads/reference.txt",
        workspaceRelativePath: null,
      }),
    ).toBe("reveal");
  });

  it("does not offer outside-workspace HTML or PDF to the authenticated browser preview", () => {
    expect(
      resolveLinkedFilePrimaryAction({
        ...base,
        filePath: "/Downloads/report.pdf",
        workspaceRelativePath: null,
        hasBrowserAction: true,
      }),
    ).toBe("reveal");
    expect(
      resolveLinkedFilePrimaryAction({
        ...base,
        filePath: "/Downloads/report.html",
        workspaceRelativePath: null,
        hasBrowserAction: true,
        canRevealOnThisDevice: false,
      }),
    ).toBe("editor");
  });

  it("keeps image and integrated-browser actions ahead of reveal", () => {
    expect(resolveLinkedFilePrimaryAction({ ...base, hasImageAction: true })).toBe("image");
    expect(resolveLinkedFilePrimaryAction({ ...base, hasBrowserAction: true })).toBe("browser");
  });
});

describe("resolveLinkedFileAbsolutePath", () => {
  it("resolves a relative tool path against the workspace before desktop reveal", () => {
    expect(resolveLinkedFileAbsolutePath("captures/frame.png", "/repo/project")).toBe(
      "/repo/project/captures/frame.png",
    );
  });

  it("preserves absolute paths and rejects unscoped relative paths", () => {
    expect(resolveLinkedFileAbsolutePath("/tmp/frame.png", "/repo/project")).toBe("/tmp/frame.png");
    expect(resolveLinkedFileAbsolutePath("captures/frame.png", undefined)).toBeNull();
  });
});
