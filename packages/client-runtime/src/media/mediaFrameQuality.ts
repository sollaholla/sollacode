/**
 * Per-frame quality for a constant-quality (quantizer) screen encoder.
 *
 * A screen is mostly still, and still text is what people read, so the
 * encoder runs at a fixed quantizer rather than a bitrate: a static frame is
 * as sharp as its quantizer says, however little the stream has spent
 * lately. The byte budget from `mediaBitrateController` is enforced here
 * instead, with a leaky bucket: every encoded frame pours its size in, the
 * budget drains it, and the backlog in seconds decides the next frame's
 * quantizer. A burst - a scroll, a video - coarsens frames while it lasts
 * and, past a full second of backlog, skips them; when the screen settles,
 * one refinement pass re-encodes the last frame finely so the text sharpens
 * in place. Without a quantizer mode (a software encoder), the encoder's own
 * rate control takes the budget and only the pacing and refinement apply.
 */

export interface FrameBucket {
  /** Bytes poured in and not yet drained. */
  readonly bytes: number;
  readonly at: number;
}

export const EMPTY_BUCKET: FrameBucket = { bytes: 0, at: 0 };

export function drainBucket(bucket: FrameBucket, bitsPerSecond: number, now: number): FrameBucket {
  const drained = Math.max(0, now - bucket.at) * (bitsPerSecond / 8 / 1_000);
  return { bytes: Math.max(0, bucket.bytes - drained), at: now };
}

export function pourBucket(
  bucket: FrameBucket,
  bytes: number,
  bitsPerSecond: number,
  now: number,
): FrameBucket {
  const drained = drainBucket(bucket, bitsPerSecond, now);
  return { bytes: drained.bytes + bytes, at: now };
}

/** Seconds of encoded backlog the budget still has to drain. */
export function bucketSeconds(bucket: FrameBucket, bitsPerSecond: number, now: number): number {
  return (drainBucket(bucket, bitsPerSecond, now).bytes * 8) / Math.max(1, bitsPerSecond);
}

export interface QuantizerScale {
  /** Quantizer for new content on an empty bucket. */
  readonly best: number;
  /** Never coarser than this. */
  readonly worst: number;
  /** The refinement pass on a settled screen. */
  readonly refine: number;
}

/**
 * HEVC reaches the same picture quality as H.264 a few quantizer steps
 * higher (measured on this benchmark's text: about +2.5 dB at equal QP).
 */
export function quantizerScale(codec: string): QuantizerScale {
  if (codec.startsWith("hvc1") || codec.startsWith("hev1")) {
    return { best: 28, worst: 46, refine: 23 };
  }
  return { best: 26, worst: 44, refine: 21 };
}

/** The backlog past which new frames wait instead of being encoded. */
export const BUCKET_SKIP_SECONDS = 0.6;

/** Quantizer for the next frame: coarser as the backlog grows. */
export function quantizerFor(scale: QuantizerScale, backlogSeconds: number): number {
  const steps = Math.round(Math.max(0, backlogSeconds - 0.05) * 30);
  return Math.min(scale.worst, scale.best + steps);
}

/** Whether a frame encoded at `quantizer` is worth a refinement pass. */
export function needsRefinement(scale: QuantizerScale, quantizer: number | null): boolean {
  return quantizer !== null && quantizer > scale.refine + 2;
}
