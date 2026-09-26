// @vitest-environment happy-dom

import { EnvironmentId, MessageId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import {
  act,
  createRef,
  forwardRef,
  useImperativeHandle,
  type ComponentProps,
  type ReactNode,
  type Ref,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const listHarness = vi.hoisted(() => ({
  latestProps: null as Record<string, unknown> | null,
  scroller: null as HTMLDivElement | null,
  contentHeight: 2_000,
  state: {
    data: [] as readonly unknown[],
    scroll: 1_000,
    scrollLength: 600,
    isAtEnd: true,
    isNearEnd: true,
    positionAtIndex: (index: number) => index * 100,
    sizeAtIndex: () => 100,
  },
  scrollToEnd: vi.fn(() => Promise.resolve()),
  scrollToOffset: vi.fn(() => Promise.resolve()),
  scrollToIndex: vi.fn(() => Promise.resolve()),
}));

vi.mock("@legendapp/list/react", async () => {
  const LegendList = forwardRef(function FakeLegendList(
    props: Record<string, unknown> & {
      readonly data?: readonly unknown[];
      readonly ListHeaderComponent?: ReactNode;
      readonly ListFooterComponent?: ReactNode;
      readonly renderItem?: (args: { item: unknown }) => ReactNode;
    },
    ref: Ref<LegendListRef>,
  ) {
    listHarness.latestProps = props;
    listHarness.state.data = props.data ?? [];
    useImperativeHandle(
      ref,
      () =>
        ({
          getState: () => listHarness.state,
          getScrollableNode: () => listHarness.scroller,
          scrollToEnd: listHarness.scrollToEnd,
          scrollToOffset: listHarness.scrollToOffset,
          scrollToIndex: listHarness.scrollToIndex,
        }) as never,
      [],
    );
    return (
      <div
        data-testid="fake-legend-list"
        ref={(element) => {
          listHarness.scroller = element;
          if (element) {
            Object.defineProperty(element, "scrollHeight", {
              configurable: true,
              get: () => listHarness.contentHeight,
            });
            Object.defineProperty(element, "clientHeight", { configurable: true, value: 600 });
          }
        }}
      >
        {props.ListHeaderComponent}
        {props.data?.map((item) => (
          <div key={(item as { id: string }).id}>{props.renderItem?.({ item })}</div>
        ))}
        {props.ListFooterComponent}
      </div>
    );
  });
  return { LegendList };
});

vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => null }));
vi.mock("../../assets/assetUrls", () => ({
  withAssetRevision: (url: string, revision: string) => `${url}?solla_revision=${revision}`,
  useAssetUrlState: () => ({ _tag: "Success", url: "https://example.test/image.png" }),
}));

import { MessagesTimeline } from "./MessagesTimeline";
import { TIMELINE_MOMENTUM_SETTLE_MS } from "./timelineScrollAnchoring";

const createdAt = "2026-08-24T15:00:00.000Z";
const timelineEntries = [
  {
    id: "entry-mounted-scroll",
    kind: "message" as const,
    createdAt,
    message: {
      id: MessageId.make("message-mounted-scroll"),
      role: "user" as const,
      text: "Keep my reading position while work streams.",
      turnId: null,
      createdAt,
      updatedAt: createdAt,
      streaming: false,
    },
  },
];

function buildProps(overrides: Record<string, unknown> = {}) {
  return {
    isWorking: true,
    activeTurnInProgress: true,
    activeTurnStartedAt: createdAt,
    listRef: createRef<LegendListRef | null>(),
    timelineEntries,
    latestTurn: null,
    runningTurnId: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    routeThreadKey: "environment-local:thread-scroll-a",
    onOpenTurnDiff: vi.fn(),
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: vi.fn(),
    isRevertingCheckpoint: false,
    onImageExpand: vi.fn(),
    activeThreadEnvironmentId: EnvironmentId.make("environment-local"),
    markdownCwd: undefined,
    resolvedTheme: "light" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
    followEnd: true,
    onIsAtEndChange: vi.fn(),
    onManualNavigation: vi.fn(),
    onScrollStateChange: vi.fn(),
    onCompactAndContinue: vi.fn(),
    isCompactAndContinueBusy: false,
    resumableAssistantMessageId: null,
    resumableRuntimeErrorActivityId: null,
    onResumeIncompleteTurn: vi.fn(),
    isResumeIncompleteTurnBusy: false,
    isResumeIncompleteTurnDisabled: false,
    ...overrides,
  };
}

type CapturedListProps = {
  readonly maintainScrollAtEnd?: boolean | object;
  readonly maintainVisibleContentPosition?: boolean | object;
  readonly onScroll?: () => void;
  readonly onItemSizeChanged?: () => void;
  readonly onWheel?: (event: { readonly deltaY: number }) => void;
  readonly onTouchStart?: (event: {
    readonly touches: readonly [{ readonly clientY: number }];
  }) => void;
  readonly onTouchMove?: (event: {
    readonly touches: readonly [{ readonly clientY: number }];
  }) => void;
  readonly onTouchEnd?: () => void;
  readonly onPointerDown?: (event: {
    readonly pointerType: string;
    readonly button: number;
    readonly target: EventTarget;
    readonly currentTarget: EventTarget;
  }) => void;
};

function listProps(): CapturedListProps {
  if (listHarness.latestProps === null) throw new Error("LegendList did not render");
  return listHarness.latestProps as CapturedListProps;
}

let root: Root;
let container: HTMLDivElement;
let rafId = 0;
let rafCallbacks: Array<{ readonly id: number; readonly callback: FrameRequestCallback }> = [];

async function renderTimeline(props = buildProps()) {
  await act(async () => {
    root.render(<MessagesTimeline {...(props as ComponentProps<typeof MessagesTimeline>)} />);
  });
}

async function flushAnimationFrames(rounds = 1) {
  for (let round = 0; round < rounds; round += 1) {
    const callbacks = rafCallbacks;
    rafCallbacks = [];
    await act(async () => {
      for (const { callback } of callbacks) callback(performance.now());
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++rafId;
    rafCallbacks.push({ id, callback });
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    rafCallbacks = rafCallbacks.filter((entry) => entry.id !== id);
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  rafCallbacks = [];
  listHarness.latestProps = null;
  listHarness.contentHeight = 2_000;
  listHarness.scroller = null;
  listHarness.state.scroll = 1_000;
  listHarness.state.isAtEnd = true;
  listHarness.state.isNearEnd = true;
  listHarness.scrollToEnd.mockClear();
  listHarness.scrollToOffset.mockClear();
  listHarness.scrollToIndex.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("MessagesTimeline mounted scroll ownership", () => {
  it("coalesces streaming measurements into one frame and follows the latest extent", async () => {
    await renderTimeline();
    await flushAnimationFrames();
    expect(listHarness.scroller?.scrollTop).toBe(1_400);
    expect(listProps().maintainScrollAtEnd).toBe(false);

    for (const height of [2_100, 2_200, 2_300, 2_400]) {
      listHarness.contentHeight = height;
      act(() => listProps().onItemSizeChanged?.());
    }
    await flushAnimationFrames();
    expect(listHarness.scroller?.scrollTop).toBe(1_800);
    expect(listHarness.scrollToEnd).not.toHaveBeenCalled();
  });

  it("opening real tool details releases follow before its height changes", async () => {
    const onManualNavigation = vi.fn();
    await renderTimeline(
      buildProps({
        onManualNavigation,
        timelineEntries: [
          ...timelineEntries,
          {
            id: "tool-details",
            kind: "work",
            createdAt,
            entry: {
              id: "tool-details",
              createdAt,
              tone: "tool",
              label: "Read file",
              detail: "Stored output\nSecond line",
              sourceActivityKind: "tool.completed",
            },
          },
        ],
      }),
    );
    await flushAnimationFrames();
    const disclosure = container.querySelector<HTMLElement>('[role="button"][aria-expanded]');
    if (!disclosure) throw new Error("tool disclosure missing");
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    act(() => disclosure.click());
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(onManualNavigation).toHaveBeenLastCalledWith(false);
    expect(listProps().maintainVisibleContentPosition).toBe(false);

    listHarness.contentHeight = 2_600;
    act(() => listProps().onItemSizeChanged?.());
    await flushAnimationFrames();
    expect(listHarness.scroller?.scrollTop).toBe(1_400);
  });

  it("an explicit return to end clears the previous gesture before streaming continues", async () => {
    const props = buildProps();
    await renderTimeline(props);
    await flushAnimationFrames();
    act(() => listProps().onWheel?.({ deltaY: -24 }));
    await renderTimeline({ ...props, followEnd: false });
    listHarness.contentHeight = 2_600;
    await renderTimeline({ ...props, followEnd: true });
    await flushAnimationFrames();
    expect(listHarness.scroller?.scrollTop).toBe(2_000);

    listHarness.contentHeight = 2_900;
    act(() => listProps().onItemSizeChanged?.());
    await flushAnimationFrames();
    expect(listHarness.scroller?.scrollTop).toBe(2_300);
  });

  it("does not report the near-end zone as a return to the actual bottom", async () => {
    const onIsAtEndChange = vi.fn();
    await renderTimeline(buildProps({ onIsAtEndChange }));
    act(() => listProps().onWheel?.({ deltaY: -24 }));
    listHarness.state.isAtEnd = false;
    listHarness.state.isNearEnd = true;
    act(() => listProps().onWheel?.({ deltaY: 12 }));
    act(() => listProps().onScroll?.());
    expect(onIsAtEndChange).toHaveBeenLastCalledWith(false);
    expect(listProps().maintainVisibleContentPosition).toEqual(expect.any(Object));
  });

  it("releases measured end-follow in the same wheel-input task", async () => {
    const onManualNavigation = vi.fn();
    await renderTimeline(buildProps({ onManualNavigation }));
    await flushAnimationFrames();
    expect(listProps().maintainVisibleContentPosition).toBe(false);

    act(() => listProps().onWheel?.({ deltaY: -24 }));

    expect(onManualNavigation).toHaveBeenLastCalledWith(false);
    expect(listProps().maintainVisibleContentPosition).toEqual(expect.any(Object));
  });

  it("ignores programmatic offset changes without a user-input token", async () => {
    const onManualNavigation = vi.fn();
    await renderTimeline(buildProps({ onManualNavigation }));
    await flushAnimationFrames();
    onManualNavigation.mockClear();

    listHarness.state.scroll = 800;
    act(() => listProps().onScroll?.());

    expect(onManualNavigation).not.toHaveBeenCalled();
    expect(listProps().maintainVisibleContentPosition).toBe(false);
  });

  it("defers resize reconciliation until a scrollbar gesture released outside settles", async () => {
    await renderTimeline();
    await flushAnimationFrames();
    listHarness.scrollToEnd.mockClear();
    const listElement = container.querySelector("[data-testid='fake-legend-list']");
    if (listElement === null) throw new Error("fake list element missing");

    act(() =>
      listProps().onPointerDown?.({
        pointerType: "mouse",
        button: 1,
        target: listElement,
        currentTarget: listElement,
      }),
    );
    listHarness.contentHeight = 2_600;
    act(() => listProps().onItemSizeChanged?.());
    await flushAnimationFrames(2);
    expect(listHarness.scroller?.scrollTop).toBe(1_400);

    act(() => window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })));
    await act(async () => vi.advanceTimersByTimeAsync(TIMELINE_MOMENTUM_SETTLE_MS + 1));
    await flushAnimationFrames(2);

    expect(listHarness.scroller?.scrollTop).toBe(2_000);
    expect(listHarness.scrollToEnd).not.toHaveBeenCalled();
  });

  it("does not let timeline keyboard handling claim an unrelated scroll surface", async () => {
    const onManualNavigation = vi.fn();
    await renderTimeline(buildProps({ onManualNavigation }));
    const unrelatedScroller = document.createElement("div");
    unrelatedScroller.tabIndex = 0;
    document.body.append(unrelatedScroller);

    unrelatedScroller.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
    expect(onManualNavigation).not.toHaveBeenCalled();

    const timeline = container.querySelector("[data-chat-timeline-bottom-inset]");
    if (timeline === null) throw new Error("timeline viewport missing");
    timeline.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    unrelatedScroller.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
    expect(onManualNavigation).not.toHaveBeenCalled();

    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
    expect(onManualNavigation).toHaveBeenLastCalledWith(false);
    unrelatedScroller.remove();
  });

  it.each([
    { label: "scrollbar", button: 0 },
    { label: "middle-button scroll", button: 1 },
  ])("classifies the first $label movement after a route reset", async ({ button }) => {
    const onManualNavigation = vi.fn();
    const props = buildProps({ onManualNavigation });
    await renderTimeline(props);
    await flushAnimationFrames();
    await renderTimeline({
      ...props,
      routeThreadKey: "environment-local:thread-scroll-b",
    });
    onManualNavigation.mockClear();

    const listElement = container.querySelector("[data-testid='fake-legend-list']");
    if (listElement === null) throw new Error("fake list element missing");
    act(() =>
      listProps().onPointerDown?.({
        pointerType: "mouse",
        button,
        target: listElement,
        currentTarget: listElement,
      }),
    );
    listHarness.state.scroll = 800;
    listHarness.state.isAtEnd = false;
    listHarness.state.isNearEnd = false;
    act(() => listProps().onScroll?.());

    expect(onManualNavigation).toHaveBeenLastCalledWith(false);
    expect(listProps().maintainVisibleContentPosition).toEqual(expect.any(Object));
  });

  it("keeps mobile touch ownership through momentum and flushes deferred resize work", async () => {
    const onManualNavigation = vi.fn();
    const onScrollStateChange = vi.fn();
    await renderTimeline(buildProps({ onManualNavigation, onScrollStateChange }));
    await flushAnimationFrames();
    listHarness.scrollToEnd.mockClear();

    act(() => listProps().onTouchStart?.({ touches: [{ clientY: 200 }] }));
    act(() => listProps().onTouchMove?.({ touches: [{ clientY: 224 }] }));
    expect(onManualNavigation).toHaveBeenLastCalledWith(false);
    expect(listProps().maintainVisibleContentPosition).toEqual(expect.any(Object));

    listHarness.contentHeight = 2_600;
    act(() => listProps().onItemSizeChanged?.());
    await flushAnimationFrames(2);
    expect(listHarness.scroller?.scrollTop).toBe(1_400);

    act(() => listProps().onTouchEnd?.());
    await act(async () => vi.advanceTimersByTimeAsync(TIMELINE_MOMENTUM_SETTLE_MS - 1));
    listHarness.state.scroll = 850;
    listHarness.state.isAtEnd = false;
    listHarness.state.isNearEnd = false;
    act(() => listProps().onScroll?.());
    onScrollStateChange.mockClear();

    await act(async () => vi.advanceTimersByTimeAsync(TIMELINE_MOMENTUM_SETTLE_MS + 1));
    await flushAnimationFrames(2);

    expect(listHarness.scroller?.scrollTop).toBe(1_400);
    expect(onScrollStateChange).toHaveBeenCalledTimes(1);
    expect(listProps().maintainVisibleContentPosition).toEqual(expect.any(Object));
  });

  it("re-enables live follow when a gesture settles at the exact bottom", async () => {
    const onManualNavigation = vi.fn();
    const onIsAtEndChange = vi.fn();
    await renderTimeline(buildProps({ onManualNavigation, onIsAtEndChange }));
    await flushAnimationFrames();

    act(() => listProps().onWheel?.({ deltaY: -24 }));
    listHarness.state.isAtEnd = false;
    listHarness.state.isNearEnd = true;
    expect(listProps().maintainVisibleContentPosition).toEqual(expect.any(Object));

    await act(async () => vi.advanceTimersByTimeAsync(TIMELINE_MOMENTUM_SETTLE_MS + 1));
    expect(listProps().maintainVisibleContentPosition).toEqual(expect.any(Object));

    listHarness.state.isAtEnd = true;
    act(() => listProps().onWheel?.({ deltaY: 24 }));
    await act(async () => vi.advanceTimersByTimeAsync(TIMELINE_MOMENTUM_SETTLE_MS + 1));

    expect(onManualNavigation).toHaveBeenNthCalledWith(1, false);
    expect(onManualNavigation).toHaveBeenLastCalledWith(true);
    expect(onIsAtEndChange).toHaveBeenLastCalledWith(true);
    expect(listProps().maintainVisibleContentPosition).toBe(false);
  });

  it("clears gesture ownership and pending work when the thread route changes", async () => {
    const onManualNavigation = vi.fn();
    const props = buildProps({ onManualNavigation });
    await renderTimeline(props);
    act(() => listProps().onWheel?.({ deltaY: -24 }));
    listHarness.contentHeight = 2_600;
    act(() => listProps().onItemSizeChanged?.());
    expect(listProps().maintainVisibleContentPosition).toEqual(expect.any(Object));

    await renderTimeline({
      ...props,
      routeThreadKey: "environment-local:thread-scroll-b",
    });

    expect(listProps().maintainVisibleContentPosition).toBe(false);
    listHarness.scrollToEnd.mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(TIMELINE_MOMENTUM_SETTLE_MS + 1));
    await flushAnimationFrames(2);
    expect(listHarness.scroller?.scrollTop).toBe(2_000);
  });
});
