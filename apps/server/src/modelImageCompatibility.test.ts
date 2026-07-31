import { describe, expect, it } from "vite-plus/test";

import { HEIC_FIXTURE_BASE64 } from "./modelImageCompatibility.test-fixture.ts";
import {
  prepareModelCompatibleImage,
  UnsupportedModelImageTypeError,
} from "./modelImageCompatibility.ts";

describe("prepareModelCompatibleImage", () => {
  it("converts HEIC uploads to model-compatible JPEG bytes and names", async () => {
    const converted = await prepareModelCompatibleImage({
      bytes: Buffer.from(HEIC_FIXTURE_BASE64, "base64"),
      mimeType: "image/heic",
      name: "FullSizeRender.heic",
      maxOutputBytes: 2 * 1024 * 1024,
    });

    expect(converted.converted).toBe(true);
    expect(converted.mimeType).toBe("image/jpeg");
    expect(converted.name).toBe("FullSizeRender.jpg");
    expect(Array.from(converted.bytes.slice(0, 3))).toEqual([0xff, 0xd8, 0xff]);
  });

  it("leaves already-compatible images unchanged", async () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    const prepared = await prepareModelCompatibleImage({
      bytes,
      mimeType: "image/png",
      name: "diagram.png",
      maxOutputBytes: 2 * 1024 * 1024,
    });

    expect(prepared).toEqual({
      bytes,
      mimeType: "image/png",
      name: "diagram.png",
      converted: false,
    });
  });

  it("rejects unsupported formats before they reach a provider", async () => {
    await expect(
      prepareModelCompatibleImage({
        bytes: Uint8Array.from([1, 2, 3]),
        mimeType: "image/tiff",
        name: "scan.tiff",
        maxOutputBytes: 2 * 1024 * 1024,
      }),
    ).rejects.toBeInstanceOf(UnsupportedModelImageTypeError);
  });
});
