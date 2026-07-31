import { describe, expect, it } from "vite-plus/test";
import {
  getAnchoredTurnMetrics,
  getRowBottom,
  rememberTimelineThreadScroll,
  resolveTimelineScrollSnapshotFollowEnd,
  resolveTimelineSendScrollPlan,
  shouldCommitTimelineOlderNavigation,
  shouldReleaseTimelineLiveFollowForTouch,
  shouldReleaseTimelineLiveFollowForWheel,
  shouldMaintainTimelineVisibleContentPosition,
  shouldResumeTimelineLiveFollow,
} from "./timelineScrollAnchoring";

function buildState({
  positions,
  sizes,
  scroll = 0,
  scrollLength = 700,
}: {
  readonly positions: readonly number[];
  readonly sizes: readonly number[];
  readonly scroll?: number;
  readonly scrollLength?: number;
}) {
  return {
    data: positions.map((_, index) => index),
    scroll,
    scrollLength,
    positionAtIndex: (index: number) => positions[index],
    sizeAtIndex: (index: number) => sizes[index],
  };
}

describe("timeline scroll anchoring", () => {
  it("keeps deep and live-edge scroll memories isolated by thread", () => {
    const memories = new Map();
    rememberTimelineThreadScroll(memories, "thread-a", {
      scrollOffset: 1280,
      followEnd: false,
    });
    rememberTimelineThreadScroll(memories, "thread-b", {
      scrollOffset: 0,
      followEnd: true,
    });

    expect(memories.get("thread-a")).toEqual({
      scrollOffset: 1280,
      followEnd: false,
    });
    expect(memories.get("thread-b")).toEqual({
      scrollOffset: 0,
      followEnd: true,
    });
  });

  it("bounds per-thread scroll memory without evicting the newest thread", () => {
    const memories = new Map();
    rememberTimelineThreadScroll(memories, "thread-a", { scrollOffset: 10, followEnd: false }, 2);
    rememberTimelineThreadScroll(memories, "thread-b", { scrollOffset: 20, followEnd: false }, 2);
    rememberTimelineThreadScroll(memories, "thread-c", { scrollOffset: 30, followEnd: false }, 2);

    expect([...memories.keys()]).toEqual(["thread-b", "thread-c"]);
  });

  it("does not treat layout-driven movement as a live-follow opt-out", () => {
    expect(
      resolveTimelineScrollSnapshotFollowEnd({
        isAtEnd: false,
        scrollMode: "following-end",
      }),
    ).toBe(true);
    expect(
      resolveTimelineScrollSnapshotFollowEnd({
        isAtEnd: false,
        scrollMode: "free-scrolling",
      }),
    ).toBe(false);
    expect(
      resolveTimelineScrollSnapshotFollowEnd({
        isAtEnd: true,
        scrollMode: "free-scrolling",
      }),
    ).toBe(true);
  });

  it("uses end-following without a viewport-sized anchor on every viewport", () => {
    expect(
      resolveTimelineSendScrollPlan({
        messageId: "mobile-message",
      }),
    ).toEqual({
      mode: "following-end",
      anchorMessageId: null,
    });
    expect(
      resolveTimelineSendScrollPlan({
        messageId: "desktop-message",
      }),
    ).toEqual({
      mode: "following-end",
      anchorMessageId: null,
    });
  });

  it("keeps live-follow while a manual gesture remains inside the near-end zone", () => {
    expect(
      shouldResumeTimelineLiveFollow({
        isAtEnd: true,
        manualNavigationActive: true,
        manualNavigationTowardEnd: false,
      }),
    ).toBe(true);
    expect(
      shouldResumeTimelineLiveFollow({
        isAtEnd: true,
        manualNavigationActive: true,
        manualNavigationTowardEnd: true,
      }),
    ).toBe(true);
    expect(
      shouldResumeTimelineLiveFollow({
        isAtEnd: false,
        manualNavigationActive: true,
        manualNavigationTowardEnd: true,
      }),
    ).toBe(false);
  });

  it("releases send-time live-follow only for an explicit wheel gesture toward older content", () => {
    expect(shouldReleaseTimelineLiveFollowForWheel(-24)).toBe(true);
    expect(shouldReleaseTimelineLiveFollowForWheel(24)).toBe(false);
    expect(shouldReleaseTimelineLiveFollowForWheel(0)).toBe(false);
  });

  it("waits for a touch gesture toward older content before releasing live-follow", () => {
    expect(shouldReleaseTimelineLiveFollowForTouch(null, 200)).toBe(false);
    expect(shouldReleaseTimelineLiveFollowForTouch(200, 220)).toBe(true);
    expect(shouldReleaseTimelineLiveFollowForTouch(220, 200)).toBe(false);
  });

  it("commits an opt-out only after older navigation leaves the near-end zone", () => {
    expect(
      shouldCommitTimelineOlderNavigation({
        olderNavigationIntent: true,
        isAtEnd: true,
      }),
    ).toBe(false);
    expect(
      shouldCommitTimelineOlderNavigation({
        olderNavigationIntent: true,
        isAtEnd: false,
      }),
    ).toBe(true);
    expect(
      shouldCommitTimelineOlderNavigation({
        olderNavigationIntent: false,
        isAtEnd: false,
      }),
    ).toBe(false);
  });

  it("does not let visible-row restoration compete with live end-following", () => {
    expect(shouldMaintainTimelineVisibleContentPosition({ followEnd: true })).toBe(false);
    expect(shouldMaintainTimelineVisibleContentPosition({ followEnd: false })).toBe(true);
  });

  it("measures row bottoms from LegendList row position and size", () => {
    const state = buildState({
      positions: [0, 120],
      sizes: [80, 40],
    });

    expect(getRowBottom(state, 1)).toBe(160);
  });

  it("treats the active turn as fitting when it fits above the composer", () => {
    const state = buildState({
      positions: [0, 300, 460],
      sizes: [240, 80, 140],
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.turnHeight).toBe(300);
    expect(metrics?.usableViewportHeight).toBe(564);
    expect(metrics?.overflowsUsableViewport).toBe(false);
    expect(metrics?.targetScrollToRevealEnd).toBe(36);
    expect(metrics?.scrollDeltaToRevealEnd).toBe(36);
  });

  it("targets the real row end instead of any temporary reserved tail", () => {
    const state = buildState({
      positions: [0, 1720, 1880],
      sizes: [1600, 80, 120],
      scroll: 1900,
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.lastBottom).toBe(2000);
    expect(metrics?.targetScrollToRevealEnd).toBe(1436);
    expect(metrics?.scrollDeltaToRevealEnd).toBe(0);
  });

  it("reports overflow only for the current anchored turn", () => {
    const state = buildState({
      positions: [0, 900, 1180],
      sizes: [800, 220, 300],
      scroll: 900,
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.turnHeight).toBe(580);
    expect(metrics?.usableViewportHeight).toBe(564);
    expect(metrics?.overflowsUsableViewport).toBe(true);
  });

  it("returns the minimal positive scroll delta needed to reveal the turn end", () => {
    const state = buildState({
      positions: [0, 900, 1180],
      sizes: [800, 220, 360],
      scroll: 900,
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.lastBottom).toBe(1540);
    expect(metrics?.visibleUsableBottom).toBe(1464);
    expect(metrics?.scrollDeltaToRevealEnd).toBe(76);
  });

  it("subtracts composer height from usable viewport height", () => {
    const state = buildState({
      positions: [0, 300],
      sizes: [120, 470],
      scrollLength: 700,
    });

    const withoutComposer = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 0,
      anchorOffset: 16,
    });
    const withComposer = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 220,
      anchorOffset: 16,
    });

    expect(withoutComposer?.overflowsUsableViewport).toBe(false);
    expect(withComposer?.overflowsUsableViewport).toBe(true);
  });
});
