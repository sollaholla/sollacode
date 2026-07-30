import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  SEND_IMAGE_MAX_BYTES,
  SEND_IMAGE_PAYLOAD_LIMIT_BYTES,
  SendImagePreparationError,
  prepareImageAttachmentsForSend,
  prepareImageForSend,
} from "./sendImageCompression";

const originalCreateImageBitmap = globalThis.createImageBitmap;
const originalOffscreenCanvas = globalThis.OffscreenCanvas;

function makeFile(sizeBytes: number, type = "image/jpeg", name = "photo.jpg"): File {
  return new File([new Uint8Array(sizeBytes).fill(7)], name, { type });
}

function stubCanvasPipeline(
  sizeForEncoding: (input: {
    readonly type: string;
    readonly quality: number;
    readonly width: number;
  }) => number,
  options?: { readonly supportsWebp?: boolean },
) {
  const close = vi.fn();
  const fillRect = vi.fn();
  const drawImage = vi.fn();
  const encodings: Array<{ type: string; quality: number; width: number }> = [];
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 6000, height: 4000, close })),
  );
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return { fillStyle: "", fillRect, drawImage };
      }
      async convertToBlob({ type, quality }: { type: string; quality: number }) {
        encodings.push({ type, quality, width: this.width });
        if (type === "image/webp" && options?.supportsWebp === false) {
          return new Blob([new Uint8Array(16)], { type: "image/png" });
        }
        return new Blob([new Uint8Array(sizeForEncoding({ type, quality, width: this.width }))], {
          type,
        });
      }
    },
  );
  return { close, drawImage, encodings, fillRect };
}

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.createImageBitmap = originalCreateImageBitmap;
  globalThis.OffscreenCanvas = originalOffscreenCanvas;
});

describe("prepareImageForSend", () => {
  it("keeps an image at the highest valid byte count without decoding it", async () => {
    const bitmap = vi.fn();
    vi.stubGlobal("createImageBitmap", bitmap);

    const result = await prepareImageForSend(makeFile(SEND_IMAGE_MAX_BYTES));

    expect(result.ok).toBe(true);
    expect(result.ok && result.image.sizeBytes).toBe(SEND_IMAGE_PAYLOAD_LIMIT_BYTES - 1);
    expect(result.ok && result.image.recompressed).toBe(false);
    expect(bitmap).not.toHaveBeenCalled();
  });

  it("does not admit an exact 2 MiB encoding and continues until strictly below it", async () => {
    const { encodings } = stubCanvasPipeline(({ quality }) =>
      quality === 0.9 ? SEND_IMAGE_PAYLOAD_LIMIT_BYTES : SEND_IMAGE_MAX_BYTES,
    );

    const result = await prepareImageForSend(
      makeFile(SEND_IMAGE_PAYLOAD_LIMIT_BYTES, "image/jpeg"),
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.image.sizeBytes).toBe(SEND_IMAGE_MAX_BYTES);
    expect(result.ok && result.image.sizeBytes).toBeLessThan(SEND_IMAGE_PAYLOAD_LIMIT_BYTES);
    expect(encodings.map(({ quality }) => quality).slice(0, 2)).toEqual([0.9, 0.8]);
  });

  it("compresses an oversized JPEG, applies orientation at decode, and updates its payload", async () => {
    const { close, fillRect } = stubCanvasPipeline(() => 700_000);

    const result = await prepareImageForSend(makeFile(12_000_000, "image/jpeg", "camera.JPG"));

    expect(result.ok).toBe(true);
    expect(result.ok && result.image).toMatchObject({
      name: "camera.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 700_000,
      recompressed: true,
    });
    expect(globalThis.createImageBitmap).toHaveBeenCalledWith(expect.any(File), {
      imageOrientation: "from-image",
    });
    expect(fillRect).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it("preserves alpha-capable PNG input by encoding WebP without a matte", async () => {
    const { fillRect, encodings } = stubCanvasPipeline(() => 650_000);

    const result = await prepareImageForSend(makeFile(7_000_000, "image/png", "transparent.png"));

    expect(result.ok).toBe(true);
    expect(result.ok && result.image.mimeType).toBe("image/webp");
    expect(result.ok && result.image.name).toBe("transparent.webp");
    expect(fillRect).not.toHaveBeenCalled();
    expect(encodings[0]?.type).toBe("image/webp");
  });

  it("falls back to PNG when WebP is unavailable so alpha is not flattened", async () => {
    const { fillRect, encodings } = stubCanvasPipeline(() => 500_000, {
      supportsWebp: false,
    });

    const result = await prepareImageForSend(makeFile(5_000_000, "image/png", "overlay.png"));

    expect(result.ok).toBe(true);
    expect(result.ok && result.image.mimeType).toBe("image/png");
    expect(encodings.some(({ type }) => type === "image/png")).toBe(true);
    expect(fillRect).not.toHaveBeenCalled();
  });

  it("downscales iteratively and reports too-large when no valid payload can be produced", async () => {
    const { encodings, close } = stubCanvasPipeline(() => 3_000_000);

    const result = await prepareImageForSend(makeFile(8_000_000, "image/jpeg"));

    expect(result).toEqual({ ok: false, reason: "too-large" });
    expect(new Set(encodings.map(({ width }) => width)).size).toBeGreaterThan(1);
    expect(close).toHaveBeenCalled();
  });
});

describe("prepareImageAttachmentsForSend", () => {
  it("applies the same final gate to every attachment and preserves order", async () => {
    stubCanvasPipeline(() => 400_000);

    const images = await prepareImageAttachmentsForSend([
      { name: "upload.jpg", file: makeFile(3_000_000, "image/jpeg", "upload.jpg") },
      { name: "paste.png", file: makeFile(4_000_000, "image/png", "paste.png") },
      { name: "drop.jpg", file: makeFile(5_000_000, "image/jpeg", "drop.jpg") },
    ]);

    expect(images.map(({ name }) => name)).toEqual(["upload.jpg", "paste.webp", "drop.jpg"]);
    expect(images.every(({ sizeBytes }) => sizeBytes < SEND_IMAGE_PAYLOAD_LIMIT_BYTES)).toBe(true);
  });

  it("fails the whole send with a user-facing error instead of returning an oversized image", async () => {
    stubCanvasPipeline(() => 4_000_000);

    await expect(
      prepareImageAttachmentsForSend([
        { name: "cannot-fit.png", file: makeFile(8_000_000, "image/png", "cannot-fit.png") },
      ]),
    ).rejects.toEqual(
      new SendImagePreparationError(
        "Image 'cannot-fit.png' could not be compressed below 2 MiB. It was not sent.",
      ),
    );
  });
});
