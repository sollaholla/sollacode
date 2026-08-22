import { describe, expect, it } from "vite-plus/test";

import { disabledCaptureFeatures } from "./DesktopCaptureCompatibility.ts";

describe("desktop capture compatibility", () => {
  it("opts Windows out of the WGC monitor capturer", () => {
    expect(disabledCaptureFeatures("win32")).toBe("WebRtcAllowWgcScreenCapturer");
  });

  it("does not change capture backends on other platforms", () => {
    expect(disabledCaptureFeatures("darwin")).toBeUndefined();
    expect(disabledCaptureFeatures("linux")).toBeUndefined();
  });
});
