import { describe, expect, it } from "vite-plus/test";

import { resolveReadImagePreview } from "./readImagePreview.ts";

const STORED = "data:image/png;base64,iVBORw0KGgo";
const LIVE = "http://host/api/assets/token/shot.png";
const none: ReadonlySet<string> = new Set();

describe("read-image preview source", () => {
  it("waits while the asset request is in flight, even with a stored copy", () => {
    expect(
      resolveReadImagePreview({
        assetFailed: false,
        assetUrl: null,
        storedSrc: STORED,
        failedSrcs: none,
      }),
    ).toEqual({ _tag: "Loading" });
  });

  it("prefers the live file, which is the one that stays current", () => {
    expect(
      resolveReadImagePreview({
        assetFailed: false,
        assetUrl: LIVE,
        storedSrc: STORED,
        failedSrcs: none,
      }),
    ).toEqual({ _tag: "Image", src: LIVE, stored: false });
  });

  it("falls back to the stored copy when the file is gone", () => {
    expect(
      resolveReadImagePreview({
        assetFailed: true,
        assetUrl: null,
        storedSrc: STORED,
        failedSrcs: none,
      }),
    ).toEqual({ _tag: "Image", src: STORED, stored: true });
  });

  it("falls back when the file resolves but its image will not decode", () => {
    expect(
      resolveReadImagePreview({
        assetFailed: false,
        assetUrl: LIVE,
        storedSrc: STORED,
        failedSrcs: new Set([LIVE]),
      }),
    ).toEqual({ _tag: "Image", src: STORED, stored: true });
  });

  it("gives up once both the file and the stored copy have failed", () => {
    expect(
      resolveReadImagePreview({
        assetFailed: false,
        assetUrl: LIVE,
        storedSrc: STORED,
        failedSrcs: new Set([LIVE, STORED]),
      }),
    ).toEqual({ _tag: "Unavailable" });
  });

  it("gives up when the file is gone and no copy was stored", () => {
    expect(
      resolveReadImagePreview({
        assetFailed: true,
        assetUrl: null,
        storedSrc: null,
        failedSrcs: none,
      }),
    ).toEqual({ _tag: "Unavailable" });
  });

  it("never loops back to a live URL that already failed", () => {
    const first = resolveReadImagePreview({
      assetFailed: false,
      assetUrl: LIVE,
      storedSrc: STORED,
      failedSrcs: new Set([LIVE]),
    });
    expect(first).toEqual({ _tag: "Image", src: STORED, stored: true });
    const afterStoredAlsoFails = resolveReadImagePreview({
      assetFailed: false,
      assetUrl: LIVE,
      storedSrc: STORED,
      failedSrcs: new Set([LIVE, STORED]),
    });
    expect(afterStoredAlsoFails).toEqual({ _tag: "Unavailable" });
  });
});
