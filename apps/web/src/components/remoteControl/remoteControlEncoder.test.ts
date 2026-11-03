import { describe, expect, it } from "vite-plus/test";

import { higherCaptureLimits } from "./remoteControlEncoder";

describe("higherCaptureLimits", () => {
  it("offers a display's physical size when it is past the normal limit", () => {
    expect(higherCaptureLimits({ width: 1_512, height: 982, scaleFactor: 2 })).toEqual({
      maxWidth: 3_024,
      maxHeight: 1_964,
    });
  });

  it("offers nothing when the normal capture already has every pixel", () => {
    expect(higherCaptureLimits({ width: 1_920, height: 1_080, scaleFactor: 1 })).toBeNull();
    expect(higherCaptureLimits({ width: 1_920, height: 1_080 })).toBeNull();
    expect(higherCaptureLimits(null)).toBeNull();
  });
});
