import { describe, expect, it } from "vite-plus/test";

import {
  isAudioPreviewFile,
  isBrowserPreviewFile,
  isExternalMediaPreviewFile,
  isImagePreviewFile,
  isSvgImagePreviewFile,
  isVideoPreviewFile,
  resolveWorkspaceRelativeFilePath,
} from "./filePath";

describe("resolveWorkspaceRelativeFilePath", () => {
  it("keeps normalized workspace-relative paths", () => {
    expect(resolveWorkspaceRelativeFilePath("/repo", "./src/../src/main.ts")).toBe("src/main.ts");
  });

  it("converts absolute paths inside the workspace", () => {
    expect(
      resolveWorkspaceRelativeFilePath("/Users/julius/repo", "/Users/julius/repo/src/main.ts"),
    ).toBe("src/main.ts");
    expect(resolveWorkspaceRelativeFilePath("C:\\repo", "c:\\repo\\src\\main.ts")).toBe(
      "src/main.ts",
    );
  });

  it("rejects paths outside the workspace", () => {
    expect(resolveWorkspaceRelativeFilePath("/repo", "/other/main.ts")).toBeNull();
    expect(resolveWorkspaceRelativeFilePath("/repo", "../other/main.ts")).toBeNull();
    expect(resolveWorkspaceRelativeFilePath(null, "/repo/main.ts")).toBeNull();
  });
});

describe("file preview types", () => {
  it("recognizes browser and image previews", () => {
    expect(isBrowserPreviewFile("reports/summary.html")).toBe(true);
    expect(isImagePreviewFile("assets/icon.png")).toBe(true);
    expect(isImagePreviewFile("assets/diagram.SVG?raw=1")).toBe(true);
    expect(isImagePreviewFile("src/image.ts")).toBe(false);
  });

  it("identifies SVG images that need web rendering", () => {
    expect(isSvgImagePreviewFile("assets/diagram.svg#icon")).toBe(true);
    expect(isSvgImagePreviewFile("assets/photo.png")).toBe(false);
  });

  it("routes audio and video to the external system player", () => {
    for (const path of ["song.mp3", "Voice Note.WAV", "take.m4a", "loop.ogg"]) {
      expect(isAudioPreviewFile(path)).toBe(true);
      expect(isExternalMediaPreviewFile(path)).toBe(true);
    }
    for (const path of ["clip.mp4", "Screen Recording.MOV", "loop.webm"]) {
      expect(isVideoPreviewFile(path)).toBe(true);
      expect(isExternalMediaPreviewFile(path)).toBe(true);
    }
    expect(isExternalMediaPreviewFile("assets/icon.png")).toBe(false);
    expect(isExternalMediaPreviewFile("src/index.ts")).toBe(false);
  });
});
