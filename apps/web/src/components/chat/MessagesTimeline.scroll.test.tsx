// @vitest-environment happy-dom

import { EnvironmentId, MessageId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import {
  act,
  createRef,
  forwardRef,
  useImperativeHandle,
  useState,
  type ComponentProps,
  type ReactNode,
  type Ref,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vite-plus/test";

const listHarness = vi.hoisted(() => ({
  latestProps: null as Record<string, unknown> | null,
  scroller: null as HTMLDivElement | null,
  contentHeight: 2_000,
  rowHeight: 100,
  measuredRowHeight: 100,
  nativeScrollEnd: false,
  state: {
    data: [] as readonly unknown[],
    scroll: 1_000,
    scrollLength: 600,
    isAtEnd: true,
    isNearEnd: true,
    positionAtIndex: (index: number) => index * 100,
    startBuffered: 0,
    endBuffered: 0,
    elementAtIndex: vi.fn<() => HTMLElement | null>(),
    sizeAtIndex: () => listHarness.measuredRowHeight,
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
            if (listHarness.nativeScrollEnd) {
              Object.defineProperty(element, "onscrollend", { configurable: true, value: null });
            }
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

function TimelineWithParentFollow({ props }: { props: ReturnType<typeof buildProps> }) {
  const [followEnd, setFollowEnd] = useState(props.followEnd);
  return (
    <MessagesTimeline
      {...(props as ComponentProps<typeof MessagesTimeline>)}
      followEnd={followEnd}
      onManualNavigation={(towardEnd) => {
        props.onManualNavigation(towardEnd);
        setFollowEnd(false);
      }}
      onIsAtEndChange={(isAtEnd) => {
        props.onIsAtEndChange(isAtEnd);
        if (isAtEnd) setFollowEnd(true);
      }}
    />
  );
}

async function renderTimelineWithParent(props = buildProps()) {
  await act(async () => root.render(<TimelineWithParentFollow props={props} />));
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
  listHarness.rowHeight = listHarness.measuredRowHeight = 100;
  listHarness.nativeScrollEnd = false;
  const row = document.createElement("div");
  row.getBoundingClientRect = () => ({ height: listHarness.rowHeight }) as DOMRect;
  listHarness.state.elementAtIndex.mockReturnValue(row);
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
  it("shows the compact image index only while its tool card is collapsed", async () => {
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 400,
      height: 52,
      top: 0,
      left: 0,
      right: 400,
      bottom: 52,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    try {
      await renderTimeline(
        buildProps({
          isWorking: false,
          timelineEntries: [
            {
              id: "image-work",
              kind: "work",
              createdAt,
              entry: {
                id: "image-work",
                createdAt,
                label: "Image view",
                tone: "tool",
                readImagePath: "/tmp/scene.png",
              },
            },
          ],
        }),
      );
      expect(container.querySelector("[data-work-log-images]")).not.toBeNull();
      const card = container.querySelector<HTMLDivElement>(
        '[role="button"][aria-expanded="false"]',
      );
      expect(card).not.toBeNull();
      await act(async () => card!.click());
      expect(card?.getAttribute("aria-expanded")).toBe("true");
      expect(container.querySelector("[data-work-log-images]")).toBeNull();
      expect(container.querySelector('button[aria-label^="Open image preview:"]')).not.toBeNull();
      await act(async () => card!.click());
      expect(container.querySelector("[data-work-log-images]")).not.toBeNull();
    } finally {
      bounds.mockRestore();
    }
  });

  it("opens any image in the conversation among all of them, oldest first", async () => {
    // Room for the work log's thumbnail row to draw its tile.
    const bounds = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue(DOMRect.fromRect({ width: 400, height: 52 }));
    onTestFinished(() => bounds.mockRestore());
    const onImageExpand = vi.fn();
    await renderTimeline(
      buildProps({
        isWorking: false,
        onImageExpand,
        timelineEntries: [
          {
            id: "ask",
            kind: "message",
            createdAt,
            message: {
              id: MessageId.make("ask"),
              role: "user",
              text: "Match this mock",
              turnId: null,
              createdAt,
              updatedAt: createdAt,
              streaming: false,
              attachments: [
                {
                  type: "image",
                  id: "mock",
                  name: "mock.png",
                  mimeType: "image/png",
                  sizeBytes: 10,
                  previewUrl: "blob:mock",
                },
              ],
            },
          },
          {
            id: "image-work",
            kind: "work",
            createdAt,
            entry: {
              id: "image-work",
              createdAt,
              label: "Image view",
              tone: "tool",
              readImagePath: "/tmp/scene.png",
            },
          },
        ],
      }),
    );
    const open = async (label: string) => {
      const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
      expect(button).not.toBeNull();
      await act(async () => button!.click());
      return onImageExpand.mock.lastCall?.[0];
    };
    const gallery = [
      { name: "mock.png", src: "blob:mock" },
      {
        name: "scene.png",
        asset: expect.objectContaining({
          resource: expect.objectContaining({ _tag: "workspace-file", path: "/tmp/scene.png" }),
        }),
      },
    ];
    expect(await open("Preview mock.png")).toEqual({ images: gallery, index: 0 });
    expect(await open("Open image: scene.png")).toEqual({ images: gallery, index: 1 });
    // The open tool card's own preview opens the same way.
    await act(async () =>
      container.querySelector<HTMLDivElement>('[role="button"][aria-expanded="false"]')!.click(),
    );
    const cardPreview = container.querySelector<HTMLButtonElement>(
      'button[aria-label^="Open image preview:"]',
    );
    await act(async () => cardPreview!.click());
    expect(onImageExpand.mock.lastCall?.[0]).toEqual({ images: gallery, index: 1 });
  });

  it("removes the group image index when earlier tool calls are expanded", async () => {
    await renderTimeline(
      buildProps({
        isWorking: false,
        timelineEntries: [
          {
            id: "first-image",
            kind: "work",
            createdAt,
            entry: {
              id: "first-image",
              createdAt,
              label: "Image view",
              tone: "tool",
              readImagePath: "/tmp/scene.png",
            },
          },
          {
            id: "last-call",
            kind: "work",
            createdAt,
            entry: {
              id: "last-call",
              createdAt,
              label: "Ran command",
              tone: "tool",
              command: "pwd",
            },
          },
        ],
      }),
    );
    const toggle = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("previous tool call"),
    );
    expect(toggle?.parentElement?.querySelector("[data-work-log-images]")).not.toBeNull();
    await act(async () => toggle!.click());
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(toggle?.parentElement?.querySelector("[data-work-log-images]")).toBeNull();
  });

  it("keeps one working timer ticking through disconnect and settles it on reconnect", async () => {
    vi.setSystemTime(new Date("2026-10-01T22:00:10Z"));
    const active = buildProps({ isWorking: true, activeTurnStartedAt: "2026-10-01T22:00:00Z" });
    await renderTimeline(active);
    const workingRow = container.querySelector('[data-timeline-row-kind="working"]');
    expect(workingRow?.textContent).toContain("10s");
    await renderTimeline(buildProps({ ...active, environmentUnreachable: true }));
    expect(container.querySelector('[data-timeline-row-kind="working"]')).toBe(workingRow);
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(workingRow?.textContent).toContain("15s");
    expect(workingRow?.textContent).not.toContain("offline");
    await renderTimeline(
      buildProps({ ...active, environmentUnreachable: false, isWorking: false }),
    );
    expect(container.querySelector('[data-timeline-row-kind="working"]')).toBeNull();
  });

  it("checks the original settings separator when its receipt arrives without adding another", async () => {
    const message = {
      id: MessageId.make("settings-change"),
      role: "user",
      text: "Settings updated: gpt-6-astra with high effort. Apply these settings immediately and continue the current task without waiting for another message.",
      createdAt,
      updatedAt: createdAt,
      streaming: false,
    };
    const change = { id: message.id, kind: "message", createdAt, message };
    const pending = buildProps({ isWorking: false, timelineEntries: [change] });
    await renderTimeline(pending);
    const separator = container.querySelector('[role="separator"]');
    expect(separator).not.toBeNull();
    expect(container.querySelectorAll('[role="separator"]')).toHaveLength(1);
    expect(separator?.getAttribute("aria-label")).toContain("Applying settings");
    await renderTimeline(
      buildProps({
        ...pending,
        timelineEntries: [
          change,
          {
            kind: "work",
            id: "switch-receipt",
            createdAt,
            entry: {
              id: "switch-receipt",
              createdAt,
              label: "Switched from Claude to Codex",
              tone: "info",
              sourceActivityKind: "provider.handoff.completed",
            },
          },
        ],
      }),
    );
    expect(container.querySelectorAll('[role="separator"]')).toHaveLength(1);
    expect(container.querySelector('[role="separator"]')).toBe(separator);
    expect(separator?.querySelector('[aria-label="Switch complete"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Switched from Claude to Codex");
  });

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
    const onIsAtEndChange = vi.fn();
    await renderTimelineWithParent(
      buildProps({
        onManualNavigation,
        onIsAtEndChange,
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

    onIsAtEndChange.mockClear();
    listHarness.rowHeight = 700;
    // The DOM expanded, but ResizeObserver has not updated the list's cached
    // height yet. A capture-scheduled frame still sees the old end here.
    await flushAnimationFrames(2);
    expect(onIsAtEndChange).not.toHaveBeenCalledWith(true);

    listHarness.measuredRowHeight = 700;
    listHarness.contentHeight = 2_600;
    act(() => listProps().onItemSizeChanged?.());
    await flushAnimationFrames();
    expect(listHarness.scroller?.scrollTop).toBe(1_400);
    expect(onIsAtEndChange).not.toHaveBeenCalledWith(true);
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

  it("keeps following after expanding and collapsing earlier tools at the bottom", async () => {
    const props = buildProps({
      timelineEntries: [
        ...timelineEntries,
        ...["first-call", "last-call"].map((id) => ({
          id,
          kind: "work" as const,
          createdAt,
          entry: { id, createdAt, label: "Ran command", tone: "tool", command: "pwd" },
        })),
      ],
    });
    await renderTimelineWithParent(props);
    await flushAnimationFrames();
    const scroller = listHarness.scroller!;
    const toggle = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("previous tool call"),
    )!;
    // Earlier tools are inserted above the toggle; the working footer remains
    // below it. Model the resulting browser geometry, including anchor restores.
    toggle.getBoundingClientRect = () =>
      ({ top: listHarness.contentHeight - 250 - scroller.scrollTop }) as DOMRect;

    for (const height of [2600, 2000]) {
      props.onIsAtEndChange.mockClear();
      act(() => toggle.click());
      // Capture runs before the toggle's click handler. The old layout must
      // not restore follow before the expansion has committed.
      expect(props.onIsAtEndChange).not.toHaveBeenCalledWith(true);
      listHarness.contentHeight = height;
      listHarness.state.isAtEnd = false;
      act(() => listProps().onItemSizeChanged?.());
      await flushAnimationFrames(2);
      expect(scroller.scrollTop).toBe(height - 600);
      expect(props.onIsAtEndChange).toHaveBeenCalledWith(true);
      expect(listProps().maintainVisibleContentPosition).toBe(false);
    }

    listHarness.contentHeight = 2300;
    act(() => listProps().onItemSizeChanged?.());
    await flushAnimationFrames();
    expect(scroller.scrollTop).toBe(1700);
  });

  it.each(["already reading", "new upward input"])(
    "does not resume a disclosure at the bottom when %s owns the viewport",
    async (navigation) => {
      const props = buildProps({
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
              detail: "Stored output",
              sourceActivityKind: "tool.completed",
            },
          },
        ],
      });
      await renderTimelineWithParent(props);
      await flushAnimationFrames();
      const scroller = listHarness.scroller!;
      const scrollUp = () => {
        act(() => listProps().onWheel?.({ deltaY: -8 }));
        listHarness.state.scroll = scroller.scrollTop = 1392;
        listHarness.state.isAtEnd = false;
        act(() => listProps().onScroll?.());
      };
      if (navigation === "already reading") scrollUp();
      props.onIsAtEndChange.mockClear();
      const disclosure = container.querySelector<HTMLElement>('[role="button"][aria-expanded]')!;
      act(() => disclosure.click());
      if (navigation === "new upward input") scrollUp();
      await act(async () => vi.advanceTimersByTimeAsync(TIMELINE_MOMENTUM_SETTLE_MS + 1));
      await flushAnimationFrames(2);
      expect(props.onIsAtEndChange).not.toHaveBeenCalledWith(true);
      expect(scroller.scrollTop).toBe(1392);
    },
  );

  it.each(["Enter", " "])("resumes after collapsing tool details with %j", async (key) => {
    const props = buildProps({
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
            detail: "Stored output",
            sourceActivityKind: "tool.completed",
          },
        },
      ],
    });
    await renderTimelineWithParent(props);
    await flushAnimationFrames();
    const disclosure = container.querySelector<HTMLElement>('[role="button"][aria-expanded]')!;
    act(() => disclosure.click());
    listHarness.contentHeight = 2600;
    act(() => listProps().onItemSizeChanged?.());
    await flushAnimationFrames(2);
    expect(listHarness.scroller?.scrollTop).toBe(1400);
    props.onIsAtEndChange.mockClear();

    act(() => disclosure.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    listHarness.contentHeight = 2000;
    act(() => listProps().onItemSizeChanged?.());
    await flushAnimationFrames(2);
    expect(props.onIsAtEndChange).toHaveBeenCalledWith(true);
    expect(listProps().maintainVisibleContentPosition).toBe(false);
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

  it("rejoins within a few pixels after scrolling down, but preserves an upward gesture", async () => {
    const onIsAtEndChange = vi.fn();
    await renderTimeline(buildProps({ onIsAtEndChange }));
    await flushAnimationFrames();
    act(() => listProps().onWheel?.({ deltaY: -8 }));
    listHarness.state.isAtEnd = false;
    listHarness.state.scroll = 1392;
    listHarness.scroller!.scrollTop = 1392;
    act(() => listProps().onScroll?.());
    await act(async () => vi.advanceTimersByTimeAsync(TIMELINE_MOMENTUM_SETTLE_MS + 1));
    await flushAnimationFrames();
    expect(listHarness.scroller!.scrollTop).toBe(1392);
    expect(listProps().maintainVisibleContentPosition).toEqual(expect.any(Object));

    act(() => listProps().onWheel?.({ deltaY: 4 }));
    listHarness.scroller!.scrollTop = 1396;
    listHarness.state.scroll = 1396;
    act(() => listProps().onScroll?.());
    await act(async () => vi.advanceTimersByTimeAsync(TIMELINE_MOMENTUM_SETTLE_MS + 1));
    await flushAnimationFrames();
    expect(onIsAtEndChange).toHaveBeenCalledWith(true);
    expect(listHarness.scroller!.scrollTop).toBe(1400);
    expect(listProps().maintainVisibleContentPosition).toBe(false);
  });

  it("does not rejoin after upward input even if shrinking content reports the exact end", async () => {
    const onManualNavigation = vi.fn();
    await renderTimeline(buildProps({ onManualNavigation }));
    await flushAnimationFrames();
    act(() => listProps().onWheel?.({ deltaY: -8 }));
    listHarness.state.isAtEnd = true;
    await act(async () => vi.advanceTimersByTimeAsync(TIMELINE_MOMENTUM_SETTLE_MS + 1));
    expect(onManualNavigation).not.toHaveBeenCalledWith(true);
    expect(listProps().maintainVisibleContentPosition).toEqual(expect.any(Object));
  });

  it("does not mistake a shrinking row during downward scrolling for upward intent", async () => {
    const onManualNavigation = vi.fn();
    await renderTimeline(buildProps({ onManualNavigation }));
    await flushAnimationFrames();
    act(() => listProps().onWheel?.({ deltaY: -120 }));
    listHarness.state.isAtEnd = false;
    listHarness.state.scroll = 1000;
    listHarness.scroller!.scrollTop = 1000;
    act(() => listProps().onScroll?.());
    act(() => listProps().onWheel?.({ deltaY: 120 }));
    onManualNavigation.mockClear();
    listHarness.state.scroll = 900;
    listHarness.scroller!.scrollTop = 900;
    act(() => listProps().onScroll?.());
    expect(onManualNavigation).not.toHaveBeenCalledWith(false);
  });

  it.each([1392, 1400])(
    "keeps a held scrollbar gesture reversible at offset %s with parent follow updates",
    async (nearEndOffset) => {
      const props = buildProps();
      await renderTimelineWithParent(props);
      await flushAnimationFrames();
      const scroller = listHarness.scroller!;
      listHarness.state.scroll = scroller.scrollTop;
      act(() =>
        listProps().onPointerDown?.({
          pointerType: "mouse",
          button: 0,
          target: scroller,
          currentTarget: scroller,
        }),
      );
      listHarness.state.isAtEnd = false;
      listHarness.state.scroll = scroller.scrollTop = 1000;
      act(() => listProps().onScroll?.());
      props.onIsAtEndChange.mockClear();

      listHarness.state.scroll = scroller.scrollTop = nearEndOffset;
      listHarness.state.isAtEnd = nearEndOffset === 1400;
      act(() => listProps().onScroll?.());
      await act(async () => vi.advanceTimersByTimeAsync(TIMELINE_MOMENTUM_SETTLE_MS + 1));
      await flushAnimationFrames();
      expect(props.onIsAtEndChange).not.toHaveBeenCalledWith(true);
      expect(scroller.scrollTop).toBe(nearEndOffset);

      listHarness.state.isAtEnd = false;
      listHarness.state.scroll = scroller.scrollTop = 1200;
      act(() => listProps().onScroll?.());
      expect(props.onManualNavigation).toHaveBeenLastCalledWith(false);
      listHarness.contentHeight = 2300;
      act(() => listProps().onItemSizeChanged?.());
      act(() => window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })));
      await act(async () => vi.advanceTimersByTimeAsync(TIMELINE_MOMENTUM_SETTLE_MS + 1));
      await flushAnimationFrames();
      expect(scroller.scrollTop).toBe(1200);
      expect(listProps().maintainVisibleContentPosition).toEqual(expect.any(Object));
    },
  );

  it("waits for touch momentum to settle before returning the parent to live follow", async () => {
    const props = buildProps();
    await renderTimelineWithParent(props);
    await flushAnimationFrames();
    const scroller = listHarness.scroller!;
    act(() => listProps().onTouchStart?.({ touches: [{ clientY: 200 }] }));
    act(() => listProps().onTouchMove?.({ touches: [{ clientY: 224 }] }));
    listHarness.state.isAtEnd = false;
    listHarness.state.scroll = scroller.scrollTop = 1000;
    act(() => listProps().onScroll?.());
    act(() => listProps().onTouchMove?.({ touches: [{ clientY: 180 }] }));
    listHarness.state.scroll = scroller.scrollTop = 1392;
    props.onIsAtEndChange.mockClear();
    act(() => listProps().onScroll?.());
    await flushAnimationFrames();
    expect(props.onIsAtEndChange).not.toHaveBeenCalledWith(true);
    expect(scroller.scrollTop).toBe(1392);

    act(() => listProps().onTouchEnd?.());
    await act(async () => vi.advanceTimersByTimeAsync(TIMELINE_MOMENTUM_SETTLE_MS - 1));
    listHarness.state.scroll = scroller.scrollTop = 1396;
    act(() => listProps().onScroll?.());
    await act(async () => vi.advanceTimersByTimeAsync(TIMELINE_MOMENTUM_SETTLE_MS - 1));
    expect(props.onIsAtEndChange).not.toHaveBeenCalledWith(true);
    listHarness.contentHeight = 2400;
    act(() => listProps().onItemSizeChanged?.());
    await act(async () => vi.advanceTimersByTimeAsync(2));
    await flushAnimationFrames();
    expect(props.onIsAtEndChange).toHaveBeenCalledWith(true);
    expect(scroller.scrollTop).toBe(1800);
    expect(listProps().maintainVisibleContentPosition).toBe(false);
  });

  it("keeps downward momentum intent through a quiet gap until native scrollend", async () => {
    listHarness.nativeScrollEnd = true;
    const props = buildProps();
    await renderTimelineWithParent(props);
    await flushAnimationFrames();
    const scroller = listHarness.scroller!;
    act(() => listProps().onTouchStart?.({ touches: [{ clientY: 200 }] }));
    act(() => listProps().onTouchMove?.({ touches: [{ clientY: 224 }] }));
    listHarness.state.isAtEnd = false;
    listHarness.state.scroll = scroller.scrollTop = 1000;
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
      listProps().onScroll?.();
    });
    act(() => listProps().onTouchMove?.({ touches: [{ clientY: 180 }] }));
    listHarness.state.scroll = scroller.scrollTop = 1300;
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
      listProps().onScroll?.();
      listProps().onTouchEnd?.();
    });
    props.onIsAtEndChange.mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(TIMELINE_MOMENTUM_SETTLE_MS + 70));
    expect(props.onIsAtEndChange).not.toHaveBeenCalledWith(true);

    // Compositor scrolling can outlive a gap in main-thread callbacks.
    listHarness.state.isAtEnd = true;
    listHarness.state.scroll = scroller.scrollTop = 1400;
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
      listProps().onScroll?.();
      scroller.dispatchEvent(new Event("scrollend"));
    });
    await flushAnimationFrames();
    expect(props.onIsAtEndChange).toHaveBeenCalledWith(true);
    expect(listProps().maintainVisibleContentPosition).toBe(false);
  });

  it.each(["touchend", "touchcancel"])(
    "settles a timeline touch when %s is retargeted outside its rows",
    async (type) => {
      const props = buildProps();
      await renderTimelineWithParent(props);
      await flushAnimationFrames();
      const scroller = listHarness.scroller!;
      act(() => listProps().onTouchStart?.({ touches: [{ clientY: 200 }] }));
      act(() => listProps().onTouchMove?.({ touches: [{ clientY: 224 }] }));
      listHarness.state.isAtEnd = false;
      listHarness.state.scroll = scroller.scrollTop = 1000;
      act(() => listProps().onScroll?.());
      act(() => listProps().onTouchMove?.({ touches: [{ clientY: 180 }] }));
      listHarness.state.isAtEnd = true;
      listHarness.state.scroll = scroller.scrollTop = 1400;
      act(() => listProps().onScroll?.());
      props.onIsAtEndChange.mockClear();
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, "touches", { value: [] });
      act(() => document.body.dispatchEvent(event));
      await act(async () => vi.advanceTimersByTimeAsync(TIMELINE_MOMENTUM_SETTLE_MS + 1));
      await flushAnimationFrames();
      expect(props.onIsAtEndChange).toHaveBeenCalledWith(true);
      expect(listProps().maintainVisibleContentPosition).toBe(false);
    },
  );

  it.each(["before release", "after release"])(
    "rejoins the physical bottom after tiny finger recoil and native end %s",
    async (nativeEndTiming) => {
      listHarness.nativeScrollEnd = true;
      const props = buildProps();
      await renderTimelineWithParent(props);
      await flushAnimationFrames();
      const scroller = listHarness.scroller!;
      act(() => listProps().onTouchStart?.({ touches: [{ clientY: 200 }] }));
      act(() => listProps().onTouchMove?.({ touches: [{ clientY: 224 }] }));
      listHarness.state.isAtEnd = false;
      listHarness.state.scroll = scroller.scrollTop = 1000;
      act(() => {
        scroller.dispatchEvent(new Event("scroll"));
        listProps().onScroll?.();
      });
      act(() => listProps().onTouchMove?.({ touches: [{ clientY: 180 }] }));
      listHarness.state.isAtEnd = true;
      listHarness.state.scroll = scroller.scrollTop = 1400;
      act(() => {
        scroller.dispatchEvent(new Event("scroll"));
        listProps().onScroll?.();
      });
      // The last finger sample can recoil without moving off the boundary.
      act(() => listProps().onTouchMove?.({ touches: [{ clientY: 181 }] }));
      props.onIsAtEndChange.mockClear();
      if (nativeEndTiming === "before release") {
        act(() => scroller.dispatchEvent(new Event("scrollend")));
        expect(props.onIsAtEndChange).not.toHaveBeenCalledWith(true);
      }
      act(() => listProps().onTouchEnd?.());
      if (nativeEndTiming === "after release") {
        act(() => scroller.dispatchEvent(new Event("scrollend")));
      }
      await act(async () => vi.advanceTimersByTimeAsync(TIMELINE_MOMENTUM_SETTLE_MS + 1));
      await flushAnimationFrames();
      expect(props.onIsAtEndChange).toHaveBeenCalledWith(true);
      expect(listProps().maintainVisibleContentPosition).toBe(false);
      expect(scroller.scrollTop).toBe(1400);
    },
  );

  it("does not reinterpret a real two-pixel upward move at native scrollend", async () => {
    listHarness.nativeScrollEnd = true;
    const props = buildProps();
    await renderTimelineWithParent(props);
    await flushAnimationFrames();
    const scroller = listHarness.scroller!;
    act(() => listProps().onTouchStart?.({ touches: [{ clientY: 200 }] }));
    act(() => listProps().onTouchMove?.({ touches: [{ clientY: 202 }] }));
    listHarness.state.isAtEnd = false;
    listHarness.state.scroll = scroller.scrollTop = 1398;
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
      listProps().onScroll?.();
      listProps().onTouchEnd?.();
    });
    props.onIsAtEndChange.mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(TIMELINE_MOMENTUM_SETTLE_MS + 70));
    act(() => scroller.dispatchEvent(new Event("scrollend")));
    await flushAnimationFrames();
    expect(props.onIsAtEndChange).not.toHaveBeenCalledWith(true);
    expect(scroller.scrollTop).toBe(1398);
    expect(listProps().maintainVisibleContentPosition).toEqual(expect.any(Object));
  });

  it("accepts native scrollend before LegendList emits its final coalesced callback", async () => {
    listHarness.nativeScrollEnd = true;
    const props = buildProps();
    await renderTimelineWithParent(props);
    await flushAnimationFrames();
    const scroller = listHarness.scroller!;
    act(() => listProps().onTouchStart?.({ touches: [{ clientY: 200 }] }));
    act(() => listProps().onTouchMove?.({ touches: [{ clientY: 224 }] }));
    listHarness.state.isAtEnd = false;
    listHarness.state.scroll = scroller.scrollTop = 1000;
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
      listProps().onScroll?.();
    });
    act(() => listProps().onTouchMove?.({ touches: [{ clientY: 180 }] }));
    act(() => listProps().onTouchEnd?.());
    scroller.scrollTop = 1400;
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
      scroller.dispatchEvent(new Event("scrollend"));
    });
    listHarness.state.scroll = 1400;
    listHarness.state.isAtEnd = true;
    act(() => listProps().onScroll?.());
    await flushAnimationFrames();
    expect(listProps().maintainVisibleContentPosition).toBe(false);
    listHarness.contentHeight = 2200;
    act(() => listProps().onItemSizeChanged?.());
    await flushAnimationFrames();
    expect(scroller.scrollTop).toBe(1600);
  });

  it("keeps a held touch reversible when scrollend arrives before contact ends", async () => {
    listHarness.nativeScrollEnd = true;
    const props = buildProps();
    await renderTimelineWithParent(props);
    await flushAnimationFrames();
    const scroller = listHarness.scroller!;
    act(() => listProps().onTouchStart?.({ touches: [{ clientY: 200 }] }));
    act(() => listProps().onTouchMove?.({ touches: [{ clientY: 224 }] }));
    listHarness.state.isAtEnd = false;
    listHarness.state.scroll = scroller.scrollTop = 1000;
    act(() => listProps().onScroll?.());
    act(() => listProps().onTouchMove?.({ touches: [{ clientY: 180 }] }));
    listHarness.state.isAtEnd = true;
    listHarness.state.scroll = scroller.scrollTop = 1400;
    props.onIsAtEndChange.mockClear();
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
      listProps().onScroll?.();
      scroller.dispatchEvent(new Event("scrollend"));
    });
    const partialRelease = new Event("touchend", { bubbles: true });
    Object.defineProperty(partialRelease, "touches", { value: [{ clientY: 180 }] });
    act(() => document.body.dispatchEvent(partialRelease));
    await act(async () => vi.advanceTimersByTimeAsync(TIMELINE_MOMENTUM_SETTLE_MS + 1));
    expect(props.onIsAtEndChange).not.toHaveBeenCalledWith(true);

    act(() => listProps().onTouchMove?.({ touches: [{ clientY: 182 }] }));
    listHarness.state.isAtEnd = false;
    listHarness.state.scroll = scroller.scrollTop = 1398;
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
      listProps().onScroll?.();
      listProps().onTouchEnd?.();
      scroller.dispatchEvent(new Event("scrollend"));
    });
    await flushAnimationFrames();
    expect(props.onIsAtEndChange).not.toHaveBeenCalledWith(true);
    expect(scroller.scrollTop).toBe(1398);
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

  it.each([false, true])(
    "rejoins after input at the clamped bottom (native scrollend: %s)",
    async (nativeScrollEnd) => {
      listHarness.nativeScrollEnd = nativeScrollEnd;
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
    },
  );

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
