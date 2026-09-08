import { describe, expect, it } from "vite-plus/test";

import { refineBrowserViewportHostScale } from "./browserViewportCompensation";

describe("refineBrowserViewportHostScale", () => {
  it("compensates for embedder zoom on both viewport axes", () => {
    expect(
      refineBrowserViewportHostScale({
        current: { width: 1, height: 1 },
        expected: { width: 667, height: 375 },
        rendered: { width: 609, height: 342 },
      }),
    ).toEqual({
      width: 667 / 609,
      height: 375 / 342,
    });
  });

  it("settles when Electron is within one rounded CSS pixel", () => {
    expect(
      refineBrowserViewportHostScale({
        current: { width: 1.1, height: 1.1 },
        expected: { width: 667, height: 375 },
        rendered: { width: 668, height: 374 },
      }),
    ).toBeNull();
  });

  it("bounds corrupt measurements instead of exploding the host surface", () => {
    expect(
      refineBrowserViewportHostScale({
        current: { width: 1, height: 1 },
        expected: { width: 4096, height: 4096 },
        rendered: { width: 1, height: 1 },
      }),
    ).toEqual({ width: 4, height: 4 });
  });
});
