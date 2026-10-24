/** A sideways drag this long moves to the neighbouring image. */
export const IMAGE_SWIPE_DISTANCE_PX = 64;
/** A quicker flick needs only this far. */
export const IMAGE_SWIPE_FLICK_PX = 24;
export const IMAGE_SWIPE_FLICK_MS = 250;
/** Once a drag goes this far, it is committed to sideways or up and down. */
export const IMAGE_SWIPE_AXIS_LOCK_PX = 8;

/**
 * Where a finger dragged across an unzoomed image goes when it lifts: 1 for
 * the next image (dragged left), -1 for the previous one, or null to settle
 * back. The drag has to be mostly sideways, and either long or quick.
 */
export function imageSwipeDirection(input: {
  readonly dx: number;
  readonly dy: number;
  readonly elapsedMs: number;
}): -1 | 1 | null {
  const distance = Math.abs(input.dx);
  if (distance <= Math.abs(input.dy) * 1.5) return null;
  const far = distance >= IMAGE_SWIPE_DISTANCE_PX;
  const flick = distance >= IMAGE_SWIPE_FLICK_PX && input.elapsedMs <= IMAGE_SWIPE_FLICK_MS;
  if (!far && !flick) return null;
  return input.dx < 0 ? 1 : -1;
}
