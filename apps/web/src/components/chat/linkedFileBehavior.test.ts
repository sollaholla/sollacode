import { describe, expect, it } from "vite-plus/test";

import { shouldRevealLinkedFileByDefault } from "./linkedFileBehavior";

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
});
