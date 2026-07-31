import { describe, expect, it } from "vite-plus/test";
import {
  isExplicitRelativePath,
  isUncPath,
  isWindowsAbsolutePath,
  isWindowsDrivePath,
  normalizeEmbeddedWindowsAbsolutePath,
} from "./path.ts";

describe("path helpers", () => {
  it("detects windows drive paths", () => {
    expect(isWindowsDrivePath("C:\\repo")).toBe(true);
    expect(isWindowsDrivePath("D:/repo")).toBe(true);
    expect(isWindowsDrivePath("/repo")).toBe(false);
  });

  it("detects UNC paths", () => {
    expect(isUncPath("\\\\server\\share\\repo")).toBe(true);
    expect(isUncPath("C:\\repo")).toBe(false);
  });

  it("detects windows absolute paths", () => {
    expect(isWindowsAbsolutePath("C:\\repo")).toBe(true);
    expect(isWindowsAbsolutePath("\\\\server\\share\\repo")).toBe(true);
    expect(isWindowsAbsolutePath("./repo")).toBe(false);
  });

  it("recovers drive-absolute paths accidentally prefixed with a project label", () => {
    expect(
      normalizeEmbeddedWindowsAbsolutePath(
        "UndeadOpenWorld/C:/Users/soloman/UndeadOpenWorld/build/render.png",
      ),
    ).toBe("C:/Users/soloman/UndeadOpenWorld/build/render.png");
    expect(
      normalizeEmbeddedWindowsAbsolutePath(String.raw`UndeadOpenWorld\D:\renders\preview.png`),
    ).toBe(String.raw`D:\renders\preview.png`);
    expect(
      normalizeEmbeddedWindowsAbsolutePath(
        "TerraGen/D:/TerraGen/Temp/billboard_scene_after_dominant_forest.png",
      ),
    ).toBe("D:/TerraGen/Temp/billboard_scene_after_dominant_forest.png");
    expect(normalizeEmbeddedWindowsAbsolutePath("build/render.png")).toBe("build/render.png");
  });

  it("detects explicit relative paths", () => {
    expect(isExplicitRelativePath(".")).toBe(true);
    expect(isExplicitRelativePath("..")).toBe(true);
    expect(isExplicitRelativePath("./repo")).toBe(true);
    expect(isExplicitRelativePath("..\\repo")).toBe(true);
    expect(isExplicitRelativePath("~/repo")).toBe(false);
  });
});
