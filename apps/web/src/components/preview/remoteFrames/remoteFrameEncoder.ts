import {
  changedShare,
  changedTiles,
  rectsArea,
  tileRects,
  type TileRect,
} from "@t3tools/client-runtime/preview/remote-frame-tiles";

/**
 * Turns the desktop's screencast pictures of a watched tab into what remote
 * viewers download: the whole picture when much of it changed, otherwise
 * only the changed rectangles, re-encoded on their own. Runs wherever
 * OffscreenCanvas does (the desktop runs it in a worker), one encoder per tab.
 */

export interface RemoteFrameEncodeInput {
  /** Base64 JPEG from the screencast. */
  readonly data: string;
  /** Send the whole picture even if little changed (a viewer needs a fresh base). */
  readonly forceKeyframe: boolean;
  /** Every change goes out whole: some viewer cannot draw patches. */
  readonly keyframesOnly: boolean;
}

export interface EncodedRemotePatch extends TileRect {
  readonly data: string;
}

export type RemoteFrameEncoded =
  | {
      readonly type: "keyframe";
      readonly width: number;
      readonly height: number;
      readonly data: string;
    }
  | {
      readonly type: "patch";
      readonly width: number;
      readonly height: number;
      readonly patches: ReadonlyArray<EncodedRemotePatch>;
    }
  /** Identical to the last picture; nothing to send. */
  | null;

export interface RemoteFrameEncoderOptions {
  /** Changed rectangles are re-encoded at this JPEG quality (0..1); a little above the source's, since they are a second generation. */
  readonly patchQuality: number;
  /** Past this share of the picture changed, the whole picture goes out instead. */
  readonly keyframeShare: number;
  /** Rectangles per patch, before falling back to one box around every change. */
  readonly maxPatches: number;
}

export const DEFAULT_REMOTE_FRAME_ENCODER_OPTIONS: RemoteFrameEncoderOptions = {
  patchQuality: 0.85,
  keyframeShare: 0.4,
  maxPatches: 24,
};

type Base64Codec = {
  readonly fromBase64?: (value: string) => Uint8Array;
};
type Base64Bytes = Uint8Array & { readonly toBase64?: () => string };

export function base64ToBytes(value: string): Uint8Array {
  const native = (Uint8Array as unknown as Base64Codec).fromBase64;
  if (native) return native(value);
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const native = (bytes as Base64Bytes).toBase64;
  if (native) return native.call(bytes);
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export function canEncodeRemoteFrames(): boolean {
  return typeof OffscreenCanvas === "function" && typeof createImageBitmap === "function";
}

export function createRemoteFrameEncoder(
  options: RemoteFrameEncoderOptions = DEFAULT_REMOTE_FRAME_ENCODER_OPTIONS,
) {
  let previous: {
    readonly width: number;
    readonly height: number;
    readonly pixels: Uint32Array;
  } | null = null;
  let canvas: OffscreenCanvas | null = null;
  let context: OffscreenCanvasRenderingContext2D | null = null;
  let tileCanvas: OffscreenCanvas | null = null;
  let tileContext: OffscreenCanvasRenderingContext2D | null = null;

  const drawingSurface = (width: number, height: number) => {
    if (canvas === null || context === null || canvas.width !== width || canvas.height !== height) {
      canvas = new OffscreenCanvas(width, height);
      context = canvas.getContext("2d", { willReadFrequently: true, alpha: false });
      if (context === null) throw new Error("This window cannot read pixels from a canvas.");
    }
    return context;
  };

  const encodeRect = async (bitmap: ImageBitmap, rect: TileRect): Promise<EncodedRemotePatch> => {
    if (tileCanvas === null || tileContext === null) {
      tileCanvas = new OffscreenCanvas(rect.width, rect.height);
      tileContext = tileCanvas.getContext("2d", { alpha: false });
      if (tileContext === null) throw new Error("This window cannot draw to a canvas.");
    }
    tileCanvas.width = rect.width;
    tileCanvas.height = rect.height;
    tileContext.drawImage(
      bitmap,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      0,
      0,
      rect.width,
      rect.height,
    );
    const blob = await tileCanvas.convertToBlob({
      type: "image/jpeg",
      quality: options.patchQuality,
    });
    return { ...rect, data: bytesToBase64(new Uint8Array(await blob.arrayBuffer())) };
  };

  return {
    /** Forgets the last picture, so the next one goes out whole. */
    reset: () => {
      previous = null;
    },
    encode: async (input: RemoteFrameEncodeInput): Promise<RemoteFrameEncoded> => {
      const bitmap = await createImageBitmap(
        new Blob([base64ToBytes(input.data) as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }),
      );
      try {
        const { width, height } = bitmap;
        const surface = drawingSurface(width, height);
        surface.drawImage(bitmap, 0, 0);
        const pixels = new Uint32Array(surface.getImageData(0, 0, width, height).data.buffer);
        const before = previous;
        previous = { width, height, pixels };
        const keyframe: RemoteFrameEncoded = { type: "keyframe", width, height, data: input.data };
        if (
          input.forceKeyframe ||
          before === null ||
          before.width !== width ||
          before.height !== height
        ) {
          return keyframe;
        }
        const grid = changedTiles(before.pixels, pixels, width, height);
        const share = changedShare(grid);
        if (share === 0) return null;
        if (input.keyframesOnly || share > options.keyframeShare) return keyframe;
        const rects = tileRects(grid, width, height, options.maxPatches);
        if (rectsArea(rects) > width * height * options.keyframeShare) return keyframe;
        const patches: Array<EncodedRemotePatch> = [];
        for (const rect of rects) patches.push(await encodeRect(bitmap, rect));
        const patchBytes = patches.reduce((total, patch) => total + patch.data.length, 0);
        // Rectangles that together cost about as much as the whole picture are
        // not worth drawing piecemeal.
        if (patchBytes > input.data.length * 0.8) return keyframe;
        return { type: "patch", width, height, patches };
      } finally {
        bitmap.close();
      }
    },
  };
}

export type RemoteFrameEncoder = ReturnType<typeof createRemoteFrameEncoder>;
