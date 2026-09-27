import { describe, expect, it } from "vite-plus/test";

import { isSmokePlatform, pickArtifact } from "./smoke-packaged-desktop.ts";

describe("smoke-packaged-desktop", () => {
  it("picks the one artifact of the platform's kind", () => {
    const files = [
      "Solla-Code-1.2.3-arm64.zip",
      "Solla-Code-1.2.3-arm64.zip.blockmap",
      "Solla-Code-1.2.3-arm64.dmg",
    ];
    expect(pickArtifact("mac", files)).toBe("Solla-Code-1.2.3-arm64.zip");
    expect(pickArtifact("linux", ["Solla-Code-1.2.3-x86_64.AppImage"])).toBe(
      "Solla-Code-1.2.3-x86_64.AppImage",
    );
    expect(pickArtifact("win", ["Solla-Code-1.2.3-x64.exe", "notes.txt"])).toBe(
      "Solla-Code-1.2.3-x64.exe",
    );
  });

  it("refuses a missing or ambiguous artifact", () => {
    expect(() => pickArtifact("linux", [])).toThrow(/exactly one \.AppImage/u);
    expect(() => pickArtifact("win", ["a.exe", "b.exe"])).toThrow(/found 2/u);
  });

  it("accepts only the platforms the release builds", () => {
    expect(isSmokePlatform("mac")).toBe(true);
    expect(isSmokePlatform("win")).toBe(true);
    expect(isSmokePlatform("darwin")).toBe(false);
    expect(isSmokePlatform(undefined)).toBe(false);
  });
});
