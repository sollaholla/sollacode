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
