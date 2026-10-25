/**
 * Which codec a media-channel stream uses.
 *
 * HEVC first, then H.264: hardware encoders on macOS (and most Windows GPUs)
 * produce both with a few milliseconds of latency, and on screen text HEVC
 * reaches the same quality in markedly fewer bytes. A viewer that cannot
 * decode HEVC - many Windows and Linux Chromium builds - gets H.264, which
 * every WebCodecs browser decodes, iPhone Safari included (it has no
 * MediaSource, so it never had video on the legacy path at all). Level 5.1
 * in both covers anything up to 4096x2304. VP8 is the software fallback for
 * a host without either.
 */
export const MEDIA_VIDEO_CODECS = [
  "hvc1.1.6.L153.B0",
  "avc1.640033",
  "avc1.4d0033",
  "avc1.42e033",
  "vp8",
] as const;

export function isAvc(codec: string): boolean {
  return codec.startsWith("avc1.") || codec.startsWith("avc3.");
}

export function isHevc(codec: string): boolean {
  return codec.startsWith("hvc1.") || codec.startsWith("hev1.");
}

/** Codecs this browser can decode, in preference order. Empty without WebCodecs. */
export async function detectDecodableCodecs(
  candidates: ReadonlyArray<string> = MEDIA_VIDEO_CODECS,
): Promise<string[]> {
  if (typeof VideoDecoder === "undefined" || typeof EncodedVideoChunk === "undefined") return [];
  const supported: string[] = [];
  for (const codec of candidates) {
    try {
      const result = await VideoDecoder.isConfigSupported({
        codec,
        codedWidth: 1_920,
        codedHeight: 1_080,
      });
      if (result.supported) supported.push(codec);
    } catch {
      // An engine that throws on a codec string simply does not support it.
    }
  }
  return supported;
}

/** Codecs every subscriber can decode, in our preference order. */
export function commonCodec(
  subscribers: ReadonlyArray<ReadonlyArray<string>>,
  candidates: ReadonlyArray<string> = MEDIA_VIDEO_CODECS,
): string[] {
  return candidates.filter((codec) => subscribers.every((codecs) => codecs.includes(codec)));
}

export interface EncoderChoice {
  readonly config: VideoEncoderConfig;
  readonly hardware: boolean;
  /** Per-frame quantizers: constant quality instead of a target bitrate. */
  readonly quantizer: boolean;
}

/**
 * Resolves an encoder configuration for the first usable codec. Per codec,
 * a hardware encoder in quantizer mode first (constant quality, no frames
 * dropped by rate control), then hardware at a variable bitrate, then
 * whatever the platform has.
 */
export async function resolveEncoderConfig(input: {
  readonly codecs: ReadonlyArray<string>;
  readonly width: number;
  readonly height: number;
  readonly bitrate: number;
  readonly framerate: number;
}): Promise<EncoderChoice | null> {
  if (typeof VideoEncoder === "undefined") return null;
  const attempts = [
    { hardwareAcceleration: "prefer-hardware", bitrateMode: "quantizer" },
    { hardwareAcceleration: "prefer-hardware", bitrateMode: "variable" },
    { hardwareAcceleration: "no-preference", bitrateMode: "variable" },
  ] as const;
  for (const codec of input.codecs) {
    for (const attempt of attempts) {
      const config: VideoEncoderConfig = {
        codec,
        width: input.width,
        height: input.height,
        framerate: input.framerate,
        latencyMode: "realtime",
        hardwareAcceleration: attempt.hardwareAcceleration,
        bitrateMode: attempt.bitrateMode,
        ...(attempt.bitrateMode === "variable" ? { bitrate: input.bitrate } : {}),
        ...(isAvc(codec) ? { avc: { format: "avc" as const } } : {}),
        ...(isHevc(codec) ? { hevc: { format: "hevc" } } : {}),
      } as VideoEncoderConfig;
      try {
        const result = await VideoEncoder.isConfigSupported(config);
        if (result.supported) {
          return {
            config,
            hardware: attempt.hardwareAcceleration === "prefer-hardware",
            quantizer: attempt.bitrateMode === "quantizer",
          };
        }
      } catch {
        // Try the next combination.
      }
    }
  }
  return null;
}
