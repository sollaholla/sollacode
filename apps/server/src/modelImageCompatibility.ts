// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off - The worker timeout must terminate a stuck codec outside the Effect runtime.
import * as NodeModule from "node:module";
import * as NodeTimers from "node:timers";
import * as NodeWorkerThreads from "node:worker_threads";

const MODEL_COMPATIBLE_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const HEIC_IMAGE_MIME_TYPES = new Set([
  "image/heic",
  "image/heic-sequence",
  "image/heif",
  "image/heif-sequence",
]);

const HEIC_JPEG_QUALITY_ATTEMPTS = [0.82, 0.62, 0.45] as const;
const HEIC_CONVERSION_TIMEOUT_MS = 30_000;
const require = NodeModule.createRequire(import.meta.url);
const heicConvertModulePath = require.resolve("heic-convert");
const HEIC_CONVERT_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const convertHeic = require(workerData.modulePath);

void (async () => {
  let lastOutputBytes = 0;
  for (const quality of workerData.qualities) {
    const converted = await convertHeic({
      buffer: workerData.bytes,
      format: "JPEG",
      quality,
    });
    const bytes = Buffer.from(converted);
    lastOutputBytes = bytes.byteLength;
    if (bytes.byteLength > 0 && bytes.byteLength <= workerData.maxOutputBytes) {
      parentPort.postMessage({ type: "converted", bytes });
      return;
    }
  }
  parentPort.postMessage({ type: "oversized", lastOutputBytes });
})().catch((cause) => {
  parentPort.postMessage({
    type: "failed",
    message: cause instanceof Error ? cause.message : String(cause),
  });
});
`;

export interface ModelCompatibleImage {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly name: string;
  readonly converted: boolean;
}

export class UnsupportedModelImageTypeError extends Error {
  public readonly mimeType: string;

  constructor(mimeType: string) {
    super(`Unsupported image attachment type '${mimeType}'.`);
    this.name = "UnsupportedModelImageTypeError";
    this.mimeType = mimeType;
  }
}

export class ModelImageConversionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelImageConversionError";
  }
}

export function isModelCompatibleImageMimeType(mimeType: string): boolean {
  return MODEL_COMPATIBLE_IMAGE_MIME_TYPES.has(mimeType.trim().toLowerCase());
}

export function isHeicImageMimeType(mimeType: string): boolean {
  return HEIC_IMAGE_MIME_TYPES.has(mimeType.trim().toLowerCase());
}

export function convertedJpegName(name: string): string {
  const trimmed = name.trim();
  if (/\.(?:heic|heif)$/i.test(trimmed)) {
    return trimmed.replace(/\.(?:heic|heif)$/i, ".jpg");
  }
  return `${trimmed || "image"}.jpg`;
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

type HeicWorkerResult =
  | { readonly type: "converted"; readonly bytes: Uint8Array }
  | { readonly type: "oversized"; readonly lastOutputBytes: number }
  | { readonly type: "failed"; readonly message: string };

function convertHeicInWorker(input: {
  readonly bytes: Uint8Array;
  readonly maxOutputBytes: number;
}): Promise<HeicWorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new NodeWorkerThreads.Worker(HEIC_CONVERT_WORKER_SOURCE, {
      eval: true,
      workerData: {
        modulePath: heicConvertModulePath,
        bytes: input.bytes,
        qualities: HEIC_JPEG_QUALITY_ATTEMPTS,
        maxOutputBytes: input.maxOutputBytes,
      },
    });
    let settled = false;
    const timeout = NodeTimers.setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      reject(new Error(`HEIC conversion exceeded ${HEIC_CONVERSION_TIMEOUT_MS}ms.`));
    }, HEIC_CONVERSION_TIMEOUT_MS);

    const finish = (result: HeicWorkerResult) => {
      if (settled) return;
      settled = true;
      NodeTimers.clearTimeout(timeout);
      void worker.terminate();
      resolve(result);
    };

    worker.once("message", (message: HeicWorkerResult) => finish(message));
    worker.once("error", (cause) => {
      if (settled) return;
      settled = true;
      NodeTimers.clearTimeout(timeout);
      void worker.terminate();
      reject(cause);
    });
    worker.once("exit", (code) => {
      if (settled || code === 0) return;
      settled = true;
      NodeTimers.clearTimeout(timeout);
      reject(new Error(`HEIC conversion worker exited with code ${code}.`));
    });
  });
}

export async function prepareModelCompatibleImage(input: {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly name: string;
  readonly maxOutputBytes: number;
}): Promise<ModelCompatibleImage> {
  const mimeType = input.mimeType.trim().toLowerCase();
  if (isModelCompatibleImageMimeType(mimeType)) {
    return {
      bytes: input.bytes,
      mimeType,
      name: input.name,
      converted: false,
    };
  }

  if (!isHeicImageMimeType(mimeType)) {
    throw new UnsupportedModelImageTypeError(mimeType);
  }

  try {
    const result = await convertHeicInWorker(input);
    if (result.type === "failed") {
      throw new Error(result.message);
    }
    if (result.type === "oversized") {
      throw new ModelImageConversionError(
        `Converted HEIC attachment '${input.name}' exceeds ${input.maxOutputBytes} bytes (last output: ${result.lastOutputBytes} bytes).`,
      );
    }
    const bytes = new Uint8Array(result.bytes);
    if (!isJpeg(bytes)) {
      throw new ModelImageConversionError(
        `Converted HEIC attachment '${input.name}' did not produce a valid JPEG.`,
      );
    }
    return {
      bytes,
      mimeType: "image/jpeg",
      name: convertedJpegName(input.name),
      converted: true,
    };
  } catch (cause) {
    if (cause instanceof ModelImageConversionError) {
      throw cause;
    }
    throw new ModelImageConversionError(`Failed to convert HEIC attachment '${input.name}'.`, {
      cause,
    });
  }
}
