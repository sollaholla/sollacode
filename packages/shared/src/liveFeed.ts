import type { OrchestrationLiveBeat, OrchestrationLiveFeedEvent } from "@t3tools/contracts";

/** Beats kept for the Live Inspector: enough to fill a screen with what just happened. */
export const LIVE_FEED_WINDOW = 160;

/**
 * Folds beats into a window of the most recent ones, oldest first. A beat whose
 * id is already there replaces it in place, so a command that finishes, or a
 * reply that keeps being written, updates its line instead of adding another.
 */
export function upsertLiveBeats(
  current: ReadonlyArray<OrchestrationLiveBeat>,
  incoming: ReadonlyArray<OrchestrationLiveBeat>,
  limit: number,
): ReadonlyArray<OrchestrationLiveBeat> {
  const next = [...current];
  for (const beat of incoming) {
    const index = next.findIndex((existing) => existing.id === beat.id);
    if (index === -1) next.push(beat);
    else next[index] = beat;
  }
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/** Applies one feed event to the window a client keeps; a snapshot replaces it outright. */
export function applyLiveFeedEvent(
  current: ReadonlyArray<OrchestrationLiveBeat>,
  event: OrchestrationLiveFeedEvent,
  limit: number,
): ReadonlyArray<OrchestrationLiveBeat> {
  return event.type === "snapshot"
    ? event.beats.slice(Math.max(0, event.beats.length - limit))
    : upsertLiveBeats(current, [event.beat], limit);
}
