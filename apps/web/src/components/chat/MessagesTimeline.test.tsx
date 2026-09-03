import { CheckpointRef, EnvironmentId, MessageId, TurnId } from "@t3tools/contracts";
import { createRef, type ReactNode, type Ref } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { LegendListRef } from "@legendapp/list/react";
import { AGENT_CONTINUE_PROMPT } from "../../agentMode";
import { RESUME_PROMPT } from "../../resumePrompt";

const assetUrlStateCalls = vi.hoisted(() => [] as Array<unknown>);
const legendListPropsCalls = vi.hoisted(() => [] as Array<unknown>);

vi.mock("@legendapp/list/react", async () => {
  const legendListTestId = "legend-list";

  const LegendList = (props: {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    renderItem: (args: { item: { id: string } }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
    className?: string;
    maintainScrollAtEnd?:
      | boolean
      | {
          animated?: boolean;
          on?: {
            dataChange?: boolean;
            itemLayout?: boolean;
            layout?: boolean;
          };
        };
    maintainVisibleContentPosition?:
      | boolean
      | {
          data?: boolean;
          size?: boolean;
          shouldRestorePosition?: (item: { id: string }) => boolean;
        };
    initialScrollAtEnd?: boolean;
    initialScrollOffset?: number;
    drawDistance?: number;
    onScroll?: () => void;
    onLoad?: () => void;
    onItemSizeChanged?: () => void;
    onWheel?: (event: { deltaY: number }) => void;
    onTouchStart?: (event: { touches: ArrayLike<{ clientY: number }> }) => void;
    onTouchMove?: (event: { touches: ArrayLike<{ clientY: number }> }) => void;
    onTouchEnd?: () => void;
    onTouchCancel?: () => void;
    onPointerDown?: (event: { pointerType: string }) => void;
    ref?: Ref<LegendListRef>;
  }) => {
    legendListPropsCalls.push(props);
    return (
      <div
        data-testid={legendListTestId}
        data-class-name={props.className}
        data-maintain-scroll-at-end={props.maintainScrollAtEnd ? "enabled" : undefined}
        data-maintain-scroll-at-end-animated={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.animated
            : undefined
        }
        data-maintain-scroll-at-end-data-change={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.on?.dataChange
            : undefined
        }
        data-maintain-scroll-at-end-item-layout={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.on?.itemLayout
            : undefined
        }
        data-maintain-scroll-at-end-layout={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.on?.layout
            : undefined
        }
        data-maintain-visible-content-position={
          typeof props.maintainVisibleContentPosition === "object"
            ? "object"
            : props.maintainVisibleContentPosition
        }
        data-maintain-visible-content-position-data={
          typeof props.maintainVisibleContentPosition === "object"
            ? props.maintainVisibleContentPosition.data
            : undefined
        }
        data-maintain-visible-content-position-size={
          typeof props.maintainVisibleContentPosition === "object"
            ? props.maintainVisibleContentPosition.size
            : undefined
        }
        data-manual-wheel-handler={Boolean(props.onWheel)}
        data-manual-touch-handler={Boolean(
          props.onTouchStart && props.onTouchMove && props.onTouchEnd && props.onTouchCancel,
        )}
        data-manual-pointer-handler={Boolean(props.onPointerDown)}
        data-initial-scroll-at-end={props.initialScrollAtEnd}
        data-initial-scroll-offset={props.initialScrollOffset}
        data-draw-distance={props.drawDistance}
        data-load-handler={Boolean(props.onLoad)}
        data-item-size-handler={Boolean(props.onItemSizeChanged)}
        data-scroll-handler={Boolean(props.onScroll)}
      >
        {props.ListHeaderComponent}
        {props.data.map((item) => (
          <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
        ))}
        {props.ListFooterComponent}
      </div>
    );
  };

  return { LegendList };
});

function MockFileDiff(props: {
  fileDiff: { name?: string | null; prevName?: string | null };
  renderCustomHeader?: (fileDiff: {
    name?: string | null;
    prevName?: string | null;
  }) => React.ReactNode;
}) {
  return (
    <div data-testid="file-diff">
      {props.renderCustomHeader?.(props.fileDiff)}
      {props.fileDiff.name ?? props.fileDiff.prevName ?? "diff"}
    </div>
  );
}

vi.mock("@pierre/diffs/react", () => {
  return { FileDiff: MockFileDiff };
});

vi.mock("../../assets/assetUrls", () => ({
  withAssetRevision: (url: string, revision: string) => `${url}?solla_revision=${revision}`,
  useAssetUrlState: (_environmentId: unknown, resource: unknown) => {
    assetUrlStateCalls.push(resource);
    return {
      _tag: "Success" as const,
      url: "https://environment.example/api/assets/signed/reference.png",
    };
  },
}));

function matchMedia() {
  return {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

let MessagesTimeline: typeof import("./MessagesTimeline").MessagesTimeline;

beforeAll(async () => {
  const classList = {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false,
  };

  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal("window", {
    matchMedia,
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList,
      offsetHeight: 0,
    },
  });

  ({ MessagesTimeline } = await import("./MessagesTimeline"));
}, 30_000);

const ACTIVE_THREAD_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const MESSAGE_CREATED_AT = "2026-03-17T19:12:28.000Z";

function buildProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnStartedAt: null,
    listRef: createRef<LegendListRef | null>(),
    latestTurn: null,
    runningTurnId: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    routeThreadKey: "environment-local:thread-1",
    onOpenTurnDiff: () => {},
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ACTIVE_THREAD_ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
    onScrollStateChange: () => {},
    onCompactAndContinue: () => {},
    isCompactAndContinueBusy: false,
    resumableAssistantMessageId: null,
    resumableRuntimeErrorActivityId: null,
    onResumeIncompleteTurn: () => {},
    isResumeIncompleteTurnBusy: false,
    isResumeIncompleteTurnDisabled: false,
  };
}

function buildLongUserMessageText(tail = "deep hidden detail only after expand") {
  return Array.from({ length: 9 }, (_, index) =>
    index === 8 ? tail : `Line ${index + 1}: ${"verbose prompt content ".repeat(8).trim()}`,
  ).join("\n");
}

function buildUserTimelineEntry(text: string) {
  return {
    id: "entry-1",
    kind: "message" as const,
    createdAt: MESSAGE_CREATED_AT,
    message: {
      id: MessageId.make("message-1"),
      role: "user" as const,
      text,
      turnId: null,
      createdAt: MESSAGE_CREATED_AT,
      updatedAt: MESSAGE_CREATED_AT,
      streaming: false,
    },
  };
}

describe("MessagesTimeline", () => {
  it("shows a persisted newest message as explicitly queued for Codex", () => {
    const entry = buildUserTimelineEntry("Please inspect the model");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[entry]}
        newestUserMessageId={entry.message.id}
        deliveryReceiptsExpected
        deliveryProviderName="Codex"
      />,
    );

    expect(markup).toContain("Queued for Codex");
  });

  it("keeps delivery state visible for a manually sent Resume message", () => {
    const entry = buildUserTimelineEntry("resume");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[entry]}
        newestUserMessageId={entry.message.id}
        deliveryReceiptsExpected
        deliveryProviderName="Codex"
      />,
    );

    expect(markup).toContain(">Resume<");
    expect(markup).toContain("Queued for Codex");
  });

  it("shows Sending while the newest message is still only a local echo", () => {
    const entry = buildUserTimelineEntry("Queued locally");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[entry]}
        newestUserMessageId={entry.message.id}
        pendingMessageIds={new Set([entry.message.id])}
        deliveryProviderName="Codex"
      />,
    );

    expect(markup).toContain("Sending…");
  });

  it("labels compaction and continuation work explicitly without fake percentages", () => {
    const compactingMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        workingStatusLabel="Compacting context"
        timelineEntries={[]}
      />,
    );
    expect(compactingMarkup).toContain("Compacting context");
    expect(compactingMarkup).not.toContain("%");

    const continuingMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        workingStatusLabel="Continuing conversation"
        timelineEntries={[]}
      />,
    );
    expect(continuingMarkup).toContain("Continuing conversation");
  });

  it("highlights only direct assistant low-context warnings as an accessible action", () => {
    const compact = vi.fn();
    const warningMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        onCompactAndContinue={compact}
        timelineEntries={[
          {
            id: "entry-low-context",
            kind: "message",
            createdAt: MESSAGE_CREATED_AT,
            message: {
              id: MessageId.make("message-low-context"),
              role: "assistant",
              text: "Context is low. I should compact before continuing.",
              turnId: null,
              createdAt: MESSAGE_CREATED_AT,
              updatedAt: MESSAGE_CREATED_AT,
              streaming: false,
            },
          },
        ]}
      />,
    );
    expect(warningMarkup).toContain('aria-label="Compact and continue conversation"');
    expect(warningMarkup).toContain(">Context is low</button>");

    const excludedMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-low-context-code",
            kind: "message",
            createdAt: MESSAGE_CREATED_AT,
            message: {
              id: MessageId.make("message-low-context-code"),
              role: "assistant",
              text: [
                "> Context is low.",
                "",
                "```text",
                "I'm running out of context",
                "```",
                "",
                'The docs say "context is low" is a warning.',
              ].join("\n"),
              turnId: null,
              createdAt: MESSAGE_CREATED_AT,
              updatedAt: MESSAGE_CREATED_AT,
              streaming: false,
            },
          },
        ]}
      />,
    );
    expect(excludedMarkup).not.toContain('aria-label="Compact and continue conversation"');

    const userMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry("I'm running out of context")]}
      />,
    );
    expect(userMarkup).not.toContain('aria-label="Compact and continue conversation"');
  });

  it("renders a wrapped terminal Agent stop token as a red status badge", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-agent-stop",
            kind: "message",
            createdAt: MESSAGE_CREATED_AT,
            message: {
              id: MessageId.make("message-agent-stop"),
              role: "assistant",
              text: 'Everything is complete. "AGENT_STOP"',
              turnId: TurnId.make("turn-agent-stop"),
              createdAt: MESSAGE_CREATED_AT,
              updatedAt: MESSAGE_CREATED_AT,
              streaming: false,
            },
          },
        ]}
      />,
    );
    expect(markup).toContain('data-agent-stop-badge="true"');
    expect(markup).toContain("Agent stop");
    expect(markup).toContain("Everything is complete.");
    expect(markup).not.toContain("AGENT_STOP");
  });

  it("still badges the stop when a stray provider footer follows the token", () => {
    // The LANChat browser bridge read ChatGPT's page footer as the reply's
    // last line, so the token stopped being terminal: the badge vanished and
    // the raw control token rendered to the user as prose (reported
    // 2026-08-16). The Agent loop had stopped on it either way.
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-agent-stop-footer",
            kind: "message",
            createdAt: MESSAGE_CREATED_AT,
            message: {
              id: MessageId.make("message-agent-stop-footer"),
              role: "assistant",
              text: "I won't invent tool results.\n\nAGENT_STOP\n\nChatGPT is AI and can make mistakes. Check important info.",
              turnId: TurnId.make("turn-agent-stop-footer"),
              createdAt: MESSAGE_CREATED_AT,
              updatedAt: MESSAGE_CREATED_AT,
              streaming: false,
            },
          },
        ]}
      />,
    );
    expect(markup).toContain('data-agent-stop-badge="true"');
    expect(markup).toContain("invent tool results.");
    expect(markup).not.toContain("AGENT_STOP");
  });

  it("renders an accessible Resume action directly under the eligible assistant message", () => {
    const assistantMessageId = MessageId.make("message-incomplete");
    const timelineEntries = [
      {
        id: "entry-incomplete",
        kind: "message" as const,
        createdAt: MESSAGE_CREATED_AT,
        message: {
          id: assistantMessageId,
          role: "assistant" as const,
          text: "I completed the first part, but",
          turnId: TurnId.make("turn-incomplete"),
          createdAt: MESSAGE_CREATED_AT,
          updatedAt: MESSAGE_CREATED_AT,
          streaming: false,
        },
      },
    ];

    const readyMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={timelineEntries}
        resumableAssistantMessageId={assistantMessageId}
      />,
    );
    expect(readyMarkup).toContain('aria-label="Resume incomplete response"');
    expect(readyMarkup).toContain(">Resume</button>");
    expect(readyMarkup.indexOf("first part")).toBeLessThan(readyMarkup.indexOf(">Resume</button>"));

    const pendingMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={timelineEntries}
        resumableAssistantMessageId={assistantMessageId}
        isResumeIncompleteTurnBusy
      />,
    );
    expect(pendingMarkup).toContain('aria-label="Resuming incomplete response"');
    expect(pendingMarkup).toContain('aria-busy="true"');
    expect(pendingMarkup).toContain("disabled");
    expect(pendingMarkup).toContain("Resuming…");

    const disconnectedMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={timelineEntries}
        resumableAssistantMessageId={assistantMessageId}
        isResumeIncompleteTurnDisabled
      />,
    );
    expect(disconnectedMarkup).toContain(
      'aria-label="Resume unavailable while the remote machine is disconnected"',
    );
    expect(disconnectedMarkup).toContain(
      'title="Reconnect the remote machine to resume this response."',
    );
    expect(disconnectedMarkup).toContain("disabled");
    expect(disconnectedMarkup).toContain(">Resume</button>");
  });

  it("does not render Resume on a non-eligible assistant message", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-complete",
            kind: "message",
            createdAt: MESSAGE_CREATED_AT,
            message: {
              id: MessageId.make("message-complete"),
              role: "assistant",
              text: "Done.",
              turnId: TurnId.make("turn-complete"),
              createdAt: MESSAGE_CREATED_AT,
              updatedAt: MESSAGE_CREATED_AT,
              streaming: false,
            },
          },
        ]}
      />,
    );
    expect(markup).not.toContain("Resume incomplete response");
  });

  it("renders a quick Resume action directly below a terminal runtime error", () => {
    const runtimeErrorActivityId = "runtime-error-activity";
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: runtimeErrorActivityId,
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: runtimeErrorActivityId,
              createdAt: MESSAGE_CREATED_AT,
              turnId: TurnId.make("turn-runtime-error"),
              label: "Runtime error",
              detail: "Provider process exited",
              tone: "error",
              sourceActivityKind: "runtime.error",
            },
          },
        ]}
        resumableRuntimeErrorActivityId={runtimeErrorActivityId}
      />,
    );

    expect(markup).toContain('data-runtime-error-resume="true"');
    expect(markup).toContain('aria-label="Resume after runtime error"');
    expect(markup).toContain("Runtime error");
    expect(markup.indexOf("Runtime error")).toBeLessThan(markup.indexOf(">Resume</button>"));
  });

  it("uses the larger leading inset only when the top fade is enabled", () => {
    const timelineEntries = [buildUserTimelineEntry("Hello")];

    const compactMarkup = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} timelineEntries={timelineEntries} />,
    );
    const fadedMarkup = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} timelineEntries={timelineEntries} topFadeEnabled />,
    );

    expect(compactMarkup).toContain('class="py-3 sm:py-4"');
    expect(compactMarkup).not.toContain("chat-timeline-scroll-fade");
    expect(fadedMarkup).toContain('class="pb-3 pt-10 sm:pt-12"');
    expect(fadedMarkup).toContain("chat-timeline-scroll-fade");
  });

  it("shows the unloaded message count without hydrating older content", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry("Recent message")]}
        hasOlderHistory
        olderHistoryMessageCount={8_627}
        onLoadOlderHistory={() => {}}
      />,
    );

    expect(markup).toContain("Load 8,627 earlier messages");
    expect(markup).not.toContain("Loading earlier history");
  });

  it("keeps assistant changed-files headers sticky below the thread header", () => {
    const assistantMessageId = MessageId.make("message-assistant-with-files");
    const turnId = TurnId.make("turn-with-files");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        latestTurn={{
          turnId,
          state: "completed",
          startedAt: MESSAGE_CREATED_AT,
          completedAt: MESSAGE_CREATED_AT,
        }}
        timelineEntries={[
          {
            id: "entry-assistant-with-files",
            kind: "message",
            createdAt: MESSAGE_CREATED_AT,
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "Updated the fixture.",
              turnId,
              createdAt: MESSAGE_CREATED_AT,
              updatedAt: MESSAGE_CREATED_AT,
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              assistantMessageId,
              {
                turnId,
                checkpointTurnCount: 1,
                checkpointRef: CheckpointRef.make("checkpoint-with-files"),
                status: "ready",
                files: [{ path: "README.md", kind: "modified", additions: 2, deletions: 1 }],
                assistantMessageId,
                completedAt: MESSAGE_CREATED_AT,
              },
            ],
          ])
        }
      />,
    );

    expect(markup).toContain("sticky top-2 z-10");
    expect(markup).not.toContain("self-start");
    expect(markup).toContain("whitespace-nowrap");
    expect(markup).toContain("!size-[22px]");
    expect(markup).toContain("size-3");
    expect(markup).toContain('aria-label="Collapse all folders"');
    expect(markup).toContain('aria-label="Open diff"');
    expect(markup).toContain("1 changed file");
  });

  it("uses LegendList isNearEnd when deciding whether the live edge is visible", async () => {
    const {
      resolveTimelineIsAtEnd,
      resolveTimelineIsExactlyAtEnd,
      resolveTimelineDrawDistance,
      resolveTimelineMinimapHasPersistentGutter,
      resolveTimelineMinimapHeightStyle,
      resolveTimelineMinimapHitStripWidth,
      resolveTimelineMinimapIndexFromPointer,
      resolveTimelineMinimapInteractiveWidth,
      resolveTimelineMinimapTopPercent,
    } = await import("./MessagesTimeline.logic");

    expect(resolveTimelineIsAtEnd({ isNearEnd: true, isAtEnd: false })).toBe(true);
    expect(resolveTimelineIsAtEnd({ isNearEnd: false, isAtEnd: true })).toBe(false);
    expect(resolveTimelineIsAtEnd({ isAtEnd: true })).toBe(true);
    expect(resolveTimelineIsAtEnd(undefined)).toBeUndefined();
    expect(resolveTimelineIsExactlyAtEnd({ isNearEnd: true, isAtEnd: false })).toBe(false);
    expect(resolveTimelineIsExactlyAtEnd({ isNearEnd: false, isAtEnd: true })).toBe(true);
    expect(resolveTimelineIsExactlyAtEnd({ isNearEnd: true })).toBe(true);
    expect(resolveTimelineDrawDistance(false)).toBe(4_000);
    expect(resolveTimelineDrawDistance(true)).toBe(6_000);

    expect(resolveTimelineMinimapHeightStyle(5)).toBe("min(32px, calc(100vh - 18rem))");
    expect(resolveTimelineMinimapTopPercent(2, 5)).toBe(50);
    expect(
      resolveTimelineMinimapIndexFromPointer({
        itemCount: 101,
        railTop: 100,
        railHeight: 500,
        pointerY: 350,
      }),
    ).toBe(50);
    expect(
      resolveTimelineMinimapIndexFromPointer({
        itemCount: 101,
        railTop: 100,
        railHeight: 500,
        pointerY: 999,
      }),
    ).toBe(100);
    expect(resolveTimelineMinimapHasPersistentGutter(832)).toBe(false);
    expect(resolveTimelineMinimapHasPersistentGutter(863)).toBe(false);
    expect(resolveTimelineMinimapHasPersistentGutter(864)).toBe(true);

    // No usable gutter (zoomed in / narrow pane): the strip must go inert
    // instead of overlaying the centered content column.
    expect(resolveTimelineMinimapHitStripWidth(768)).toBe(0);
    expect(resolveTimelineMinimapHitStripWidth(792)).toBe(0);
    // Partial gutter: strip shrinks to what fits between the viewport edge
    // and the content column.
    expect(resolveTimelineMinimapHitStripWidth(820)).toBe(14);
    // Full gutter: unchanged 40px-wide strip.
    expect(resolveTimelineMinimapHitStripWidth(872)).toBe(40);
    expect(resolveTimelineMinimapHitStripWidth(1400)).toBe(40);
    expect(resolveTimelineMinimapHitStripWidth(0)).toBe(0);
    expect(resolveTimelineMinimapHitStripWidth(Number.NaN)).toBe(0);

    // The collapsed target stays narrow, but an open preview keeps its full
    // 20rem width plus the 2rem offset from the minimap rail interactive.
    // The hit area never grows. It used to widen to 22rem while a preview was
    // open, which put a block over the conversation that swallowed clicks and
    // kept the preview open until the pointer left all of it.
    expect(resolveTimelineMinimapInteractiveWidth(0)).toBe(0);
    expect(resolveTimelineMinimapInteractiveWidth(14)).toBe(14);
    expect(resolveTimelineMinimapInteractiveWidth(40)).toBe(40);
  });

  // A thread on an offline host reports last-known state. Pulsing dots and a
  // counter that keeps climbing claim live progress the client cannot observe,
  // and the user has no way to stop a turn on a machine they cannot reach.
  it("stops claiming live progress while the host is unreachable", () => {
    const timelineEntries = [buildUserTimelineEntry("Publish the release")];
    const reachable = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} isWorking timelineEntries={timelineEntries} />,
    );
    const unreachable = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        environmentUnreachable
        timelineEntries={timelineEntries}
      />,
    );

    // The animated equalizer is what claims live progress now; the offline
    // row draws static dots instead.
    expect(reachable).toContain("working-pillars");
    expect(unreachable).not.toContain("working-pillars");
    expect(unreachable).toContain("reconnecting");
    expect(unreachable).not.toContain("Working for");
  });

  it("disables LegendList live-follow after the user opts out during streaming", () => {
    const timelineEntries = [buildUserTimelineEntry("Keep my reading position")];
    const followingMarkup = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} followEnd isWorking timelineEntries={timelineEntries} />,
    );
    const optedOutMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        followEnd={false}
        isWorking
        timelineEntries={timelineEntries}
      />,
    );

    expect(followingMarkup).toContain('data-maintain-scroll-at-end="enabled"');
    expect(optedOutMarkup).not.toContain('data-maintain-scroll-at-end="enabled"');
    expect(followingMarkup).toContain('data-maintain-visible-content-position="false"');
    expect(optedOutMarkup).toContain('data-maintain-visible-content-position="object"');
    expect(optedOutMarkup).toContain('data-maintain-visible-content-position-data="true"');
    expect(optedOutMarkup).toContain('data-maintain-visible-content-position-size="true"');
    expect(followingMarkup).toContain('data-draw-distance="4000"');
    expect(followingMarkup).toContain('data-manual-wheel-handler="true"');
    expect(followingMarkup).toContain('data-manual-touch-handler="true"');
    expect(followingMarkup).toContain('data-manual-pointer-handler="true"');
  });

  it("claims the viewport as soon as wheel or touch input moves toward older content", () => {
    legendListPropsCalls.length = 0;
    const onManualNavigation = vi.fn();
    renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        followEnd
        isWorking
        onManualNavigation={onManualNavigation}
        timelineEntries={[buildUserTimelineEntry("Do not yank this scroll back down")]}
      />,
    );

    const listProps = legendListPropsCalls.at(-1) as {
      readonly onWheel?: (event: { readonly deltaY: number }) => void;
      readonly onTouchStart?: (event: {
        readonly touches: ArrayLike<{ readonly clientY: number }>;
      }) => void;
      readonly onTouchMove?: (event: {
        readonly touches: ArrayLike<{ readonly clientY: number }>;
      }) => void;
    };

    listProps.onWheel?.({ deltaY: -24 });
    expect(onManualNavigation).toHaveBeenLastCalledWith(false);

    listProps.onTouchStart?.({ touches: [{ clientY: 200 }] });
    listProps.onTouchMove?.({ touches: [{ clientY: 220 }] });
    expect(onManualNavigation).toHaveBeenLastCalledWith(false);

    const upwardClaims = onManualNavigation.mock.calls.length;
    listProps.onWheel?.({ deltaY: 24 });
    listProps.onTouchMove?.({ touches: [{ clientY: 210 }] });
    expect(onManualNavigation).toHaveBeenCalledTimes(upwardClaims + 2);
    expect(onManualNavigation).toHaveBeenLastCalledWith(true);

    renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        followEnd={false}
        isWorking
        onManualNavigation={onManualNavigation}
        timelineEntries={[buildUserTimelineEntry("Let me return to the live edge")]}
      />,
    );
    const optedOutListProps = legendListPropsCalls.at(-1) as typeof listProps;
    optedOutListProps.onWheel?.({ deltaY: 24 });
    expect(onManualNavigation).toHaveBeenLastCalledWith(true);
    optedOutListProps.onTouchStart?.({ touches: [{ clientY: 220 }] });
    optedOutListProps.onTouchMove?.({ touches: [{ clientY: 210 }] });
    expect(onManualNavigation).toHaveBeenLastCalledWith(true);
  });

  it("restores a deep per-thread scroll offset instead of initializing at the end", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        initialScrollAtEnd={false}
        initialScrollOffset={1280}
        timelineEntries={[buildUserTimelineEntry("Restore this reading position")]}
      />,
    );

    expect(markup).toContain('data-initial-scroll-at-end="false"');
    expect(markup).toContain('data-initial-scroll-offset="1280"');
  });

  it("reconciles position after initial layout and late image measurements", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        followEnd
        timelineEntries={[buildUserTimelineEntry("Keep the live edge stable")]}
      />,
    );

    expect(markup).toContain('data-load-handler="true"');
    expect(markup).toContain('data-item-size-handler="true"');
    expect(markup).toContain('data-scroll-handler="true"');
  });

  it("does not add synthetic end space for a sent attachment message", () => {
    const firstEntry = buildUserTimelineEntry("First prompt.");
    const secondEntry = {
      ...buildUserTimelineEntry("Newest prompt."),
      id: "entry-2",
      message: {
        ...buildUserTimelineEntry("Newest prompt.").message,
        id: MessageId.make("message-2"),
        attachments: [
          {
            type: "image" as const,
            id: "attachment-1",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 1,
            previewUrl: "data:image/png;base64,iVBORw0KGgo=",
          },
        ],
      },
    };
    const markup = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} timelineEntries={[firstEntry, secondEntry]} />,
    );

    expect(markup).not.toContain("data-anchor-index=");
    expect(markup).not.toContain("data-anchor-offset=");
    expect(markup).not.toContain("data-content-inset-end=");
    expect(markup).toContain('data-chat-timeline-bottom-inset="0"');
    expect(markup).toContain("[overflow-anchor:none]");
    expect(markup).toContain('data-maintain-scroll-at-end="enabled"');
    expect(markup).toContain('data-maintain-visible-content-position="false"');
    expect(markup).toContain("aspect-video overflow-hidden");
    expect(markup).toContain("block size-full object-cover");
    expect(markup).toContain('loading="lazy"');
    expect(markup).toContain('decoding="async"');
  });

  it("renders collapse controls for long user messages", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    expect(markup).toContain("Show full message");
    expect(markup).toContain('data-maintain-scroll-at-end="enabled"');
    expect(markup).toContain('data-maintain-scroll-at-end-animated="false"');
    expect(markup).toContain('data-maintain-scroll-at-end-data-change="true"');
    expect(markup).toContain('data-maintain-scroll-at-end-item-layout="true"');
    expect(markup).toContain('data-maintain-scroll-at-end-layout="true"');
    expect(markup).toContain('data-user-message-collapsed="true"');
    expect(markup).toContain('data-user-message-fade="true"');
    expect(markup).toContain('data-user-message-footer="true"');
  });

  it("does not render collapse controls for short user messages", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry("Short prompt.")]}
      />,
    );

    expect(markup).not.toContain("Show full message");
    expect(markup).toContain('data-user-message-collapsible="false"');
    expect(markup).toContain(
      "rounded-[14px] border border-[var(--gold-line)] bg-[var(--gold-tint)]",
    );
  });

  it("collapses the synthetic Agent continuation into an inline fast-forward chip", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(AGENT_CONTINUE_PROMPT)]}
      />,
    );

    expect(markup).toContain("Agent auto-resuming");
    expect(markup).toContain("lucide-fast-forward");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("The user wants you to continue working autonomously");
  });

  it("collapses browser housekeeping into a compact browser chip", () => {
    const entry = buildUserTimelineEntry(
      "Browser tab check: 2 tabs are open. Review and clean up tabs.",
    );
    entry.message.id = MessageId.make("browser-tab-cleanup-message:thread-1:turn-1");
    const markup = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} timelineEntries={[entry]} />,
    );

    expect(markup).toContain("Browser tab cleanup");
    expect(markup).toContain("lucide-globe");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("Browser tab check: 2 tabs are open");
  });

  it.each([
    ["contextual resume prompt", RESUME_PROMPT],
    ["legacy resume prompt", "resume"],
  ])("collapses the %s into an inline fast-forward chip", (_name, prompt) => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} timelineEntries={[buildUserTimelineEntry(prompt)]} />,
    );

    expect(markup).toContain(">Resume<");
    expect(markup).toContain("lucide-fast-forward");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("Please resume your current task");
    expect(markup).not.toContain('rounded-2xl bg-accent p-3"><p>resume</p>');
  });

  it("renders inline terminal labels with the composer chip UI", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              buildLongUserMessageText("yoo what's @terminal-1:1-5 mean"),
              "",
              "<terminal_context>",
              "- Terminal 1 lines 1-5:",
              "  1 | julius@mac effect-http-ws-cli % bun i",
              "  2 | bun install v1.3.9 (cf6cdbbb)",
              "</terminal_context>",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain("Terminal 1 lines 1-5");
    expect(markup).toContain("lucide-terminal");
    expect(markup).toContain("yoo what&#x27;s</p>");
    expect(markup).toContain('<span aria-hidden="true"> </span>');
    expect(markup).toContain("Show full message");
  }, 20_000);

  it("renders chips for standalone element-pick context messages", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              "<element_context>",
              "- <SubmitButton> (Button.tsx:12):",
              "  url: https://example.com/dashboard",
              "  selector: button.submit",
              "  source: /repo/src/Button.tsx:12:5",
              "  html:",
              '  <button class="submit">Save</button>',
              "</element_context>",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain("SubmitButton");
    expect(markup).not.toContain("&lt;element_context");
    expect(markup).not.toContain("<element_context");
  });

  it("badges a message that cancelled background work, without leaking the block", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              "stop and check the build",
              "",
              "<interrupted_background_tasks>",
              "Sending this message cancelled the background tasks listed below. Restart any that are still needed.",
              "- Ran command: npm test",
              "- Searched text",
              "</interrupted_background_tasks>",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain("2 background tasks interrupted");
    expect(markup).toContain("stop and check the build");
    // The block is machinery for the agent; it must never reach the transcript.
    expect(markup).not.toContain("interrupted_background_tasks");
    expect(markup).not.toContain("Restart any that are still needed");
  });

  it("badges a Preview-only cancellation instead of showing the agent instruction", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              "<interrupted_background_tasks>",
              "The user sent this message, which deliberately cancelled the background tasks listed below. They were killed on purpose and did not fail: ignore any non-zero exit code, kill signal, or truncated output they reported, and do not investigate those as errors or draw conclusions about the machine from them. Restart any that are still needed.",
              "- Preview",
              "</interrupted_background_tasks>",
            ].join("\r\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain("1 background task interrupted");
    expect(markup).not.toContain("interrupted_background_tasks");
    expect(markup).not.toContain("killed on purpose");
  });

  it("keeps the copy button for collapsed long user messages", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    expect(markup).toContain('aria-label="Copy link"');
    expect(markup).toContain('data-user-message-collapsed="true"');
    expect(markup).toContain('data-user-message-footer="true"');
  });

  it("keeps message timestamps and copy actions visible without hover", () => {
    const userMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry("Always visible user metadata")]}
      />,
    );
    expect(userMarkup).toContain('class="flex shrink-0 items-center gap-2"');
    expect(userMarkup).not.toContain(
      'class="flex shrink-0 items-center gap-2 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100"',
    );

    const assistantMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-visible-assistant-meta",
            kind: "message",
            createdAt: MESSAGE_CREATED_AT,
            message: {
              id: MessageId.make("message-visible-assistant-meta"),
              role: "assistant",
              text: "Always visible assistant metadata",
              turnId: TurnId.make("turn-visible-assistant-meta"),
              createdAt: MESSAGE_CREATED_AT,
              updatedAt: MESSAGE_CREATED_AT,
              streaming: false,
            },
          },
        ]}
      />,
    );
    expect(assistantMarkup).toContain(
      'class="mt-1.5 flex items-center gap-2 text-xs tabular-nums"',
    );
    expect(assistantMarkup).not.toContain(
      'class="mt-1.5 flex items-center gap-2 text-xs tabular-nums opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover/assistant:opacity-100"',
    );
  });

  it("renders context compaction entries in the normal work log", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Context compacted",
              tone: "info",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Context compacted");
    expect(markup).toContain("Work Log");
  });

  it.each([
    ["active turn", true],
    ["completed turn", false],
  ] as const)("uses a file-search icon during an %s", (_state, active) => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        activeTurnInProgress={active}
        isWorking={active}
        timelineEntries={[
          {
            id: `entry-file-search-${active ? "active" : "completed"}`,
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: `work-file-search-${active ? "active" : "completed"}`,
              createdAt: MESSAGE_CREATED_AT,
              turnId: null,
              label: "Searched files",
              toolTitle: "Searched files",
              detail: "found 9 matches",
              tone: "tool",
              itemType: "web_search",
              toolLifecycleStatus: "completed",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("lucide-file-search");
    expect(markup).not.toContain("lucide-globe");
  });

  it("keeps the globe icon for genuine web search activity", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-web-search",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: "work-web-search",
              createdAt: MESSAGE_CREATED_AT,
              turnId: null,
              label: "Web search",
              toolTitle: "Web search",
              detail: "site:example.com accessibility",
              tone: "tool",
              itemType: "web_search",
              toolLifecycleStatus: "completed",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("lucide-globe");
    expect(markup).not.toContain("lucide-file-search");
  });

  it("renders model reasoning as plain inline text instead of a collapsible work row", () => {
    const thought = "Checking whether the live run cleared preflight.";
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-thought",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: "work-thought",
              createdAt: MESSAGE_CREATED_AT,
              turnId: null,
              label: "Thinking",
              detail: thought,
              tone: "thinking",
              sourceActivityKind: "reasoning.updated",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain(thought);
    expect(markup).not.toContain('aria-label="Thinking');
    expect(markup).not.toContain("lucide-chevron-down");
    // Typeset as assistant text, not as quieter chrome: same markdown
    // container, and none of the muted work-row styling it used to wear
    // (reported 2026-09-03, side by side with a provider whose reasoning
    // arrives as an ordinary assistant message).
    expect(markup).toContain("data-timeline-thought");
    const thoughtRow = markup.slice(markup.indexOf("data-timeline-thought"));
    expect(thoughtRow).not.toContain("text-muted-foreground");
  });

  it("renders Token Optimizer evidence with a hoverable lightning affordance", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-optimizer",
            kind: "work",
            createdAt: "2026-07-31T00:00:00.000Z",
            entry: {
              id: "work-optimizer",
              createdAt: "2026-07-31T00:00:00.000Z",
              label: "Optimized 2 pages · saved ~4,200 tokens",
              tone: "info",
              sourceActivityKind: "token-optimizer.applied",
              tokenOptimizer: {
                model: "claude-fable-5",
                compressedChars: 42_000,
                pageCount: 2,
                estimatedTextTokens: 10_500,
                estimatedImageTokens: 6_000,
                estimatedNativeTokens: 300,
                estimatedTokensSaved: 4_200,
                attachments: [{ id: "optimizer-page-1", name: "token-optimizer-page-1.png" }],
              },
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Optimized 2 pages · saved ~4,200 tokens");
    expect(markup).toContain('title="Optimized"');
    expect(markup).toContain('aria-label="Optimized"');
  });

  it("formats changed file paths from the workspace root", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Updated files",
              tone: "tool",
              changedFiles: ["C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts"],
            },
          },
        ]}
        workspaceRoot="C:/Users/mike/dev-stuff/t3code"
      />,
    );

    expect(markup).toContain("t3code/apps/web/src/session-logic.ts");
    expect(markup).not.toContain("C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts");
  });

  it("renders a signed inline image preview beneath an image-read tool call", () => {
    assetUrlStateCalls.length = 0;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-image-read",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: "work-image-read",
              createdAt: MESSAGE_CREATED_AT,
              label: "Read File",
              tone: "tool",
              itemType: "dynamic_tool_call",
              readImagePath: "/workspace/art/reference.png",
              readImageSourceActivityId: "activity-that-supplied-image-path",
            },
          },
        ]}
        workspaceRoot="/workspace"
      />,
    );

    expect(markup).toContain('aria-label="Open image preview: workspace/art/reference.png"');
    expect(markup).toContain("<button");
    expect(markup).toContain('href="/workspace/art/reference.png"');
    expect(markup).toContain("hover:underline");
    expect(markup).toContain(
      'src="https://environment.example/api/assets/signed/reference.png?solla_revision=work-image-read"',
    );
    expect(markup).toContain("workspace/art/reference.png");
    expect(markup).toContain("block h-48 w-full cursor-zoom-in bg-black/10 sm:h-64");
    expect(markup).toContain("block size-full object-contain");
    expect(assetUrlStateCalls.at(-1)).toMatchObject({
      sourceActivityId: "activity-that-supplied-image-path",
    });
  });

  it("renders review comment contexts as structured cards instead of raw tags", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.make("message-2"),
              role: "user",
              text: [
                '<review_comment sectionId="turn:2" sectionTitle="Turn 2" filePath="apps/web/src/lib/contextWindow.test.ts" startIndex="3" endIndex="14" rangeLabel="+47 to +58">',
                "Wadduo",
                "```diff",
                "@@ -0,0 +47,2 @@",
                '+  it("keeps valid zero-usage snapshots", () => {',
                "+    expect(snapshot).not.toBeNull();",
                "```",
                "</review_comment>",
              ].join("\n"),
              turnId: null,
              createdAt: "2026-03-17T19:12:28.000Z",
              updatedAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("contextWindow.test.ts");
    expect(markup).toContain("Wadduo");
    expect(markup).toContain('data-testid="file-diff"');
    expect(markup).not.toContain(">Review comment<");
    expect(markup).not.toContain("&lt;review_comment");
    expect(markup).not.toContain("&lt;/review_comment&gt;");
  });

  it("renders file review comments as source code instead of diffs", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.make("message-source-comment"),
              role: "user",
              text: [
                '<review_comment sectionId="file:docs/plan.md" sectionTitle="File comment" filePath="docs/plan.md" startIndex="0" endIndex="1" rangeLabel="L1 to L2">',
                "Clarify this.",
                "```md",
                "# Plan",
                "- Step one",
                "```",
                "</review_comment>",
              ].join("\n"),
              turnId: null,
              createdAt: "2026-03-17T19:12:28.000Z",
              updatedAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("plan.md");
    expect(markup).toContain("Clarify this.");
    expect(markup).toContain("# Plan");
    expect(markup).not.toContain('data-testid="file-diff"');
  });

  it("renders a failure marker for failed tool lifecycle entries", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Glob",
              tone: "tool",
              toolLifecycleStatus: "failed",
              detail: "No files found",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("lucide-x");
    expect(markup).toContain('aria-label="Tool call failed"');
  });
});
