import { describe, expect, it } from "vite-plus/test";

import { hasArm64Slice } from "./check-mac-arm64-artifact.ts";

describe("hasArm64Slice", () => {
  it("accepts an arm64 or universal binary", () => {
    expect(hasArm64Slice("arm64\n")).toBe(true);
    expect(hasArm64Slice("x86_64 arm64\n")).toBe(true);
  });

  it("refuses an Intel binary and a file lipo could not read", () => {
    expect(hasArm64Slice("x86_64\n")).toBe(false);
    expect(hasArm64Slice("")).toBe(false);
  });
});
