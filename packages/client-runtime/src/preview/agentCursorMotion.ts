/**
 * How the agent's cursor travels between the points it reports.
 *
 * Every point used to arrive as a jump: each cursor drew afresh where the new
 * point was, so a click read as a teleport (or a straight 150 ms slide from a
 * stale spot that then snapped back). A glide starts from wherever the cursor
 * is drawn right now. From rest it bows slightly and follows a hand's speed
 * profile: quick to start, quick through the middle, settling onto the
 * target. A new point arriving mid-glide, such as a drag's stream of points,
 * carries on from the current speed instead of stopping first.
 */

export interface AgentCursorPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * The longest glide. The desktop waits 200 ms between announcing a click
 * point and clicking it, so the cursor lands first.
 */
export const AGENT_CURSOR_GLIDE_MAX_MS = 180;

const GLIDE_BASE_MS = 80;
const GLIDE_MS_PER_DOUBLING = 35;
const GLIDE_DISTANCE_UNIT_PX = 32;
const BOW_RATIO = 0.12;
const BOW_MAX_PX = 36;

/** Minimum-jerk progress: the smooth start and settle of a reaching hand. */
export function minimumJerk(t: number): number {
  const c = Math.min(Math.max(t, 0), 1);
  return c * c * c * (10 + c * (-15 + 6 * c));
}

function easeOutCubic(t: number): number {
  const c = 1 - Math.min(Math.max(t, 0), 1);
  return 1 - c * c * c;
}

/** Longer reaches take longer, with diminishing returns, as pointing does. */
export function agentCursorGlideMs(distance: number): number {
  if (!(distance >= 1)) return 0;
  return Math.min(
    AGENT_CURSOR_GLIDE_MAX_MS,
    Math.round(
      GLIDE_BASE_MS + GLIDE_MS_PER_DOUBLING * Math.log2(1 + distance / GLIDE_DISTANCE_UNIT_PX),
    ),
  );
}

export interface AgentCursorGlide {
  readonly durationMs: number;
  /** Where the cursor is at `t` in [0, 1] of the glide. */
  readonly at: (t: number) => AgentCursorPoint;
}

/** Null when the cursor is already there. */
export function planAgentCursorGlide(
  from: AgentCursorPoint,
  to: AgentCursorPoint,
  options: { readonly moving: boolean },
): AgentCursorGlide | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (!(distance >= 1)) return null;
  const durationMs = agentCursorGlideMs(distance);

  if (options.moving) {
    // Already travelling: head straight for the new point without the
    // stop-and-start a fresh reach would put between a drag's points.
    return {
      durationMs,
      at: (t) => {
        const s = easeOutCubic(t);
        return { x: from.x + dx * s, y: from.y + dy * s };
      },
    };
  }

  // A slight bow, always toward the top of the screen (or the right for a
  // vertical reach), so a run of reaches reads as one hand moving.
  const bow = Math.min(distance * BOW_RATIO, BOW_MAX_PX);
  let normalX = -dy / distance;
  let normalY = dx / distance;
  if (normalY > 0 || (normalY === 0 && normalX < 0)) {
    normalX = -normalX;
    normalY = -normalY;
  }
  const controlX = from.x + dx / 2 + normalX * bow;
  const controlY = from.y + dy / 2 + normalY * bow;
  return {
    durationMs,
    at: (t) => {
      const s = minimumJerk(t);
      const u = 1 - s;
      return {
        x: u * u * from.x + 2 * u * s * controlX + s * s * to.x,
        y: u * u * from.y + 2 * u * s * controlY + s * s * to.y,
      };
    },
  };
}
