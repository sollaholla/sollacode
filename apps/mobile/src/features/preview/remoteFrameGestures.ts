import type { PreviewRemoteInputAction } from "@t3tools/contracts";

/** Finger jitter tolerance before a stationary touch becomes a movement. */
export const FRAME_TAP_SLOP_PX = 10;

/** Holding this long before moving turns the movement into a drag, not a scroll. */
export const FRAME_DRAG_HOLD_MS = 350;

export interface FrameSize {
  readonly width: number;
  readonly height: number;
}

export interface FramePoint {
  readonly x: number;
  readonly y: number;
}

/**
 * One completed touch on the rendered frame, in layout pixels.
 *
 * `firstMovedAt` is when the finger first left the tap slop, not when it was
 * released: a press held still and then flicked must classify by how long it
 * was held before moving, or slow deliberate scrolls would all become drags.
 */
export interface FrameGestureSample {
  readonly startedAt: number;
  readonly start: FramePoint;
  readonly end: FramePoint;
  readonly maxDistancePx: number;
  readonly firstMovedAt: number | null;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Maps a layout-pixel point to frame fractions, clamped to the frame. */
export function frameFraction(size: FrameSize, point: FramePoint): FramePoint | null {
  if (!(size.width > 0) || !(size.height > 0)) return null;
  return { x: clamp01(point.x / size.width), y: clamp01(point.y / size.height) };
}

/**
 * Classifies a completed touch into the remote input it should dispatch.
 *
 * - Stationary touch → click at the start point (long-press stays a click).
 * - Movement after holding ≥ FRAME_DRAG_HOLD_MS → drag from start to end.
 * - Any other movement → scroll, in natural touch direction: dragging the
 *   finger down reveals content above, which is a negative deltaY.
 */
export function resolveFrameGesture(
  size: FrameSize,
  sample: FrameGestureSample,
): PreviewRemoteInputAction | null {
  const start = frameFraction(size, sample.start);
  const end = frameFraction(size, sample.end);
  if (start === null || end === null) return null;

  if (sample.maxDistancePx <= FRAME_TAP_SLOP_PX) {
    return { kind: "click", position: start };
  }

  const heldMs = sample.firstMovedAt === null ? 0 : sample.firstMovedAt - sample.startedAt;
  if (heldMs >= FRAME_DRAG_HOLD_MS) {
    return { kind: "drag", from: start, to: end };
  }

  return {
    kind: "scroll",
    deltaX: (sample.start.x - sample.end.x) / size.width,
    deltaY: (sample.start.y - sample.end.y) / size.height,
  };
}
