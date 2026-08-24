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
          scrollToEnd: listHarness.scrollToEnd,
          scrollToOffset: listHarness.scrollToOffset,
          scrollToIndex: listHarness.scrollToIndex,
        }) as never,
      [],
    );
    return (
      <div data-testid="fake-legend-list">
        {props.ListHeaderComponent}
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
  it("disables LegendList follow in the same wheel-input task", async () => {
    const onManualNavigation = vi.fn();
    await renderTimeline(buildProps({ onManualNavigation }));
    await flushAnimationFrames();
    expect(listProps().maintainScrollAtEnd).toEqual(expect.any(Object));

    act(() => listProps().onWheel?.({ deltaY: -24 }));

    expect(onManualNavigation).toHaveBeenLastCalledWith(false);
    expect(listProps().maintainScrollAtEnd).toBe(false);
  });

  it("ignores programmatic offset changes without a user-input token", async () => {
    const onManualNavigation = vi.fn();
    await renderTimeline(buildProps({ onManualNavigation }));
    await flushAnimationFrames();
    onManualNavigation.mockClear();

    listHarness.state.scroll = 800;
    act(() => listProps().onScroll?.());

    expect(onManualNavigation).not.toHaveBeenCalled();
    expect(listProps().maintainScrollAtEnd).toEqual(expect.any(Object));
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
    act(() => listProps().onItemSizeChanged?.());
    await flushAnimationFrames(2);
    expect(listHarness.scrollToEnd).not.toHaveBeenCalled();

    act(() => window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })));
    await act(async () => vi.advanceTimersByTimeAsync(TIMELINE_MOMENTUM_SETTLE_MS + 1));
    await flushAnimationFrames(2);

    expect(listHarness.scrollToEnd).toHaveBeenCalledTimes(1);
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
    expect(listProps().maintainScrollAtEnd).toBe(false);
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
    expect(listProps().maintainScrollAtEnd).toBe(false);

    act(() => listProps().onItemSizeChanged?.());
    await flushAnimationFrames(2);
    expect(listHarness.scrollToEnd).not.toHaveBeenCalled();

    act(() => listProps().onTouchEnd?.());
    await act(async () => vi.advanceTimersByTimeAsync(TIMELINE_MOMENTUM_SETTLE_MS - 1));
    listHarness.state.scroll = 850;
    listHarness.state.isAtEnd = false;
    listHarness.state.isNearEnd = false;
    act(() => listProps().onScroll?.());
    onScrollStateChange.mockClear();

    await act(async () => vi.advanceTimersByTimeAsync(TIMELINE_MOMENTUM_SETTLE_MS + 1));
    await flushAnimationFrames(2);

    expect(listHarness.scrollToEnd).not.toHaveBeenCalled();
    expect(onScrollStateChange).toHaveBeenCalledTimes(1);
    expect(listProps().maintainScrollAtEnd).toBe(false);
  });

  it("re-enables live follow when a gesture settles at the exact bottom", async () => {
    const onManualNavigation = vi.fn();
    const onIsAtEndChange = vi.fn();
    await renderTimeline(buildProps({ onManualNavigation, onIsAtEndChange }));
    await flushAnimationFrames();

    act(() => listProps().onWheel?.({ deltaY: -24 }));
    listHarness.state.isAtEnd = false;
    listHarness.state.isNearEnd = true;
    expect(listProps().maintainScrollAtEnd).toBe(false);

    await act(async () => vi.advanceTimersByTimeAsync(TIMELINE_MOMENTUM_SETTLE_MS + 1));
    expect(listProps().maintainScrollAtEnd).toBe(false);

    listHarness.state.isAtEnd = true;
    act(() => listProps().onWheel?.({ deltaY: 24 }));
    await act(async () => vi.advanceTimersByTimeAsync(TIMELINE_MOMENTUM_SETTLE_MS + 1));

    expect(onManualNavigation).toHaveBeenNthCalledWith(1, false);
    expect(onManualNavigation).toHaveBeenLastCalledWith(true);
    expect(onIsAtEndChange).toHaveBeenLastCalledWith(true);
    expect(listProps().maintainScrollAtEnd).toEqual(expect.any(Object));
  });

  it("clears gesture ownership and pending work when the thread route changes", async () => {
    const onManualNavigation = vi.fn();
    const props = buildProps({ onManualNavigation });
    await renderTimeline(props);
    act(() => listProps().onWheel?.({ deltaY: -24 }));
    act(() => listProps().onItemSizeChanged?.());
    expect(listProps().maintainScrollAtEnd).toBe(false);

    await renderTimeline({
      ...props,
      routeThreadKey: "environment-local:thread-scroll-b",
    });

    expect(listProps().maintainScrollAtEnd).toEqual(expect.any(Object));
    listHarness.scrollToEnd.mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(TIMELINE_MOMENTUM_SETTLE_MS + 1));
    await flushAnimationFrames(2);
    expect(listHarness.scrollToEnd).not.toHaveBeenCalled();
  });
});
