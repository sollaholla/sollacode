import {
  base64ToBytes,
  bytesToBase64,
} from "../../apps/web/src/components/preview/remoteFrames/remoteFrameEncoder.ts";

export interface CompressionDiagnostic {
  readonly width: number;
  readonly height: number;
  readonly sourcePng: string;
  readonly variants: ReadonlyArray<{
    readonly name: string;
    readonly mimeType: string;
    readonly quality: number;
    readonly bytes: number;
    readonly encodeMilliseconds: number;
    readonly lumaPsnr: number | null;
    readonly exactPixels: boolean;
    readonly data: string;
    readonly decodedPng: string;
  }>;
}

const base64 = async (blob: Blob) => bytesToBase64(new Uint8Array(await blob.arrayBuffer()));

/** One frozen JPEG, recompressed after the timed run; this is not a codec throughput benchmark. */
export async function compareCompression(data: string): Promise<CompressionDiagnostic> {
  const source = await createImageBitmap(
    new Blob([base64ToBytes(data) as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }),
  );
  try {
    const { width, height } = source;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    if (!context) throw new Error("Compression diagnostic needs a 2D canvas.");
    context.drawImage(source, 0, 0);
    const original = context.getImageData(0, 0, width, height).data;
    const sourcePng = await base64(await canvas.convertToBlob({ type: "image/png" }));
    const decodedCanvas = new OffscreenCanvas(width, height);
    const decodedContext = decodedCanvas.getContext("2d", {
      alpha: false,
      willReadFrequently: true,
    });
    if (!decodedContext) throw new Error("Compression diagnostic needs a readback canvas.");
    const variants: Array<CompressionDiagnostic["variants"][number]> = [];
    for (const candidate of [
      { name: "jpeg-50", type: "image/jpeg", quality: 0.5 },
      { name: "jpeg-75", type: "image/jpeg", quality: 0.75 },
      { name: "webp-80", type: "image/webp", quality: 0.8 },
      { name: "webp-90", type: "image/webp", quality: 0.9 },
    ]) {
      const started = performance.now();
      const blob = await canvas.convertToBlob(candidate);
      const encodeMilliseconds = performance.now() - started;
      if (blob.type !== candidate.type)
        throw new Error(`Unsupported diagnostic codec ${candidate.type}`);
      const decoded = await createImageBitmap(blob);
      try {
        decodedContext.drawImage(decoded, 0, 0);
        const pixels = decodedContext.getImageData(0, 0, width, height).data;
        let squaredError = 0;
        let exactPixels = true;
        for (let index = 0; index < original.length; index += 4) {
          const red = original[index]! - pixels[index]!;
          const green = original[index + 1]! - pixels[index + 1]!;
          const blue = original[index + 2]! - pixels[index + 2]!;
          exactPixels &&= red === 0 && green === 0 && blue === 0;
          const error = red * 0.2126 + green * 0.7152 + blue * 0.0722;
          squaredError += error * error;
        }
        const mse = squaredError / (width * height);
        variants.push({
          name: candidate.name,
          mimeType: blob.type,
          quality: candidate.quality,
          bytes: blob.size,
          encodeMilliseconds,
          lumaPsnr: mse === 0 ? null : 10 * Math.log10((255 * 255) / mse),
          exactPixels,
          data: await base64(blob),
          decodedPng: await base64(await decodedCanvas.convertToBlob({ type: "image/png" })),
        });
      } finally {
        decoded.close();
      }
    }
    return { width, height, sourcePng, variants };
  } finally {
    source.close();
  }
}
