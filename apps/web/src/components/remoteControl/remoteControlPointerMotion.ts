import type { RemoteControlInput } from "@t3tools/contracts";

type RemoteControlPointerInput = Extract<RemoteControlInput, { readonly type: "pointer" }>;

/**
 * Smoothing for locked-pointer (mouse-look) motion.
 *
 * Raw `movementX/Y` from a browser in pointer lock is already
 * OS-acceleration-shaped on the controller side, and the host's own pointer
 * acceleration shapes it a second time on arrival. Two curves stacked turn a
 * normal flick into a spin, which is what makes some games unusable over
 * remote control.
 *
 * Rather than try to invert either curve — neither side exposes its parameters
 * — this eases the *output* toward the accumulated input. A burst is spread
 * across several sends instead of landing as one jump, while the total travel
 * is preserved exactly: every pixel the user moved is eventually emitted, so
 * aim stays where they put it and nothing drifts.
 *
 * Only relevant while locked. Unlocked motion is an absolute cursor position,
 * where easing would just add lag.
 */

/** Fraction of the outstanding residual emitted per send. */
export const DEFAULT_POINTER_SMOOTHING = 0.35;
/**
 * Largest delta a single send may carry, in remote pixels. This is the actual
 * fling brake: without it one enormous sample still arrives as one enormous
 * motion, merely smoothed. Sized well above a fast normal flick so ordinary
 * aiming is untouched.
 */
export const DEFAULT_POINTER_MAX_STEP = 120;
/**
 * Below this the remainder is emitted whole. Exponential easing never reaches
 * zero, and a trailing sub-pixel tail would both spam the wire and, once
 * rounded, never actually move the cursor.
 */
export const DEFAULT_POINTER_SNAP_THRESHOLD = 1;
/**
 * Mirrors the contract's per-event delta bound. Anything larger is chunked
 * rather than clamped, so fast motion is delayed by a frame but never lost.
 */
export const REMOTE_CONTROL_POINTER_DELTA_LIMIT = 4_000;

export interface PointerMotionOptions {
  readonly smoothing?: number;
  readonly maxStep?: number;
  readonly snapThreshold?: number;
}

export interface PointerMotionStep {
  readonly dx: number;
  readonly dy: number;
}

export interface PointerMotionSmoother {
  /** Accumulate one raw locked-pointer sample. */
  readonly push: (dx: number, dy: number) => void;
  /**
   * Emit the next eased step, or null when there is nothing left worth
   * sending. Values are whole pixels: the host injects integers, so rounding
   * here keeps the residual honest instead of losing fractions downstream.
   */
  readonly next: () => PointerMotionStep | null;
  /** True while motion is still owed. */
  readonly hasPending: () => boolean;
  /** Drop outstanding motion — used when lock ends, so it cannot leak later. */
  readonly reset: () => void;
}

function clampUnitInterval(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) return fallback;
  return value;
}

function clampPositive(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

export function createPointerMotionSmoother(
  options: PointerMotionOptions = {},
): PointerMotionSmoother {
  const smoothing = clampUnitInterval(
    options.smoothing ?? DEFAULT_POINTER_SMOOTHING,
    DEFAULT_POINTER_SMOOTHING,
  );
  const maxStep = clampPositive(
    options.maxStep ?? DEFAULT_POINTER_MAX_STEP,
    DEFAULT_POINTER_MAX_STEP,
  );
  const snapThreshold = clampPositive(
    options.snapThreshold ?? DEFAULT_POINTER_SNAP_THRESHOLD,
    DEFAULT_POINTER_SNAP_THRESHOLD,
  );

  let pendingX = 0;
  let pendingY = 0;

  const push = (dx: number, dy: number): void => {
    if (Number.isFinite(dx)) pendingX += dx;
    if (Number.isFinite(dy)) pendingY += dy;
  };

  const hasPending = (): boolean => Math.abs(pendingX) >= 0.5 || Math.abs(pendingY) >= 0.5;

  const next = (): PointerMotionStep | null => {
    if (!hasPending()) {
      // Discard the sub-pixel remainder rather than carrying it forever.
      pendingX = 0;
      pendingY = 0;
      return null;
    }

    const magnitude = Math.hypot(pendingX, pendingY);
    // Ease toward the target, then clamp. Scaling both axes by one factor keeps
    // the direction intact — clamping each axis independently would bend a
    // diagonal flick toward 45°.
    let scale = magnitude <= snapThreshold ? 1 : smoothing;
    const easedMagnitude = magnitude * scale;
    if (easedMagnitude > maxStep) {
      scale = maxStep / magnitude;
    }

    const stepX = Math.round(pendingX * scale);
    const stepY = Math.round(pendingY * scale);

    if (stepX === 0 && stepY === 0) {
      // Rounding swallowed the whole eased step; emit the remainder so a slow
      // drag cannot stall short of its target.
      const wholeX = Math.round(pendingX);
      const wholeY = Math.round(pendingY);
      pendingX = 0;
      pendingY = 0;
      return wholeX === 0 && wholeY === 0 ? null : { dx: wholeX, dy: wholeY };
    }

    pendingX -= stepX;
    pendingY -= stepY;
    return { dx: stepX, dy: stepY };
  };

  const reset = (): void => {
    pendingX = 0;
    pendingY = 0;
  };

  return { push, next, hasPending, reset };
}

/**
 * Merge a pointer move into the one already queued ahead of it, or report that
 * it cannot be merged.
 *
 * Absolute and relative moves coalesce in opposite ways, and conflating them
 * loses real motion. An absolute move names a destination, so the newer one
 * simply wins. A relative move is an *increment*, so the only correct merge is
 * to add them — replacing one with the next silently throws away every pixel
 * the queued move was carrying, which is exactly how mouse-look ended up
 * under-rotating whenever the send queue was busy.
 */
export function mergePointerMoves(
  queued: RemoteControlPointerInput,
  incoming: RemoteControlPointerInput,
): RemoteControlPointerInput | null {
  const queuedIsRelative = queued.dx !== undefined || queued.dy !== undefined;
  const incomingIsRelative = incoming.dx !== undefined || incoming.dy !== undefined;
  // A mode change must stay two events: the absolute one re-anchors the cursor
  // and the relative one moves from there.
  if (queuedIsRelative !== incomingIsRelative) return null;
  if (!incomingIsRelative) return incoming;

  const dx = (queued.dx ?? 0) + (incoming.dx ?? 0);
  const dy = (queued.dy ?? 0) + (incoming.dy ?? 0);
  // Summing can exceed the contract's per-event bound; that has to be split
  // rather than merged, so leave both events in place.
  if (
    Math.abs(dx) > REMOTE_CONTROL_POINTER_DELTA_LIMIT ||
    Math.abs(dy) > REMOTE_CONTROL_POINTER_DELTA_LIMIT
  ) {
    return null;
  }
  return { ...incoming, dx, dy };
}

/**
 * Split one oversized delta into wire-safe chunks.
 *
 * The contract bounds a single delta so a glitching controller cannot hurl the
 * cursor across the desktop. A legitimate very fast flick can still exceed it,
 * and dropping or clamping that would lose real motion, so it is chunked.
 */
export function splitPointerDelta(
  step: PointerMotionStep,
  limit: number,
): ReadonlyArray<PointerMotionStep> {
  const bound = clampPositive(limit, 4_000);
  if (Math.abs(step.dx) <= bound && Math.abs(step.dy) <= bound) return [step];
  const chunks = Math.ceil(Math.max(Math.abs(step.dx), Math.abs(step.dy)) / bound);
  const out: Array<PointerMotionStep> = [];
  let remainingX = step.dx;
  let remainingY = step.dy;
  for (let index = 0; index < chunks; index += 1) {
    const left = chunks - index;
    const dx = Math.round(remainingX / left);
    const dy = Math.round(remainingY / left);
    remainingX -= dx;
    remainingY -= dy;
    if (dx !== 0 || dy !== 0) out.push({ dx, dy });
  }
  return out;
}
