export type TimelineScrollMode = "following-end" | "anchoring-new-turn" | "free-scrolling";

export interface TimelineThreadScrollMemory {
  readonly scrollOffset: number;
  readonly followEnd: boolean;
}

export function resolveTimelineScrollSnapshotFollowEnd({
  isAtEnd,
  scrollMode,
}: {
  readonly isAtEnd: boolean | undefined;
  readonly scrollMode: TimelineScrollMode;
}): boolean {
  return isAtEnd === true || scrollMode === "following-end";
}

export function rememberTimelineThreadScroll(
  memories: Map<string, TimelineThreadScrollMemory>,
  threadKey: string,
  memory: TimelineThreadScrollMemory,
  maxEntries = 200,
): void {
  memories.delete(threadKey);
  memories.set(threadKey, memory);
  while (memories.size > Math.max(1, maxEntries)) {
    const oldestThreadKey = memories.keys().next().value;
    if (typeof oldestThreadKey !== "string") break;
    memories.delete(oldestThreadKey);
  }
}

export interface TimelineSendScrollPlan<TMessageId> {
  readonly mode: Extract<TimelineScrollMode, "following-end">;
  readonly anchorMessageId: TMessageId | null;
}

export function resolveTimelineSendScrollPlan<TMessageId>({
  messageId: _messageId,
}: {
  readonly messageId: TMessageId;
}): TimelineSendScrollPlan<TMessageId> {
  return { mode: "following-end", anchorMessageId: null };
}

export function shouldResumeTimelineLiveFollow({
  isAtEnd,
  manualNavigationActive: _manualNavigationActive,
  manualNavigationTowardEnd: _manualNavigationTowardEnd,
}: {
  readonly isAtEnd: boolean;
  readonly manualNavigationActive: boolean;
  readonly manualNavigationTowardEnd: boolean;
}): boolean {
  // LegendList's `isNearEnd` feeds this value. A small upward gesture should
  // not strand the user just above the live edge; only leaving the near-end
  // zone is an intentional opt-out.
  return isAtEnd;
}

/**
 * Whether agent-driven timeline growth should skip its snap to the live edge.
 *
 * A scroll already in flight outranks new agent content for a short window: the
 * "am I still at the end?" signal lags the gesture, so without this, reading
 * back through a running turn gets yanked to the bottom every time a chunk
 * lands. Callers clear `lastUserScrollAt` on the gestures that mean "put me back
 * on the live edge" — sending, or explicitly jumping to the end — so those never
 * serve out the remainder of the window.
 */
export function shouldSuppressTimelineAutoScroll({
  lastUserScrollAt,
  nowMs,
  cooldownMs,
}: {
  readonly lastUserScrollAt: number | null;
  readonly nowMs: number;
  readonly cooldownMs: number;
}): boolean {
  if (lastUserScrollAt === null) return false;
  const elapsed = nowMs - lastUserScrollAt;
  // A clock that moved backwards (NTP correction, sleep/wake) must not strand
  // live-follow off for an unbounded stretch.
  if (elapsed < 0) return false;
  return elapsed < cooldownMs;
}

/**
 * Sending deliberately enables live-follow. Do not release that lock for
 * downward wheel motion (which is already asking to see newer content); only
 * an explicit gesture toward older content opts the user out.
 */
export function shouldReleaseTimelineLiveFollowForWheel(deltaY: number): boolean {
  return Number.isFinite(deltaY) && deltaY < 0;
}

/**
 * On a touch surface, dragging a finger down moves the timeline toward older
 * content. Touch-start alone is not navigation and must not disable follow.
 */
export function shouldReleaseTimelineLiveFollowForTouch(
  previousTouchY: number | null,
  currentTouchY: number | null,
): boolean {
  return (
    previousTouchY !== null &&
    currentTouchY !== null &&
    Number.isFinite(previousTouchY) &&
    Number.isFinite(currentTouchY) &&
    currentTouchY > previousTouchY
  );
}

export function shouldCommitTimelineOlderNavigation({
  olderNavigationIntent,
  isAtEnd,
}: {
  readonly olderNavigationIntent: boolean;
  readonly isAtEnd: boolean | undefined;
}): boolean {
  return olderNavigationIntent && isAtEnd === false;
}

/**
 * LegendList's visible-content anchoring and end-following are competing
 * position owners. While following the live edge, preserving the previously
 * visible row can restore a removed/folded row near the start of a long
 * thread. Only preserve visible content after the user explicitly leaves the
 * live edge.
 */
export function shouldMaintainTimelineVisibleContentPosition({
  followEnd,
}: {
  readonly followEnd: boolean;
}): boolean {
  return !followEnd;
}

export interface TimelineListMeasurementState {
  readonly data: readonly unknown[];
  readonly scroll: number;
  readonly scrollLength: number;
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly sizeAtIndex: (index: number) => number | undefined;
}

export interface AnchoredTurnMetrics {
  readonly anchorTop: number;
  readonly lastBottom: number;
  readonly turnHeight: number;
  readonly usableViewportHeight: number;
  readonly visibleUsableBottom: number;
  readonly overflowsUsableViewport: boolean;
  readonly targetScrollToRevealEnd: number;
  readonly scrollDeltaToRevealEnd: number;
}

export function getRowBottom(state: TimelineListMeasurementState, index: number): number | null {
  const top = state.positionAtIndex(index);
  const height = state.sizeAtIndex(index);
  if (
    typeof top !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(top) ||
    !Number.isFinite(height)
  ) {
    return null;
  }

  return top + Math.max(1, height);
}

export function getAnchoredTurnMetrics({
  state,
  anchorIndex,
  composerOverlayHeight,
  anchorOffset,
}: {
  readonly state: TimelineListMeasurementState;
  readonly anchorIndex: number;
  readonly composerOverlayHeight: number;
  readonly anchorOffset: number;
}): AnchoredTurnMetrics | null {
  if (state.data.length === 0) {
    return null;
  }

  const boundedAnchorIndex = Math.max(0, Math.min(anchorIndex, state.data.length - 1));
  const anchorTop = state.positionAtIndex(boundedAnchorIndex);
  const lastBottom = getRowBottom(state, state.data.length - 1);
  if (typeof anchorTop !== "number" || !Number.isFinite(anchorTop) || lastBottom === null) {
    return null;
  }

  const usableViewportHeight = Math.max(
    0,
    state.scrollLength - composerOverlayHeight - anchorOffset,
  );
  const turnHeight = Math.max(0, lastBottom - anchorTop);
  const visibleUsableBottom = state.scroll + usableViewportHeight;
  const targetScrollToRevealEnd = Math.max(0, lastBottom - usableViewportHeight);
  const scrollDeltaToRevealEnd = Math.max(0, targetScrollToRevealEnd - state.scroll);

  return {
    anchorTop,
    lastBottom,
    turnHeight,
    usableViewportHeight,
    visibleUsableBottom,
    overflowsUsableViewport: turnHeight > usableViewportHeight,
    targetScrollToRevealEnd,
    scrollDeltaToRevealEnd,
  };
}

/**
 * Whether a content resize may snap the timeline back to the live edge.
 *
 * Following the live edge is re-asserted whenever a row changes size, which
 * during a streaming turn is continuously. That correction competes with the
 * person scrolling: a drag toward older content raises the intent flag, but
 * the very next resize scrolls to the end again, and the position lands back
 * at the bottom before the scroll handler ever observes the list having left
 * it. On a touch surface that happens on nearly every frame of a momentum
 * scroll, so the timeline repeatedly hauls itself back down.
 *
 * A gesture in progress, or an intent already raised, means the position is
 * the user's to decide until they return to the end themselves.
 */
export function shouldSnapTimelineToEndOnResize(input: {
  readonly followEnd: boolean;
  readonly userGestureActive: boolean;
  readonly olderNavigationIntent: boolean;
}): boolean {
  if (!input.followEnd) return false;
  return !input.userGestureActive && !input.olderNavigationIntent;
}

/**
 * Whether sitting at the end should discard a pending older-navigation intent.
 *
 * The intent is cleared when the list is at the end so a drag that never
 * actually left the bottom does not disable following. But a *programmatic*
 * snap back to the end also reports `isAtEnd`, and clearing on that throws
 * away the gesture that was still underway — which is the other half of the
 * timeline fighting the scroll. While a finger is down, the position is not
 * settled and says nothing about what the user wants.
 */
export function shouldClearOlderNavigationIntent(input: {
  readonly isAtEnd: boolean | undefined;
  readonly userGestureActive: boolean;
}): boolean {
  return input.isAtEnd === true && !input.userGestureActive;
}

/**
 * How long after the last scroll event a touch gesture is still treated as
 * in progress.
 *
 * `touchend` does not mean the scroll ended. iOS keeps the list moving under
 * momentum for seconds afterwards, and every row measured during that glide
 * fires an item-size change. The guards that protect the user's position —
 * see {@link shouldSnapTimelineToEndOnResize}, whose own comment warns that
 * a resize snap "happens on nearly every frame of a momentum scroll, so the
 * timeline repeatedly hauls itself back down" — all key off
 * `userGestureActive`, which went false the instant the finger lifted. So the
 * protection covered the drag and then switched itself off for exactly the
 * part of the scroll the user still perceives as theirs, which is why the
 * view shifted while scrolling up on iOS but sat still on a trackpad.
 *
 * 150ms is comfortably longer than the ~16ms scroll-event cadence of a glide
 * and short enough that a settled list stops being treated as gesturing.
 */
export const TIMELINE_MOMENTUM_SETTLE_MS = 150;
