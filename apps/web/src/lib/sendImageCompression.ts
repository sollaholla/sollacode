/**
 * Final image preparation for user-sent chat attachments.
 *
 * Every web/desktop image path converges here immediately before the
 * `thread.turn.start` command is built. The original File is never changed.
 */

export const SEND_IMAGE_PAYLOAD_LIMIT_BYTES = 2 * 1024 * 1024;
export const SEND_IMAGE_MAX_BYTES = SEND_IMAGE_PAYLOAD_LIMIT_BYTES - 1;

const MAX_INITIAL_DIMENSION = 4096;
const MIN_DIMENSION = 32;
const DIMENSION_SCALE = 0.75;
const QUALITY_STEPS = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4] as const;
const BASE64_CHUNK_SIZE = 0x8000;

const ALPHA_CAPABLE_SOURCE_TYPES = new Set(["image/avif", "image/gif", "image/png", "image/webp"]);

export interface PreparedSendImage {
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly dataUrl: string;
  readonly recompressed: boolean;
}

export type PrepareSendImageResult =
  | { readonly ok: true; readonly image: PreparedSendImage }
  | { readonly ok: false; readonly reason: "too-large" | "unreadable" };

export class SendImagePreparationError extends Error {
  override readonly name = "SendImagePreparationError";
}

interface Canvas2D {
  readonly canvas: OffscreenCanvas | HTMLCanvasElement;
  readonly context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_SIZE));
  }
  return btoa(binary);
}

async function blobToDataUrl(blob: Blob, mimeTypeOverride?: string): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const mimeType = mimeTypeOverride || blob.type || "application/octet-stream";
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
}

function canRecompress(): boolean {
  return (
    typeof createImageBitmap === "function" &&
    (typeof OffscreenCanvas === "function" || typeof document !== "undefined")
  );
}

function createCanvas(width: number, height: number): Canvas2D | null {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    return context ? { canvas, context } : null;
  }
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  return context ? { canvas, context } : null;
}

async function encodeCanvas(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  mimeType: string,
  quality: number,
): Promise<Blob | null> {
  if (typeof HTMLCanvasElement !== "undefined" && canvas instanceof HTMLCanvasElement) {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, mimeType, quality),
    );
    return blob?.type === mimeType ? blob : null;
  }
  const blob = await (canvas as OffscreenCanvas).convertToBlob({ type: mimeType, quality });
  return blob.type === mimeType ? blob : null;
}

function outputName(name: string, mimeType: string): string {
  const extension = mimeType === "image/webp" ? "webp" : mimeType === "image/png" ? "png" : "jpg";
  const base = name.replace(/\.[^.]+$/, "") || "image";
  return `${base}.${extension}`;
}

function nextDimension(current: number): number {
  if (current <= MIN_DIMENSION) return 0;
  return Math.max(MIN_DIMENSION, Math.floor(current * DIMENSION_SCALE));
}

/**
 * Returns the original bytes unchanged when already below the exclusive 2 MiB
 * ceiling. Larger inputs are decoded with EXIF orientation applied, then
 * iteratively re-encoded and downscaled until the exact Blob byte length fits.
 *
 * Alpha-capable source formats prefer WebP and fall back to PNG so transparent
 * pixels are never silently flattened. JPEG sources stay JPEG.
 */
export async function prepareImageForSend(
  file: File,
  maxBytes: number = SEND_IMAGE_MAX_BYTES,
): Promise<PrepareSendImageResult> {
  if (file.size > 0 && file.size <= maxBytes) {
    try {
      return {
        ok: true,
        image: {
          name: file.name || "image",
          mimeType: file.type,
          sizeBytes: file.size,
          dataUrl: await blobToDataUrl(file),
          recompressed: false,
        },
      };
    } catch {
      return { ok: false, reason: "unreadable" };
    }
  }
  if (file.size <= 0) return { ok: false, reason: "unreadable" };
  if (!canRecompress()) return { ok: false, reason: "too-large" };

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  try {
    const alphaCapable = ALPHA_CAPABLE_SOURCE_TYPES.has(file.type.toLowerCase());
    const preferredTypes = alphaCapable
      ? (["image/webp", "image/png"] as const)
      : (["image/jpeg"] as const);
    let dimension = Math.min(MAX_INITIAL_DIMENSION, Math.max(1, bitmap.width, bitmap.height));

    while (dimension > 0) {
      const scale = Math.min(1, dimension / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const target = createCanvas(width, height);
      if (!target) return { ok: false, reason: "unreadable" };

      if (!alphaCapable) {
        target.context.fillStyle = "#ffffff";
        target.context.fillRect(0, 0, width, height);
      }
      target.context.drawImage(bitmap, 0, 0, width, height);

      for (const mimeType of preferredTypes) {
        for (const quality of QUALITY_STEPS) {
          let encoded: Blob | null;
          try {
            encoded = await encodeCanvas(target.canvas, mimeType, quality);
          } catch {
            encoded = null;
          }
          if (!encoded) break;
          if (encoded.size > 0 && encoded.size <= maxBytes) {
            return {
              ok: true,
              image: {
                name: outputName(file.name || "image", mimeType),
                mimeType,
                sizeBytes: encoded.size,
                dataUrl: await blobToDataUrl(encoded, mimeType),
                recompressed: true,
              },
            };
          }
          // PNG ignores quality; retrying the same dimensions is pointless.
          if (mimeType === "image/png") break;
        }
      }
      dimension = nextDimension(dimension);
    }
    return { ok: false, reason: "too-large" };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    bitmap.close();
  }
}

export async function prepareImageAttachmentsForSend(
  images: ReadonlyArray<{ readonly name: string; readonly file: File }>,
): Promise<PreparedSendImage[]> {
  const prepared: PreparedSendImage[] = [];
  for (const image of images) {
    const result = await prepareImageForSend(image.file);
    if (!result.ok) {
      const detail =
        result.reason === "too-large"
          ? "could not be compressed below 2 MiB"
          : "could not be read or decoded";
      throw new SendImagePreparationError(`Image '${image.name}' ${detail}. It was not sent.`);
    }
    prepared.push(result.image);
  }
  return prepared;
}
