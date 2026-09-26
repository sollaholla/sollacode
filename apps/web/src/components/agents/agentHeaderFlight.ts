/**
 * Geometry for folding an agent's header card into the phone top bar: the
 * avatar is dragged (or flown) from its place on the card to the top bar's
 * right edge, and back again when the folded avatar is tapped.
 */

export interface FlightRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Folded controls in the top bar: the avatar button, then the panel toggle. */
export const COLLAPSED_AVATAR_SIZE_PX = 32;
const COLLAPSED_CONTROL_GAP_PX = 8;
const COLLAPSED_PANEL_TOGGLE_WIDTH_PX = 28;

/** Movement before a press on the avatar counts as a drag rather than a tap. */
export const DRAG_START_DISTANCE_PX = 6;

/** How far along the way to the top bar a released drag has to be to fold. */
const COLLAPSE_AT_PROGRESS = 0.3;

export const FLIGHT_DURATION_MS = 320;
export const FLIGHT_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

export function rectOf(element: Element): FlightRect {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/**
 * Where the folded avatar will sit, before it exists: at the slot's right
 * edge, left of the panel toggle, centred on the bar. Only steers the drag;
 * the landing is measured from the real avatar once it renders.
 */
export function estimateCollapsedAvatarRect(slot: FlightRect): FlightRect {
  const right = slot.left + slot.width;
  return {
    left:
      right - COLLAPSED_PANEL_TOGGLE_WIDTH_PX - COLLAPSED_CONTROL_GAP_PX - COLLAPSED_AVATAR_SIZE_PX,
    top: slot.top + slot.height / 2 - COLLAPSED_AVATAR_SIZE_PX / 2,
    width: COLLAPSED_AVATAR_SIZE_PX,
    height: COLLAPSED_AVATAR_SIZE_PX,
  };
}

function center(rect: FlightRect) {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/**
 * How far a drag of (dx, dy) has carried the avatar toward the top bar, 0 to
 * 1: the drag projected onto the line from the avatar to its folded place.
 * Sideways or backwards movement does not count.
 */
export function dragProgress(dx: number, dy: number, from: FlightRect, to: FlightRect): number {
  const start = center(from);
  const end = center(to);
  const pathX = end.x - start.x;
  const pathY = end.y - start.y;
  const length = pathX * pathX + pathY * pathY;
  if (length === 0) return 1;
  return Math.min(1, Math.max(0, (dx * pathX + dy * pathY) / length));
}

/** Whether a released drag folds the card, or the avatar goes back. */
export function releasedDragCollapses(progress: number): boolean {
  return progress >= COLLAPSE_AT_PROGRESS;
}

/**
 * The transform that draws an element laid out at `from` over `to`, with its
 * origin at the top-left corner. The flying avatar is always laid out at its
 * place on the card, so it only ever scales down, never blurs up.
 */
export function flightTransform(from: FlightRect, to: FlightRect): string {
  const scale = from.width === 0 ? 1 : to.width / from.width;
  return `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${scale})`;
}

/** The avatar mid-drag: under the finger, shrinking as it nears the bar. */
export function dragTransform(
  dx: number,
  dy: number,
  progress: number,
  from: FlightRect,
  to: FlightRect,
): string {
  const endScale = from.width === 0 ? 1 : to.width / from.width;
  const scale = 1 + (endScale - 1) * progress;
  return `translate(${dx}px, ${dy}px) scale(${scale})`;
}
