import {
  EventId,
  isOrchestratorThreadId,
  type EnvironmentId,
  type MessageId,
  type ScopedThreadRef,
  type ServerProviderSkill,
  type TurnId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  describeInterruptedTasks,
  extractTrailingInterruptedTasksNotice,
} from "../../lib/interruptedTasksNotice";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  createContext,
  Fragment,
  memo,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { flushSync } from "react-dom";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { FileDiff } from "@pierre/diffs/react";
import { isAgentContinuePrompt } from "../../agentMode";
import { extractAgentStopSignoff } from "@t3tools/shared/agentMode";
import { isResumePrompt } from "../../resumePrompt";
import { parseSettingsUpdatePrompt } from "@t3tools/shared/settingsPrompt";
import { isBrowserTabCleanupMessageId } from "@t3tools/shared/browserTabCleanup";
import {
  deriveTimelineEntries,
  workEntryIndicatesToolFailure,
  workEntryIndicatesToolNeutralStatus,
  workEntryIndicatesToolSuccess,
  workLogEntryIsToolLike,
} from "../../session-logic";
import { type TurnDiffSummary } from "../../types";
import {
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../../lib/diffRendering";
import ChatMarkdown from "../ChatMarkdown";
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  EyeIcon,
  FastForwardIcon,
  FileSearchIcon,
  GlobeIcon,
  HammerIcon,
  LoaderCircleIcon,
  MessageCircleIcon,
  MousePointerClickIcon,
  OctagonXIcon,
  PaintbrushIcon,
  CircleStopIcon,
  MinusIcon,
  MouseIcon,
  SlidersHorizontalIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  WrenchIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import {
  previewComputerControlAction,
  previewComputerControlHeading,
} from "@t3tools/shared/previewComputerControl";
import { Button } from "../ui/button";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { ChangedFilesCard } from "./ChangedFilesTree";
import { shouldAutoExpandChangedFiles } from "./changedFilesPresentation";
import { MessageCopyButton } from "./MessageCopyButton";
import {
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  resolveTimelineDrawDistance,
  resolveTimelineIsAtEnd,
  resolveTimelineIsExactlyAtEnd,
  shouldMaintainTimelineScrollAtEnd,
  resolveTimelineMinimapHasPersistentGutter,
  resolveTimelineMinimapHeightStyle,
  resolveTimelineMinimapHitStripWidth,
  resolveTimelineMinimapIndexFromPointer,
  resolveTimelineMinimapInteractiveWidth,
  resolveTimelineMinimapTopPercent,
  type StableMessagesTimelineRowsState,
  type MessagesTimelineRow,
  TIMELINE_MINIMAP_MIN_ITEMS,
  type TimelineLatestTurn,
} from "./MessagesTimeline.logic";
import {
  shouldCommitTimelineOlderNavigation,
  shouldMaintainTimelineVisibleContentPosition,
  shouldClearOlderNavigationIntent,
  resolveTimelineKeyboardScrollDirection,
  resolveTimelineManualScrollDirection,
  shouldReleaseTimelineLiveFollowForTouch,
  shouldSnapTimelineToEndOnResize,
  TIMELINE_MOMENTUM_SETTLE_MS,
  shouldReleaseTimelineLiveFollowForWheel,
} from "./timelineScrollAnchoring";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  type MessageDeliveryState,
  messageDeliveryLabel,
  messageDeliveryState,
  shouldShowDeliveryIndicator,
  threadReportsDelivery,
} from "../../messageDelivery";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import {
  extractTrailingElementContexts,
  type ParsedElementContextEntry,
} from "~/lib/elementContext";
import {
  extractTrailingPreviewAnnotation,
  type ParsedPreviewAnnotation,
} from "~/lib/previewAnnotation";
import { cn } from "~/lib/utils";
import { useUiStateStore } from "~/uiStateStore";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { formatChatTimestampTooltip, formatShortTimestamp } from "../../timestampFormat";
import { useAssetUrlState, withAssetRevision } from "../../assets/assetUrls";
import { useOpenInPreferredEditor } from "../../editorPreferences";
import { readLocalApi } from "../../localApi";
import { serverEnvironment } from "../../state/server";
import { useEnvironment } from "../../state/environments";
import { useRightPanelStore } from "../../rightPanelStore";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { revealInFileExplorerLabel } from "../preview/fileExplorerLabel";
import { resolveLinkedFileAbsolutePath } from "./linkedFileBehavior";

import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "./userMessageTerminalContexts";
import { SkillInlineText } from "./SkillInlineText";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import {
  buildReviewCommentRenderablePatch,
  formatReviewCommentFence,
  parseReviewCommentMessageSegments,
  type ReviewCommentContext,
} from "../../reviewCommentContext";

// ---------------------------------------------------------------------------
// Context — shared state consumed by every row component via Context.
// Propagates through LegendList's memo boundaries for shared callbacks and
// non-row-scoped state. `nowIso` is intentionally excluded — self-ticking
// components (WorkingTimer, LiveElapsed) handle it.
// ---------------------------------------------------------------------------

interface TimelineRowSharedState {
  timestampFormat: TimestampFormat;
  routeThreadKey: string;
  threadRef: ScopedThreadRef | null;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  workspaceRoot: string | undefined;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  /** Message ids the provider has confirmed pulling into its agent loop. */
  deliveredMessageIds: ReadonlySet<string>;
  /** Only this message shows an unconfirmed indicator; see shouldShowDeliveryIndicator. */
  newestUserMessageId: MessageId | null;
  /** Optimistic rows the server has not echoed back yet. */
  pendingMessageIds: ReadonlySet<string>;
  /** Provider expected to consume the newest queued user message. */
  deliveryProviderName: string;
  /** Whether the selected provider emits explicit consumption receipts. */
  deliveryReceiptsExpected: boolean;
  activeThreadEnvironmentId: EnvironmentId;
  onRevertUserMessage: (messageId: MessageId) => void;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onToggleTurnFold: (turnId: TurnId) => void;
  onToggleWorkGroup: (groupId: string, anchorElement?: HTMLElement) => void;
  onCompactAndContinue: () => void;
  isCompactAndContinueBusy: boolean;
  resumableAssistantMessageId: MessageId | null;
  resumableRuntimeErrorActivityId: string | null;
  onResumeIncompleteTurn: () => void;
  isResumeIncompleteTurnBusy: boolean;
  isResumeIncompleteTurnDisabled: boolean;
}

interface TimelineRowActivityState {
  isWorking: boolean;
  workingStatusLabel: string | null;
  environmentUnreachable: boolean;
  isRevertingCheckpoint: boolean;
  activeTurnInProgress: boolean;
  latestTurnId: TurnId | null;
}

const TimelineRowCtx = createContext<TimelineRowSharedState>(null!);
const TimelineRowActivityCtx = createContext<TimelineRowActivityState>(null!);
const TIMELINE_LIST_FOOTER = <div className="h-3 sm:h-4" />;
const EMPTY_TIMELINE_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];
// Stable identity: a fresh Set here would rebuild the row context every render.
const EMPTY_DELIVERED_MESSAGE_IDS: ReadonlySet<string> = new Set<string>();

// ---------------------------------------------------------------------------
// Props (public API)
// ---------------------------------------------------------------------------

interface MessagesTimelineProps {
  isWorking: boolean;
  /** Auto-resume gap: latest turn settled but the server will start a continuation turn. */
  pendingContinuation?: boolean;
  workingStatusLabel?: string | null;
  /**
   * The environment hosting this thread is offline or reconnecting, so its
   * state is last-known rather than live.
   */
  environmentUnreachable?: boolean;
  activeTurnInProgress: boolean;
  activeTurnStartedAt: string | null;
  listRef: React.RefObject<LegendListRef | null>;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  latestTurn: TimelineLatestTurn | null;
  runningTurnId: TurnId | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  routeThreadKey: string;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  activeThreadEnvironmentId: EnvironmentId;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  deliveredMessageIds?: ReadonlySet<string>;
  newestUserMessageId?: MessageId | null;
  pendingMessageIds?: ReadonlySet<string>;
  deliveryProviderName?: string;
  deliveryReceiptsExpected?: boolean;
  followEnd?: boolean;
  initialScrollAtEnd?: boolean;
  initialScrollOffset?: number | null;
  onIsAtEndChange: (isAtEnd: boolean) => void;
  onManualNavigation: (towardEnd?: boolean) => void;
  onScrollStateChange: (state: {
    readonly scrollOffset: number;
    readonly isAtEnd: boolean | undefined;
  }) => void;
  hideEmptyPlaceholder?: boolean;
  topFadeEnabled?: boolean;
  onCompactAndContinue: () => void;
  isCompactAndContinueBusy: boolean;
  resumableAssistantMessageId: MessageId | null;
  resumableRuntimeErrorActivityId: string | null;
  onResumeIncompleteTurn: () => void;
  isResumeIncompleteTurnBusy: boolean;
  isResumeIncompleteTurnDisabled: boolean;
  inlineNotice?: { readonly id: string; readonly content: ReactNode } | null;
  hasOlderHistory?: boolean;
  olderHistoryMessageCount?: number;
  olderHistoryLoading?: boolean;
  onLoadOlderHistory?: () => void;
}

// ---------------------------------------------------------------------------
// MessagesTimeline — list owner
// ---------------------------------------------------------------------------

export const MessagesTimeline = memo(function MessagesTimeline({
  isWorking,
  pendingContinuation = false,
  workingStatusLabel = null,
  environmentUnreachable = false,
  activeTurnInProgress,
  activeTurnStartedAt,
  listRef,
  timelineEntries,
  latestTurn,
  runningTurnId,
  turnDiffSummaryByAssistantMessageId,
  routeThreadKey,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  isRevertingCheckpoint,
  onImageExpand,
  activeThreadEnvironmentId,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
  skills = EMPTY_TIMELINE_SKILLS,
  deliveredMessageIds = EMPTY_DELIVERED_MESSAGE_IDS,
  newestUserMessageId = null,
  pendingMessageIds = EMPTY_DELIVERED_MESSAGE_IDS,
  deliveryProviderName = "provider CLI",
  deliveryReceiptsExpected = false,
  followEnd = true,
  initialScrollAtEnd = true,
  initialScrollOffset = null,
  onIsAtEndChange,
  onManualNavigation,
  onScrollStateChange,
  hideEmptyPlaceholder = false,
  topFadeEnabled = false,
  onCompactAndContinue,
  isCompactAndContinueBusy,
  resumableAssistantMessageId,
  resumableRuntimeErrorActivityId,
  onResumeIncompleteTurn,
  isResumeIncompleteTurnBusy,
  isResumeIncompleteTurnDisabled,
  inlineNotice = null,
  hasOlderHistory = false,
  olderHistoryMessageCount = 0,
  olderHistoryLoading = false,
  onLoadOlderHistory,
}: MessagesTimelineProps) {
  const drawDistance = resolveTimelineDrawDistance(
    typeof window !== "undefined" && window.desktopBridge !== undefined,
  );
  const [expandedTurnIds, setExpandedTurnIds] = useState<ReadonlySet<TurnId>>(new Set());
  const [expandedWorkGroupIds, setExpandedWorkGroupIds] = useState<ReadonlySet<string>>(new Set());
  const [minimapStripMap] = useState(() => new Map<string, HTMLSpanElement>());

  const onToggleTurnFold = useCallback((turnId: TurnId) => {
    setExpandedTurnIds((existing) => {
      const next = new Set(existing);
      if (next.has(turnId)) {
        next.delete(turnId);
      } else {
        next.add(turnId);
      }
      return next;
    });
  }, []);
  const onToggleWorkGroup = useCallback(
    (groupId: string, anchorElement?: HTMLElement) => {
      const anchorBottomBeforeToggle = anchorElement?.getBoundingClientRect().bottom ?? null;

      flushSync(() => {
        setExpandedWorkGroupIds((existing) => {
          const next = new Set(existing);
          if (next.has(groupId)) {
            next.delete(groupId);
          } else {
            next.add(groupId);
          }
          return next;
        });
      });

      if (anchorBottomBeforeToggle === null || !anchorElement) {
        return;
      }

      const delta = anchorElement.getBoundingClientRect().bottom - anchorBottomBeforeToggle;
      if (Math.abs(delta) < 0.5) {
        return;
      }

      const list = listRef.current;
      const currentScroll = list?.getState?.().scroll;
      if (list && typeof currentScroll === "number") {
        list.scrollToOffset({ offset: currentScroll + delta, animated: false });
      }
    },
    [listRef],
  );

  // An in-session interrupt leaves its turn expanded so the user keeps their
  // place; the next turn (or a reload, since this is local state) folds it.
  const previousLatestTurnRef = useRef(latestTurn);
  useEffect(() => {
    const previous = previousLatestTurnRef.current;
    previousLatestTurnRef.current = latestTurn;
    if (!latestTurn || previous?.turnId === undefined) {
      return;
    }
    if (latestTurn.turnId === previous.turnId) {
      if (previous.state === "running" && latestTurn.state === "interrupted") {
        setExpandedTurnIds((existing) => {
          const next = new Set(existing);
          next.add(latestTurn.turnId);
          return next;
        });
      }
      return;
    }
    setExpandedTurnIds((existing) => {
      if (!existing.has(previous.turnId)) {
        return existing;
      }
      const next = new Set(existing);
      next.delete(previous.turnId);
      return next;
    });
  }, [latestTurn]);

  // The orchestrator's single permanent thread is the only one that holds many
  // separate conversations; everywhere else a thread *is* the conversation.
  const isOrchestratorTimeline = useMemo(() => {
    const parsed = parseScopedThreadKey(routeThreadKey);
    return parsed !== null && isOrchestratorThreadId(parsed.threadId);
  }, [routeThreadKey]);

  const rawRows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries,
        latestTurn,
        runningTurnId,
        expandedTurnIds,
        expandedWorkGroupIds,
        isWorking,
        pendingContinuation,
        activeTurnStartedAt,
        turnDiffSummaryByAssistantMessageId,
        revertTurnCountByUserMessageId,
        showConversationBoundaries: isOrchestratorTimeline,
      }),
    [
      timelineEntries,
      latestTurn,
      runningTurnId,
      expandedTurnIds,
      expandedWorkGroupIds,
      isWorking,
      pendingContinuation,
      workingStatusLabel,
      activeTurnStartedAt,
      turnDiffSummaryByAssistantMessageId,
      revertTurnCountByUserMessageId,
      isOrchestratorTimeline,
    ],
  );
  const rows = useStableRows(rawRows);
  const minimapItems = useMemo(() => deriveTimelineMinimapItems(rows), [rows]);
  const [timelineViewportElement, setTimelineViewportElement] = useState<HTMLDivElement | null>(
    null,
  );
  const [minimapHasPersistentGutter, setMinimapHasPersistentGutter] = useState(false);
  const [minimapHitStripWidth, setMinimapHitStripWidth] = useState(0);
  const mountedListRef = useRef<LegendListRef | null>(null);
  const attachListRef = useCallback(
    (nextList: LegendListRef | null) => {
      const previousList = mountedListRef.current;
      mountedListRef.current = nextList;
      if (nextList !== null || listRef.current === previousList) {
        listRef.current = nextList;
      }
    },
    [listRef],
  );
  const olderNavigationIntentRef = useRef(false);
  const [manualFollowSuppressed, setManualFollowSuppressed] = useState(false);
  // This ref flips in the input event itself. The state copy rerenders
  // LegendList with maintainScrollAtEnd disabled; the ref also fences any
  // already-scheduled resize reconciliation before that render commits.
  const manualFollowSuppressedRef = useRef(false);
  const followEndRef = useRef(followEnd);
  followEndRef.current = followEnd;
  const previousScrollOffsetRef = useRef<number | null>(null);
  // Touch and pointer contact are kept separate from the momentum timer so a
  // stationary finger or held scrollbar thumb cannot settle early.
  const touchActiveRef = useRef(false);
  const pointerActiveRef = useRef(false);
  /** Pending timer that ends the gesture once momentum scrolling stops. */
  const momentumTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const positionReconcileFramesRef = useRef<{
    first: number | null;
    second: number | null;
    restoreSavedOffset: boolean | null;
  }>({ first: null, second: null, restoreSavedOffset: null });
  const pendingPositionReconcileRef = useRef<boolean | null>(null);
  const flushDeferredPositionReconcileRef = useRef<() => void>(() => {});
  const deferPositionReconcile = useCallback((restoreSavedOffset: boolean) => {
    pendingPositionReconcileRef.current =
      pendingPositionReconcileRef.current === true || restoreSavedOffset;
  }, []);
  const cancelPositionReconcile = useCallback(
    (preserve = false) => {
      const frames = positionReconcileFramesRef.current;
      if (preserve && frames.restoreSavedOffset !== null) {
        deferPositionReconcile(frames.restoreSavedOffset);
      }
      if (frames.first !== null) cancelAnimationFrame(frames.first);
      if (frames.second !== null) cancelAnimationFrame(frames.second);
      frames.first = null;
      frames.second = null;
      frames.restoreSavedOffset = null;
    },
    [deferPositionReconcile],
  );
  const clearManualFollowSuppression = useCallback(() => {
    manualFollowSuppressedRef.current = false;
    olderNavigationIntentRef.current = false;
    setManualFollowSuppressed(false);
  }, []);
  const claimManualNavigation = useCallback(
    (towardEnd: boolean) => {
      // A resize/item-measure reconcile may already be between animation
      // frames. Preserve it for after the gesture instead of letting it race
      // the input or silently losing it.
      cancelPositionReconcile(true);
      if (!towardEnd && !manualFollowSuppressedRef.current) {
        olderNavigationIntentRef.current = true;
        manualFollowSuppressedRef.current = true;
        // LegendList owns its own data/layout handlers. Commit the prop that
        // disables those handlers in this input task, before a streamed row
        // can arrive and snap the viewport back to the live edge.
        flushSync(() => setManualFollowSuppressed(true));
      }
      onManualNavigation(towardEnd);
    },
    [cancelPositionReconcile, onManualNavigation],
  );
  const userGestureActive = useCallback(
    () => touchActiveRef.current || pointerActiveRef.current || momentumTimerRef.current !== null,
    [],
  );
  // Lifting a finger or scrollbar thumb does not necessarily end movement:
  // iOS momentum and middle-button autoscroll continue producing scroll events.
  // Only settle after the events themselves go quiet.
  const endGestureWhenMomentumSettles = useCallback(() => {
    if (momentumTimerRef.current !== null) globalThis.clearTimeout(momentumTimerRef.current);
    momentumTimerRef.current = globalThis.setTimeout(() => {
      momentumTimerRef.current = null;
      const state = mountedListRef.current?.getState?.();
      if (
        resolveTimelineIsExactlyAtEnd(state) === true &&
        (manualFollowSuppressedRef.current || !followEndRef.current)
      ) {
        clearManualFollowSuppression();
        onManualNavigation(true);
        onIsAtEndChange(true);
      }
      flushDeferredPositionReconcileRef.current();
    }, TIMELINE_MOMENTUM_SETTLE_MS);
  }, [clearManualFollowSuppression, onIsAtEndChange, onManualNavigation]);
  const handleScroll = useCallback(() => {
    // Still gliding: push the settle deadline out so the gesture stays open
    // for as long as the list is actually moving.
    if (momentumTimerRef.current !== null) {
      endGestureWhenMomentumSettles();
    }
    const state = mountedListRef.current?.getState?.();
    if (!state) {
      return;
    }

    const isAtEnd = resolveTimelineIsAtEnd(state);
    const isExactlyAtEnd = resolveTimelineIsExactlyAtEnd(state);
    const scrollTop = state.scroll ?? 0;
    const scrollDirection = resolveTimelineManualScrollDirection(
      previousScrollOffsetRef.current,
      scrollTop,
    );
    if (Number.isFinite(scrollTop)) {
      previousScrollOffsetRef.current = scrollTop;
    }

    // Offset direction catches the later scroll events from keyboard,
    // scrollbar, and middle-button paths. It is deliberately gated by an
    // input token: LegendList and layout changes also move this offset, and
    // those programmatic movements must never steal viewport ownership.
    const hasUserGesture = userGestureActive();
    if (hasUserGesture && scrollDirection === "older" && isExactlyAtEnd !== true) {
      claimManualNavigation(false);
    } else if (
      hasUserGesture &&
      scrollDirection === "newer" &&
      (manualFollowSuppressedRef.current || !followEndRef.current)
    ) {
      claimManualNavigation(true);
      if (isExactlyAtEnd === true) {
        clearManualFollowSuppression();
      }
    }

    if (isAtEnd !== undefined) {
      if (
        shouldCommitTimelineOlderNavigation({
          olderNavigationIntent: olderNavigationIntentRef.current,
          isAtEnd,
        }) &&
        !manualFollowSuppressedRef.current
      ) {
        claimManualNavigation(false);
      } else if (
        shouldClearOlderNavigationIntent({
          isAtEnd: isExactlyAtEnd,
          userGestureActive: userGestureActive(),
          manualFollowSuppressed: manualFollowSuppressedRef.current,
        })
      ) {
        olderNavigationIntentRef.current = false;
      }
      onIsAtEndChange(isAtEnd);
    }

    if (Number.isFinite(scrollTop)) {
      onScrollStateChange({
        scrollOffset: Math.max(0, scrollTop),
        isAtEnd,
      });
    }
    if (hasOlderHistory && !olderHistoryLoading && scrollTop <= 600) {
      onLoadOlderHistory?.();
    }
    if (minimapItems.length === 0) {
      return;
    }

    const scrollBottom = scrollTop + (state.scrollLength ?? 0);

    for (const item of minimapItems) {
      const strip = minimapStripMap.get(item.id);
      if (!strip) {
        continue;
      }

      const rowTop = resolveTimelineRowTop(state, item.rowIndex);
      const rowHeight = resolveTimelineRowHeight(state, item.rowIndex);
      const inView =
        rowTop !== null &&
        rowTop < scrollBottom &&
        rowTop + Math.max(1, rowHeight ?? 1) > scrollTop;

      strip.dataset.inView = inView ? "true" : "false";
    }
  }, [
    claimManualNavigation,
    clearManualFollowSuppression,
    endGestureWhenMomentumSettles,
    minimapItems,
    minimapStripMap,
    hasOlderHistory,
    olderHistoryLoading,
    onLoadOlderHistory,
    onIsAtEndChange,
    onScrollStateChange,
    userGestureActive,
  ]);
  const listHeader = useMemo(
    () => (
      <div className={topFadeEnabled ? "pb-3 pt-10 sm:pt-12" : "py-3 sm:py-4"}>
        {hasOlderHistory ? (
          <button
            type="button"
            className="mx-auto flex min-h-9 items-center gap-2 rounded-full border border-border/60 bg-card px-3 py-1.5 text-muted-foreground text-xs shadow-sm transition-colors hover:border-border hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            disabled={olderHistoryLoading}
            onClick={onLoadOlderHistory}
            onFocus={onLoadOlderHistory}
            onPointerEnter={onLoadOlderHistory}
          >
            {olderHistoryLoading ? (
              <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin" />
            ) : (
              <FastForwardIcon aria-hidden className="size-3.5 rotate-180" />
            )}
            {olderHistoryLoading
              ? "Loading earlier history…"
              : olderHistoryMessageCount > 0
                ? `Load ${olderHistoryMessageCount.toLocaleString()} earlier messages`
                : "Load earlier history"}
          </button>
        ) : null}
      </div>
    ),
    [
      hasOlderHistory,
      olderHistoryLoading,
      olderHistoryMessageCount,
      onLoadOlderHistory,
      topFadeEnabled,
    ],
  );
  const schedulePositionReconcile = useCallback(
    (restoreSavedOffset: boolean) => {
      const nextRestoreSavedOffset =
        restoreSavedOffset ||
        positionReconcileFramesRef.current.restoreSavedOffset === true ||
        pendingPositionReconcileRef.current === true;
      cancelPositionReconcile();
      pendingPositionReconcileRef.current = null;
      positionReconcileFramesRef.current.restoreSavedOffset = nextRestoreSavedOffset;
      positionReconcileFramesRef.current.first = requestAnimationFrame(() => {
        positionReconcileFramesRef.current.first = null;
        positionReconcileFramesRef.current.second = requestAnimationFrame(() => {
          positionReconcileFramesRef.current.second = null;
          const frames = positionReconcileFramesRef.current;
          frames.restoreSavedOffset = null;
          const list = mountedListRef.current;
          if (!list) return;
          if (userGestureActive()) {
            deferPositionReconcile(nextRestoreSavedOffset);
            return;
          }
          if (
            shouldSnapTimelineToEndOnResize({
              followEnd: followEndRef.current,
              userGestureActive: userGestureActive(),
              olderNavigationIntent: olderNavigationIntentRef.current,
              manualFollowSuppressed: manualFollowSuppressedRef.current,
            })
          ) {
            void list.scrollToEnd({ animated: false }).then(handleScroll);
            return;
          }
          if (
            nextRestoreSavedOffset &&
            initialScrollOffset !== null &&
            !manualFollowSuppressedRef.current
          ) {
            void list
              .scrollToOffset({
                offset: Math.max(0, initialScrollOffset),
                animated: false,
              })
              .then(handleScroll);
            return;
          }
          handleScroll();
        });
      });
    },
    [
      cancelPositionReconcile,
      deferPositionReconcile,
      handleScroll,
      initialScrollOffset,
      userGestureActive,
    ],
  );
  flushDeferredPositionReconcileRef.current = () => {
    const restoreSavedOffset = pendingPositionReconcileRef.current;
    if (restoreSavedOffset === null) return;
    pendingPositionReconcileRef.current = null;
    schedulePositionReconcile(restoreSavedOffset);
  };
  const handleTimelineLoad = useCallback(() => {
    schedulePositionReconcile(true);
  }, [schedulePositionReconcile]);
  const handleTimelineItemSizeChanged = useCallback(() => {
    // First-time image measurements are not covered by LegendList's own
    // maintainScrollAtEnd correction. Reconcile after the measurement settles
    // so live-follow remains at the end and free-scrolling retains its anchor.
    schedulePositionReconcile(false);
  }, [schedulePositionReconcile]);
  useEffect(
    () => () => {
      pendingPositionReconcileRef.current = null;
      cancelPositionReconcile();
    },
    [cancelPositionReconcile],
  );
  const previousTouchYRef = useRef<number | null>(null);
  const pointerInsideTimelineRef = useRef(false);
  const handleWheelNavigation = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      if (Number.isFinite(event.deltaY) && event.deltaY !== 0) {
        endGestureWhenMomentumSettles();
      }
      if (shouldReleaseTimelineLiveFollowForWheel(event.deltaY)) {
        // Claim the viewport at input time, before LegendList's first scroll
        // event. A streamed row can otherwise arrive in that gap and its
        // maintainScrollAtEnd correction wins the race back to the bottom.
        claimManualNavigation(false);
        return;
      }
      if (
        (manualFollowSuppressedRef.current || !followEndRef.current) &&
        Number.isFinite(event.deltaY) &&
        event.deltaY > 0
      ) {
        claimManualNavigation(true);
      }
    },
    [claimManualNavigation, endGestureWhenMomentumSettles],
  );
  const handleTouchStart = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    if (momentumTimerRef.current !== null) {
      globalThis.clearTimeout(momentumTimerRef.current);
      momentumTimerRef.current = null;
    }
    touchActiveRef.current = true;
    previousTouchYRef.current = event.touches[0]?.clientY ?? null;
  }, []);
  const handleTouchMove = useCallback(
    (event: ReactTouchEvent<HTMLDivElement>) => {
      const currentTouchY = event.touches[0]?.clientY ?? null;
      const previousTouchY = previousTouchYRef.current;
      previousTouchYRef.current = currentTouchY;
      if (shouldReleaseTimelineLiveFollowForTouch(previousTouchY, currentTouchY)) {
        claimManualNavigation(false);
        return;
      }
      if (
        previousTouchY !== null &&
        currentTouchY !== null &&
        Number.isFinite(previousTouchY) &&
        Number.isFinite(currentTouchY) &&
        currentTouchY < previousTouchY &&
        (manualFollowSuppressedRef.current || !followEndRef.current)
      ) {
        claimManualNavigation(true);
      }
    },
    [claimManualNavigation],
  );
  const handleTouchEnd = useCallback(() => {
    touchActiveRef.current = false;
    previousTouchYRef.current = null;
    endGestureWhenMomentumSettles();
  }, [endGestureWhenMomentumSettles]);
  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    // Touch has its own higher-fidelity direction tracking. For a mouse, only
    // the native scrollbar surface or middle-button autoscroll should mint a
    // scroll-intent token; an ordinary click inside a message is not a scroll.
    if (
      event.pointerType === "mouse" &&
      (event.button === 1 || event.target === event.currentTarget)
    ) {
      // Scrollbar and middle-button paths do not expose a direction until the
      // native scroll event. Snapshot the pre-gesture position here so that
      // first event can be classified even immediately after a route reset.
      const scrollTop = mountedListRef.current?.getState?.().scroll;
      previousScrollOffsetRef.current =
        typeof scrollTop === "number" && Number.isFinite(scrollTop) ? scrollTop : null;
      pointerActiveRef.current = true;
    }
  }, []);
  const handlePointerEnd = useCallback(() => {
    if (!pointerActiveRef.current) return;
    pointerActiveRef.current = false;
    endGestureWhenMomentumSettles();
  }, [endGestureWhenMomentumSettles]);
  useEffect(() => {
    window.addEventListener("pointerup", handlePointerEnd, true);
    window.addEventListener("pointercancel", handlePointerEnd, true);
    return () => {
      window.removeEventListener("pointerup", handlePointerEnd, true);
      window.removeEventListener("pointercancel", handlePointerEnd, true);
    };
  }, [handlePointerEnd]);
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          "input, textarea, select, button, a[href], [contenteditable='true'], [role='dialog']",
        )
      ) {
        return;
      }
      const targetBelongsToTimeline =
        target instanceof Node && timelineViewportElement?.contains(target);
      // A body/document/window target has no more specific keyboard owner, so
      // hover may select the timeline. An explicit external target always wins
      // over hover (for example, another focusable scroll surface).
      const targetAllowsHoverFallback =
        target === window ||
        target === document ||
        target === document.body ||
        target === document.documentElement;
      const keyboardBelongsToTimeline =
        targetBelongsToTimeline || (targetAllowsHoverFallback && pointerInsideTimelineRef.current);
      if (!keyboardBelongsToTimeline) return;
      const direction = resolveTimelineKeyboardScrollDirection({
        key: event.key,
        shiftKey: event.shiftKey,
      });
      if (direction === null) return;
      endGestureWhenMomentumSettles();
      if (direction === "older") {
        claimManualNavigation(false);
      } else if (manualFollowSuppressedRef.current || !followEndRef.current) {
        claimManualNavigation(true);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [claimManualNavigation, endGestureWhenMomentumSettles, timelineViewportElement]);
  const previousRouteThreadKeyRef = useRef(routeThreadKey);
  const previousFollowEndRef = useRef(followEnd);
  useEffect(() => {
    const routeChanged = previousRouteThreadKeyRef.current !== routeThreadKey;
    const explicitlyReturnedToEnd = !previousFollowEndRef.current && followEnd;
    previousRouteThreadKeyRef.current = routeThreadKey;
    previousFollowEndRef.current = followEnd;
    if (routeChanged || explicitlyReturnedToEnd) {
      pendingPositionReconcileRef.current = null;
      cancelPositionReconcile();
      if (routeChanged && momentumTimerRef.current !== null) {
        globalThis.clearTimeout(momentumTimerRef.current);
        momentumTimerRef.current = null;
      }
      touchActiveRef.current = false;
      pointerActiveRef.current = false;
      clearManualFollowSuppression();
      previousScrollOffsetRef.current = null;
    }
  }, [cancelPositionReconcile, clearManualFollowSuppression, followEnd, routeThreadKey]);
  useEffect(
    () => () => {
      if (momentumTimerRef.current !== null) globalThis.clearTimeout(momentumTimerRef.current);
      touchActiveRef.current = false;
      pointerActiveRef.current = false;
    },
    [],
  );

  useEffect(() => {
    const frame = requestAnimationFrame(handleScroll);
    return () => cancelAnimationFrame(frame);
  }, [handleScroll, rows.length]);

  useEffect(() => {
    if (!timelineViewportElement) {
      return;
    }

    const measure = () => {
      const viewportWidth = timelineViewportElement.getBoundingClientRect().width;
      const nextHasPersistentGutter = resolveTimelineMinimapHasPersistentGutter(viewportWidth);
      setMinimapHasPersistentGutter((current) =>
        current === nextHasPersistentGutter ? current : nextHasPersistentGutter,
      );
      setMinimapHitStripWidth(resolveTimelineMinimapHitStripWidth(viewportWidth));
    };

    const frame = requestAnimationFrame(measure);

    const observer = new ResizeObserver(measure);
    observer.observe(timelineViewportElement);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [timelineViewportElement, rows.length]);

  const sharedState = useMemo<TimelineRowSharedState>(
    () => ({
      timestampFormat,
      routeThreadKey,
      threadRef: parseScopedThreadKey(routeThreadKey),
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      skills,
      deliveredMessageIds,
      newestUserMessageId,
      pendingMessageIds,
      deliveryProviderName,
      deliveryReceiptsExpected,
      activeThreadEnvironmentId,
      onRevertUserMessage,
      onImageExpand,
      onOpenTurnDiff,
      onToggleTurnFold,
      onToggleWorkGroup,
      onCompactAndContinue,
      isCompactAndContinueBusy,
      resumableAssistantMessageId,
      resumableRuntimeErrorActivityId,
      onResumeIncompleteTurn,
      isResumeIncompleteTurnBusy,
      isResumeIncompleteTurnDisabled,
    }),
    [
      timestampFormat,
      routeThreadKey,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      skills,
      deliveredMessageIds,
      newestUserMessageId,
      pendingMessageIds,
      deliveryProviderName,
      deliveryReceiptsExpected,
      activeThreadEnvironmentId,
      onRevertUserMessage,
      onImageExpand,
      onOpenTurnDiff,
      onToggleTurnFold,
      onToggleWorkGroup,
      onCompactAndContinue,
      isCompactAndContinueBusy,
      resumableAssistantMessageId,
      resumableRuntimeErrorActivityId,
      onResumeIncompleteTurn,
      isResumeIncompleteTurnBusy,
      isResumeIncompleteTurnDisabled,
    ],
  );
  const activityState = useMemo<TimelineRowActivityState>(
    () => ({
      isWorking,
      workingStatusLabel,
      environmentUnreachable,
      isRevertingCheckpoint,
      activeTurnInProgress,
      latestTurnId: latestTurn?.turnId ?? null,
    }),
    [
      activeTurnInProgress,
      environmentUnreachable,
      isRevertingCheckpoint,
      isWorking,
      latestTurn?.turnId,
      workingStatusLabel,
    ],
  );

  // Stable renderItem — no closure deps. Row components read shared state
  // from TimelineRowCtx, which propagates through LegendList's memo.
  const renderItem = useCallback(
    ({ item }: { item: MessagesTimelineRow }) => (
      <div className="mx-auto w-full min-w-0 max-w-3xl overflow-x-clip" data-timeline-root="true">
        <TimelineRowContent row={item} />
      </div>
    ),
    [],
  );
  const timelineShouldFollowEnd = followEnd && !manualFollowSuppressed;
  useEffect(() => {
    if (inlineNotice === null) return;
    const frame = requestAnimationFrame(() => {
      void mountedListRef.current?.scrollToEnd({ animated: false }).then(handleScroll);
    });
    return () => cancelAnimationFrame(frame);
  }, [handleScroll, inlineNotice?.id]);

  const listFooter = useMemo(
    () =>
      inlineNotice === null ? (
        TIMELINE_LIST_FOOTER
      ) : (
        <>
          <div className="mx-auto w-full min-w-0 max-w-3xl overflow-x-clip">
            {inlineNotice.content}
          </div>
          {TIMELINE_LIST_FOOTER}
        </>
      ),
    [inlineNotice],
  );

  if (rows.length === 0 && !isWorking) {
    if (hideEmptyPlaceholder) {
      return null;
    }
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground/30">
          Send a message to start the conversation.
        </p>
      </div>
    );
  }

  return (
    <TimelineRowCtx value={sharedState}>
      <TimelineRowActivityCtx value={activityState}>
        <div
          ref={setTimelineViewportElement}
          data-chat-timeline-bottom-inset="0"
          className="relative h-full min-h-0"
          onPointerEnter={() => {
            pointerInsideTimelineRef.current = true;
          }}
          onPointerLeave={() => {
            pointerInsideTimelineRef.current = false;
          }}
        >
          <LegendList<MessagesTimelineRow>
            ref={attachListRef}
            data={rows}
            keyExtractor={keyExtractor}
            getItemType={getItemType}
            renderItem={renderItem}
            estimatedItemSize={90}
            // Measure ahead of the viewport. Desktop can afford a larger buffer;
            // remote Safari uses a tighter one so a long thread cannot mount and
            // request dozens of historical images at once. Both remain well above
            // the old 250px buffer that caused measurement corrections mid-gesture.
            drawDistance={drawDistance}
            initialScrollAtEnd={initialScrollAtEnd}
            {...(initialScrollOffset === null ? {} : { initialScrollOffset })}
            maintainScrollAtEnd={
              shouldMaintainTimelineScrollAtEnd({
                hasAnchoredEndSpace: false,
                followEnd: timelineShouldFollowEnd,
              })
                ? {
                    animated: false,
                    on: {
                      dataChange: true,
                      itemLayout: true,
                      layout: true,
                    },
                  }
                : false
            }
            maintainVisibleContentPosition={
              shouldMaintainTimelineVisibleContentPosition({
                followEnd: timelineShouldFollowEnd,
              })
                ? {
                    data: true,
                    size: true,
                  }
                : false
            }
            onScroll={handleScroll}
            onLoad={handleTimelineLoad}
            onItemSizeChanged={handleTimelineItemSizeChanged}
            onWheel={handleWheelNavigation}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchEnd}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            className={cn(
              "scrollbar-gutter-both h-full min-h-0 overflow-x-hidden overscroll-y-contain px-3 [overflow-anchor:none] sm:px-5",
              topFadeEnabled && "chat-timeline-scroll-fade",
            )}
            ListHeaderComponent={listHeader}
            ListFooterComponent={listFooter}
          />
          <TimelineMinimap
            items={minimapItems}
            bottomInset={0}
            hasPersistentGutter={minimapHasPersistentGutter}
            hitStripWidth={minimapHitStripWidth}
            stripMap={minimapStripMap}
            onSelect={(item) => {
              onManualNavigation();
              void listRef.current?.scrollToIndex({
                index: item.rowIndex,
                animated: true,
                viewOffset: 24,
              });
            }}
          />
        </div>
      </TimelineRowActivityCtx>
    </TimelineRowCtx>
  );
});

function keyExtractor(item: MessagesTimelineRow) {
  return item.id;
}

function getItemType(item: MessagesTimelineRow) {
  return item.kind === "message" ? `message:${item.message.role}` : item.kind;
}

interface TimelineMinimapItem {
  readonly id: string;
  readonly rowIndex: number;
  readonly userText: string | null;
  readonly assistantText: string | null;
}

interface TimelinePositionState {
  readonly contentLength?: number;
  readonly scroll?: number;
  readonly scrollLength?: number;
  readonly positionAtIndex?: (index: number) => number | undefined;
  readonly sizeAtIndex?: (index: number) => number | undefined;
}

function deriveTimelineMinimapItems(
  rows: ReadonlyArray<MessagesTimelineRow>,
): TimelineMinimapItem[] {
  const items: TimelineMinimapItem[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message" || row.message.role !== "user") {
      continue;
    }

    items.push({
      id: row.id,
      rowIndex: index,
      userText: compactMinimapPreview(row.message.text),
      assistantText: compactMinimapPreview(resolveFinalAssistantTextForTurn(rows, index)),
    });
  }
  return items;
}

function resolveFinalAssistantTextForTurn(
  rows: ReadonlyArray<MessagesTimelineRow>,
  userRowIndex: number,
) {
  let finalAssistantText: string | null = null;
  for (let index = userRowIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message") {
      continue;
    }
    if (row.message.role === "user") {
      break;
    }
    if (row.message.role === "assistant") {
      finalAssistantText = row.message.text ?? null;
    }
  }
  return finalAssistantText;
}

function compactMinimapPreview(text: string | null | undefined) {
  const compact = text?.replace(/\s+/g, " ").trim() ?? "";
  return compact.length > 0 ? compact : null;
}

function resolveTimelineRowTop(state: TimelinePositionState, rowIndex: number) {
  const top = state.positionAtIndex?.(rowIndex);
  return typeof top === "number" && Number.isFinite(top) ? top : null;
}

function resolveTimelineRowHeight(state: TimelinePositionState, rowIndex: number) {
  const height = state.sizeAtIndex?.(rowIndex);
  return typeof height === "number" && Number.isFinite(height) ? height : null;
}

function TimelineMinimap({
  bottomInset,
  hasPersistentGutter,
  hitStripWidth,
  items,
  stripMap,
  onSelect,
}: {
  bottomInset: number;
  hasPersistentGutter: boolean;
  hitStripWidth: number;
  items: ReadonlyArray<TimelineMinimapItem>;
  stripMap: Map<string, HTMLSpanElement>;
  onSelect: (item: TimelineMinimapItem) => void;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const resolvedActiveIndex =
    activeIndex !== null && activeIndex < items.length ? activeIndex : null;
  const activeItem = resolvedActiveIndex === null ? null : (items[resolvedActiveIndex] ?? null);
  const activeTopPercent =
    resolvedActiveIndex === null
      ? 0
      : resolveTimelineMinimapTopPercent(resolvedActiveIndex, items.length);
  const activeTooltipTranslate =
    resolvedActiveIndex === null
      ? "-50%"
      : resolvedActiveIndex === 0
        ? "0%"
        : resolvedActiveIndex === items.length - 1
          ? "-100%"
          : "-50%";

  const resolveActiveIndexFromPointer = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      return resolveTimelineMinimapIndexFromPointer({
        itemCount: items.length,
        railTop: rect.top,
        railHeight: rect.height,
        pointerY: event.clientY,
      });
    },
    [items.length],
  );

  const updateActiveIndexFromPointer = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const nextIndex = resolveActiveIndexFromPointer(event);
      setActiveIndex(nextIndex);
    },
    [resolveActiveIndexFromPointer],
  );

  const moveActiveIndex = useCallback(
    (delta: number) => {
      setActiveIndex((current) => {
        const base = current ?? 0;
        return Math.max(0, Math.min(items.length - 1, base + delta));
      });
    },
    [items.length],
  );

  if (items.length < TIMELINE_MINIMAP_MIN_ITEMS) {
    return null;
  }

  const safeBottomInset = Math.max(0, Math.ceil(bottomInset));

  return (
    <div
      className={cn(
        "group/minimap pointer-events-none absolute top-0 left-0 z-40 hidden w-18 [@media(pointer:fine)]:block",
        hasPersistentGutter
          ? "opacity-100"
          : "opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100",
      )}
      data-testid="timeline-minimap"
      data-persistent-gutter={hasPersistentGutter ? "true" : "false"}
      style={{ bottom: safeBottomInset }}
    >
      <div className="relative h-full w-full select-none">
        <button
          aria-label={`Jump to message: ${activeItem?.userText ?? "User message"}`}
          className={cn(
            "absolute top-1/2 left-3 -translate-y-1/2 cursor-pointer bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
            // The strip is width-capped to the side gutter so it never overlays
            // the centered content column; with no usable gutter it goes inert.
            hitStripWidth > 0 ? "pointer-events-auto" : "pointer-events-none",
          )}
          onBlur={() => setActiveIndex(null)}
          onClick={(event) => {
            const nextIndex = resolveActiveIndexFromPointer(event);
            const nextItem = nextIndex === null ? null : (items[nextIndex] ?? null);
            if (nextItem) {
              onSelect(nextItem);
            }
            event.currentTarget.blur();
          }}
          onFocus={() => setActiveIndex((current) => current ?? 0)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              moveActiveIndex(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              moveActiveIndex(-1);
            } else if (event.key === "Home") {
              event.preventDefault();
              setActiveIndex(0);
            } else if (event.key === "End") {
              event.preventDefault();
              setActiveIndex(items.length - 1);
            } else if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              if (activeItem) {
                onSelect(activeItem);
              }
            }
          }}
          onMouseLeave={() => setActiveIndex(null)}
          onMouseMove={updateActiveIndexFromPointer}
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          style={{
            height: resolveTimelineMinimapHeightStyle(items.length),
            width: resolveTimelineMinimapInteractiveWidth(hitStripWidth),
          }}
          type="button"
        >
          <div className="absolute top-0 left-3 h-full w-px bg-border/15" />
          {items.map((item, index) => {
            const top = `${resolveTimelineMinimapTopPercent(index, items.length)}%`;
            const activeDistance =
              resolvedActiveIndex === null ? null : Math.abs(index - resolvedActiveIndex);
            return (
              <span
                aria-hidden="true"
                className={cn(
                  "pointer-events-none absolute left-0 h-0.5 -translate-y-1/2 rounded-full bg-muted-foreground/35 transition-[background-color,width] duration-150 data-[in-view=true]:bg-foreground/90",
                  activeDistance === 0
                    ? "w-6 bg-muted-foreground/75"
                    : activeDistance === 1
                      ? "w-4"
                      : activeDistance === 2
                        ? "w-2.5"
                        : "w-2",
                )}
                data-in-view="false"
                data-minimap-strip
                key={item.id}
                ref={(node) => {
                  if (node) {
                    stripMap.set(item.id, node);
                  } else {
                    stripMap.delete(item.id);
                  }
                }}
                style={{ top }}
              />
            );
          })}
          {activeItem ? (
            <span
              // Non-interactive on purpose. While this accepted pointer events
              // the strip had to widen to reach it, which put a 22rem block over
              // the conversation that ate clicks and held the preview open until
              // the pointer left the whole block. Ignoring the pointer means the
              // card closes the moment you leave the tick row, and never blocks
              // anything underneath.
              className="pointer-events-none absolute left-8 w-80"
              data-minimap-preview
              style={{
                top: `${activeTopPercent}%`,
                transform: `translateY(${activeTooltipTranslate})`,
              }}
            >
              <span className="dropdown-glass block rounded-xl p-3 text-left text-popover-foreground shadow-xl shadow-black/25">
                <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium leading-5">
                  {activeItem.userText ?? "User message"}
                </span>
                {activeItem.assistantText ? (
                  <span
                    className="mt-1 max-h-[3.75rem] overflow-hidden text-muted-foreground text-sm leading-5"
                    style={{
                      display: "-webkit-box",
                      WebkitBoxOrient: "vertical",
                      WebkitLineClamp: 3,
                    }}
                  >
                    {activeItem.assistantText}
                  </span>
                ) : null}
              </span>
            </span>
          ) : null}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TimelineRowContent — the actual row component
// ---------------------------------------------------------------------------

type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];
type TimelineMessage = Extract<TimelineEntry, { kind: "message" }>["message"];
type TimelineWorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];
type TimelineRow = MessagesTimelineRow;

const TimelineRowContent = memo(function TimelineRowContent({ row }: { row: TimelineRow }) {
  return (
    <div
      className={cn(
        // Commentary (non-terminal assistant) rows carry no metadata row, so
        // they sit closer to the work that follows them.
        (row.kind === "message" && row.message.role === "assistant" && !row.showAssistantMeta) ||
          row.kind === "work" ||
          row.kind === "work-toggle"
          ? "pb-2"
          : "pb-4",
        row.kind === "message" && row.message.role === "assistant" ? "group/assistant" : null,
      )}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={row.kind === "message" ? row.message.id : undefined}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {row.kind === "work" ? <WorkGroupSection groupedEntries={row.groupedEntries} /> : null}
      {row.kind === "work-toggle" ? <WorkGroupToggleTimelineRow row={row} /> : null}
      {row.kind === "turn-fold" ? <TurnFoldTimelineRow row={row} /> : null}
      {row.kind === "provider-transition" ? <ProviderTransitionTimelineRow row={row} /> : null}
      {row.kind === "conversation-boundary" ? <ConversationBoundaryTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "user" ? <UserTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "assistant" ? (
        <AssistantTimelineRow row={row} />
      ) : null}
      {row.kind === "proposed-plan" ? <ProposedPlanTimelineRow row={row} /> : null}
      {row.kind === "working" ? <WorkingTimelineRow row={row} /> : null}
    </div>
  );
});

function ProviderTransitionTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "provider-transition" }>;
}) {
  return (
    <div
      className="flex items-center gap-3 py-2 text-muted-foreground"
      role="status"
      aria-label={row.detail ? `${row.label}. ${row.detail}` : row.label}
    >
      <span className="h-px min-w-4 flex-1 bg-border/70" aria-hidden="true" />
      <span className="min-w-0 text-center">
        <span className="block font-medium text-foreground/80 text-xs">{row.label}</span>
        {row.detail ? <span className="mt-0.5 block text-[11px]">{row.detail}</span> : null}
      </span>
      <span className="h-px min-w-4 flex-1 bg-border/70" aria-hidden="true" />
    </div>
  );
}

/**
 * Where one sitting ended and the next began.
 *
 * The orchestrator thread never closes, so without this the transcript reads as
 * one endless conversation when it is really dozens — and both the reader and
 * the model lose track of which exchange a line belongs to. Styled like the
 * provider transition above because it carries the same instruction: what
 * follows starts over.
 */
const CONVERSATION_BOUNDARY_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function ConversationBoundaryTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "conversation-boundary" }>;
}) {
  const startedAt = Date.parse(row.createdAt);
  const when = Number.isFinite(startedAt)
    ? CONVERSATION_BOUNDARY_FORMAT.format(new Date(startedAt))
    : null;
  return (
    <div
      className="flex items-center gap-3 py-2 text-muted-foreground"
      role="separator"
      aria-label={when ? `New conversation, ${when}` : "New conversation"}
    >
      <span className="h-px min-w-4 flex-1 bg-border/70" aria-hidden="true" />
      <span className="min-w-0 text-center">
        <span className="block font-medium text-foreground/80 text-xs">New conversation</span>
        {when ? <span className="mt-0.5 block text-[11px]">{when}</span> : null}
      </span>
      <span className="h-px min-w-4 flex-1 bg-border/70" aria-hidden="true" />
    </div>
  );
}

function UserTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const [syntheticPromptExpanded, setSyntheticPromptExpanded] = useState(false);
  const userImages = row.message.attachments ?? [];
  const [interruptedExpanded, setInterruptedExpanded] = useState(false);
  // Stripped first. `deriveDisplayedUserMessageState` needs `<element_context>`
  // to be the trailing block, and this one is appended after it at send time.
  const interrupted = extractTrailingInterruptedTasksNotice(row.message.text);
  const displayedUserMessage = deriveDisplayedUserMessageState(interrupted.promptText);
  const terminalContexts = displayedUserMessage.contexts;
  const previewAnnotations: ParsedPreviewAnnotation[] = [];
  let visibleText = displayedUserMessage.visibleText;
  while (true) {
    const extracted = extractTrailingPreviewAnnotation(visibleText);
    if (!extracted.annotation) break;
    previewAnnotations.unshift(extracted.annotation);
    visibleText = extracted.promptText;
  }
  const elementContextState = extractTrailingElementContexts(visibleText);
  const elementContexts = [
    ...displayedUserMessage.elementContexts,
    ...elementContextState.contexts,
  ];
  const previewImages = userImages.filter((image) => image.name.startsWith("preview-annotation-"));
  const regularImages = userImages.filter((image) => !image.name.startsWith("preview-annotation-"));
  const canRevertAgentWork = typeof row.revertTurnCount === "number";
  const isDelivered = ctx.deliveredMessageIds.has(row.message.id);
  const deliveryState = messageDeliveryState({
    // Still only the client's own echo — the server has not stored it yet, so it
    // cannot claim to have been sent. On a dropped link this can persist.
    isOptimistic: ctx.pendingMessageIds.has(row.message.id),
    isDelivered,
  });
  const showDeliveryIndicator =
    // Voice-transcript rows are history of a conversation that already
    // happened aloud — they are never dispatched to a provider, so a delivery
    // indicator would show "Queued" forever.
    row.message.voiceTranscript !== true &&
    shouldShowDeliveryIndicator({
      isOptimistic: ctx.pendingMessageIds.has(row.message.id),
      isDelivered,
      isNewestUserMessage: ctx.newestUserMessageId === row.message.id,
      providerReportsDelivery: ctx.deliveryReceiptsExpected,
      threadReportsDelivery: threadReportsDelivery(ctx.deliveredMessageIds),
    });

  const settingsUpdate = parseSettingsUpdatePrompt(row.message.text);
  if (settingsUpdate !== null) {
    return (
      <div
        className="flex items-center gap-3 py-1"
        role="separator"
        aria-label={`Settings updated: ${settingsUpdate.description}`}
      >
        <div className="h-px flex-1 bg-border/70" />
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/60 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
          <SlidersHorizontalIcon className="size-3" aria-hidden />
          {settingsUpdate.description}
        </span>
        <div className="h-px flex-1 bg-border/70" />
      </div>
    );
  }

  const browserTabCleanup = isBrowserTabCleanupMessageId(row.message.id);
  const syntheticPromptLabel = browserTabCleanup
    ? "Browser tab cleanup"
    : isAgentContinuePrompt(row.message.text)
      ? "Agent auto-resuming"
      : isResumePrompt(row.message.text)
        ? "Resume"
        : null;

  if (syntheticPromptLabel !== null) {
    return (
      <div className="flex flex-col items-end gap-1.5">
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-accent/70 px-2.5 py-1 text-xs font-medium text-foreground/80 transition-colors hover:bg-accent"
          aria-expanded={syntheticPromptExpanded}
          onClick={() => setSyntheticPromptExpanded((expanded) => !expanded)}
        >
          <span>{syntheticPromptLabel}</span>
          {browserTabCleanup ? (
            <GlobeIcon className="size-3.5" aria-hidden />
          ) : (
            <FastForwardIcon className="size-3.5" aria-hidden />
          )}
        </button>
        {showDeliveryIndicator ? (
          <MessageDeliveryIndicator state={deliveryState} providerName={ctx.deliveryProviderName} />
        ) : null}
        {syntheticPromptExpanded ? (
          <div className="max-w-[80%] rounded-2xl bg-accent p-3">
            <CollapsibleUserMessageBody
              text={row.message.text}
              terminalContexts={[]}
              skills={ctx.skills}
              markdownCwd={ctx.markdownCwd}
            />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="group flex flex-col items-end gap-1">
      <div className="relative max-w-[80%] rounded-2xl bg-accent p-3">
        {regularImages.length > 0 && (
          <div className="mb-2 grid max-w-[420px] grid-cols-2 gap-2">
            {regularImages.map((image: NonNullable<TimelineMessage["attachments"]>[number]) => (
              <div
                key={image.id}
                className="aspect-video overflow-hidden rounded-lg border border-border/80 bg-background/70"
              >
                {image.previewUrl ? (
                  <button
                    type="button"
                    className="h-full w-full cursor-zoom-in"
                    aria-label={`Preview ${image.name}`}
                    onClick={() => {
                      const preview = buildExpandedImagePreview(regularImages, image.id);
                      if (!preview) return;
                      ctx.onImageExpand(preview);
                    }}
                  >
                    <img
                      src={image.previewUrl}
                      alt={image.name}
                      className="block size-full object-cover"
                      loading="lazy"
                      decoding="async"
                    />
                  </button>
                ) : (
                  <div className="flex size-full items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground/70">
                    {image.name}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {previewAnnotations.map((annotation, index) => (
          <UserMessagePreviewAnnotationCard
            key={annotation.id}
            annotation={annotation}
            image={previewImages[index] ?? null}
          />
        ))}
        {elementContexts.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {elementContexts.map((context) => (
              <UserMessageElementContextChip
                key={`${context.header}:${context.body}`}
                context={context}
              />
            ))}
          </div>
        ) : null}
        <CollapsibleUserMessageBody
          text={elementContextState.promptText}
          terminalContexts={terminalContexts}
          skills={ctx.skills}
          markdownCwd={ctx.markdownCwd}
        />
        {interrupted.titles.length > 0 ? (
          <div className="mt-2 flex flex-col items-start gap-1">
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 transition-colors hover:bg-amber-500/20 dark:text-amber-400"
              aria-expanded={interruptedExpanded}
              data-scroll-anchor-ignore
              onClick={() => setInterruptedExpanded((expanded) => !expanded)}
            >
              <OctagonXIcon className="size-3 shrink-0" aria-hidden />
              <span>{describeInterruptedTasks(interrupted.titles)}</span>
            </button>
            {interruptedExpanded ? (
              <div className="rounded-md border border-border/70 bg-background/60 px-2 py-1.5 text-[11px] text-muted-foreground">
                <p className="mb-1">
                  Sending this message cancelled these. The agent was told to restart any that are
                  still needed.
                </p>
                <ul className="list-inside list-disc space-y-0.5">
                  {interrupted.titles.map((title, index) => (
                    // Index is part of the key on purpose: two tasks can carry
                    // the same title, and this list is parsed from immutable
                    // message text, so it never reorders or grows.
                    // eslint-disable-next-line react/no-array-index-key
                    <li key={`${index}:${title}`} className="truncate">
                      {title}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
        {row.message.inputOrigin === "transcription" ? (
          <div className="mt-2 flex justify-start">
            <span className="rounded-full border border-border/70 bg-background/55 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              Transcribed
            </span>
          </div>
        ) : null}
      </div>
      <div className="flex w-full max-w-[80%] items-center justify-end gap-1.5 pe-1 text-xs tabular-nums">
        <div className="flex shrink-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger render={<p className="text-muted-foreground text-xs tabular-nums" />}>
              {formatShortTimestamp(row.message.createdAt, ctx.timestampFormat)}
            </TooltipTrigger>
            <TooltipPopup>
              {formatChatTimestampTooltip(row.message.createdAt, ctx.timestampFormat)}
            </TooltipPopup>
          </Tooltip>
          <div className="flex items-center gap-0.5">
            {canRevertAgentWork && <RevertUserMessageButton messageId={row.message.id} />}
            {displayedUserMessage.copyText && (
              <MessageCopyButton text={displayedUserMessage.copyText} variant="ghost" />
            )}
          </div>
        </div>
        {showDeliveryIndicator ? (
          <MessageDeliveryIndicator state={deliveryState} providerName={ctx.deliveryProviderName} />
        ) : null}
      </div>
    </div>
  );
}

/**
 * WhatsApp-style delivery state for a user message.
 *
 * One check means the orchestrator stored it; two mean the provider actually
 * pulled it into its agent loop. The gap between them is the steering window —
 * a message sent mid-turn waits in the prompt queue, and until now there was no
 * way to tell a steer that had landed from one the CLI had not reached.
 *
 * Unlike the timestamp and copy button beside it, this is not gated on hover:
 * an indicator you have to go looking for cannot answer "did that land?".
 */
function MessageDeliveryIndicator({
  state,
  providerName,
}: {
  state: Exclude<MessageDeliveryState, "pending"> | "pending";
  providerName: string;
}) {
  const label = messageDeliveryLabel(state, providerName);
  const showInlineStatus = state !== "read";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-muted-foreground/70"
            aria-label={label}
            role="status"
          />
        }
      >
        {state === "pending" ? (
          <LoaderCircleIcon className="size-3 animate-spin" aria-hidden />
        ) : state === "read" ? (
          // Overlapped pair, second check tucked left — the WhatsApp shape.
          <span className="flex items-center">
            <CheckIcon className="size-3" aria-hidden />
            <CheckIcon className="-ms-1.5 size-3" aria-hidden />
          </span>
        ) : (
          <CheckIcon className="size-3" aria-hidden />
        )}
        {showInlineStatus ? <span>{label}</span> : null}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

function RevertUserMessageButton({ messageId }: { messageId: MessageId }) {
  const ctx = use(TimelineRowCtx);
  const activity = use(TimelineRowActivityCtx);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={activity.isRevertingCheckpoint || activity.isWorking}
            onClick={() => ctx.onRevertUserMessage(messageId)}
            aria-label="Revert to this message"
          />
        }
      >
        <Undo2Icon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">Revert to this message</TooltipPopup>
    </Tooltip>
  );
}

function TurnFoldTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "turn-fold" }> }) {
  const ctx = use(TimelineRowCtx);
  const Icon = row.expanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <div className="border-b border-border/60 pb-2 pt-1">
      <button
        type="button"
        aria-expanded={row.expanded}
        data-scroll-anchor-ignore
        onClick={() => ctx.onToggleTurnFold(row.turnId)}
        className="flex cursor-pointer select-none items-center gap-1 rounded-md px-1 text-xs text-muted-foreground tabular-nums transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <span>{row.label}</span>
        <Icon className="size-3.5" />
      </button>
    </div>
  );
}

function AssistantTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");
  const stopSignoff = row.message.streaming
    ? { hasStop: false, text: messageText }
    : extractAgentStopSignoff(messageText);

  return (
    <>
      <div className="relative min-w-0 px-1 py-0.5">
        {stopSignoff.text.length > 0 || row.message.streaming ? (
          <ChatMarkdown
            text={stopSignoff.text}
            cwd={ctx.markdownCwd}
            threadRef={ctx.threadRef ?? undefined}
            isStreaming={Boolean(row.message.streaming)}
            assetRevision={row.message.id}
            sourceMessageId={row.message.id}
            skills={ctx.skills}
            lowContextWarningAction={
              row.message.streaming
                ? undefined
                : {
                    onCompactAndContinue: ctx.onCompactAndContinue,
                    busy: ctx.isCompactAndContinueBusy,
                  }
            }
          />
        ) : null}
        {stopSignoff.hasStop ? (
          <div
            className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-red-500/35 bg-red-500/10 px-2.5 py-1 font-medium text-red-600 text-xs dark:text-red-400"
            data-agent-stop-badge="true"
            role="status"
          >
            <CircleStopIcon aria-hidden="true" className="size-3.5" />
            <span>Agent stop</span>
          </div>
        ) : null}
        <AssistantChangedFilesSection
          turnSummary={row.assistantTurnDiffSummary}
          routeThreadKey={ctx.routeThreadKey}
          resolvedTheme={ctx.resolvedTheme}
          onOpenTurnDiff={ctx.onOpenTurnDiff}
        />
        {ctx.resumableAssistantMessageId === row.message.id ? (
          <div className="mt-2 flex items-center">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={
                ctx.isResumeIncompleteTurnBusy
                  ? "Resuming incomplete response"
                  : ctx.isResumeIncompleteTurnDisabled
                    ? "Resume unavailable while the remote machine is disconnected"
                    : "Resume incomplete response"
              }
              aria-busy={ctx.isResumeIncompleteTurnBusy}
              disabled={ctx.isResumeIncompleteTurnBusy || ctx.isResumeIncompleteTurnDisabled}
              onClick={ctx.onResumeIncompleteTurn}
              title={
                ctx.isResumeIncompleteTurnDisabled
                  ? "Reconnect the remote machine to resume this response."
                  : undefined
              }
              className="h-8 gap-1.5 rounded-lg bg-card/80 text-foreground shadow-sm disabled:text-muted-foreground disabled:opacity-55"
            >
              {ctx.isResumeIncompleteTurnBusy ? (
                <LoaderCircleIcon aria-hidden="true" className="size-3.5 animate-spin" />
              ) : (
                <MessageCircleIcon aria-hidden="true" className="size-3.5" />
              )}
              {ctx.isResumeIncompleteTurnBusy ? "Resuming…" : "Resume"}
            </Button>
          </div>
        ) : null}
        {row.showAssistantMeta ? (
          <div className="mt-1.5 flex items-center gap-2 text-xs tabular-nums">
            <AssistantCopyButton row={row} />
            {!row.message.streaming && (
              <Tooltip>
                <TooltipTrigger
                  render={<p className="text-muted-foreground text-xs tabular-nums" />}
                >
                  {formatShortTimestamp(row.message.updatedAt, ctx.timestampFormat)}
                </TooltipTrigger>
                <TooltipPopup>
                  {formatChatTimestampTooltip(row.message.updatedAt, ctx.timestampFormat)}
                </TooltipPopup>
              </Tooltip>
            )}
          </div>
        ) : null}
      </div>
    </>
  );
}

function AssistantCopyButton({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const assistantCopyState = resolveAssistantMessageCopyState({
    text: row.message.text ?? null,
    showCopyButton: row.showAssistantCopyButton,
    streaming: row.assistantCopyStreaming,
  });

  if (!assistantCopyState.visible) {
    return null;
  }

  return <MessageCopyButton text={assistantCopyState.text ?? ""} variant="ghost" />;
}

function ProposedPlanTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "proposed-plan" }>;
}) {
  const ctx = use(TimelineRowCtx);

  return (
    <div className="min-w-0 px-1 py-0.5">
      <ProposedPlanCard
        planMarkdown={row.proposedPlan.planMarkdown}
        environmentId={ctx.activeThreadEnvironmentId}
        threadRef={ctx.threadRef ?? undefined}
        cwd={ctx.markdownCwd}
        workspaceRoot={ctx.workspaceRoot}
      />
    </div>
  );
}

function WorkingTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "working" }> }) {
  const { workingStatusLabel, environmentUnreachable } = use(TimelineRowActivityCtx);
  // While the host is unreachable this thread's state is last-known, not live:
  // the turn may have finished, failed, or still be going, and there is no way
  // to find out or to stop it from here. Animating a pulse and counting the
  // seconds up claims live progress we cannot observe, so the row goes static
  // and says what is actually true.
  if (environmentUnreachable) {
    return (
      <div className="py-0.5 pl-1.5">
        <div className="flex items-center gap-2 pt-1 text-[11px] text-muted-foreground/50">
          <span className="inline-flex items-center gap-[3px]">
            <span className="h-1 w-1 rounded-full bg-muted-foreground/25" />
            <span className="h-1 w-1 rounded-full bg-muted-foreground/25" />
            <span className="h-1 w-1 rounded-full bg-muted-foreground/25" />
          </span>
          <span>Was working when the host went offline — reconnecting…</span>
        </div>
      </div>
    );
  }
  return (
    <div className="py-0.5 pl-1.5">
      <div className="flex items-center gap-2 pt-1 text-[11px] text-muted-foreground/70 tabular-nums">
        <span className="inline-flex items-center gap-[3px]">
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-status-pulse" />
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-status-pulse [animation-delay:200ms]" />
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-status-pulse [animation-delay:400ms]" />
        </span>
        <span>
          {workingStatusLabel ? (
            <>{workingStatusLabel}…</>
          ) : row.createdAt ? (
            <>
              Working for <WorkingTimer createdAt={row.createdAt} />
            </>
          ) : (
            "Working..."
          )}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-ticking labels — update their own text nodes so elapsed-time display
// does not create a React commit every second while a response is streaming.
// ---------------------------------------------------------------------------

/** Live "Working for Xs" label. */
function WorkingTimer({ createdAt }: { createdAt: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = formatWorkingTimerNow(createdAt);

  useEffect(() => {
    const updateText = () => {
      if (textRef.current) {
        textRef.current.textContent = formatWorkingTimerNow(createdAt);
      }
    };
    updateText();
    const id = setInterval(updateText, 1000);
    return () => clearInterval(id);
  }, [createdAt]);

  return (
    <span ref={textRef} className="tabular-nums">
      {initialText}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Extracted row sections — own their state / store subscriptions so changes
// re-render only the affected row, not the entire list.
// ---------------------------------------------------------------------------

/** Renders one or more already-derived work log rows. Overflow expansion is modeled as LegendList data. */
const WorkGroupSection = memo(function WorkGroupSection({
  groupedEntries,
}: {
  groupedEntries: Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"];
}) {
  const ctx = use(TimelineRowCtx);
  const { workspaceRoot } = ctx;
  const nonEmptyEntries = useMemo(
    () => groupedEntries.filter((entry) => !workEntryIndicatesToolNeutralStatus(entry)),
    [groupedEntries],
  );
  const onlyToolEntries = nonEmptyEntries.every((entry) => workLogEntryIsToolLike(entry));
  const groupLabel = onlyToolEntries
    ? nonEmptyEntries.length === 1
      ? "1 tool call"
      : `${nonEmptyEntries.length} tool calls`
    : "Work Log";
  const showsResumableRuntimeError = nonEmptyEntries.some(
    (entry) => entry.id === ctx.resumableRuntimeErrorActivityId,
  );

  if (nonEmptyEntries.length === 0) return null;

  return (
    <section className="-mx-1 space-y-0.5 px-1 py-0.5" aria-label={groupLabel}>
      {!onlyToolEntries && (
        <p className="px-0.5 pb-0.5 font-medium text-[11px] text-muted-foreground/65">
          {groupLabel}
        </p>
      )}
      <div className="space-y-px">
        {nonEmptyEntries.map((workEntry) => (
          <SimpleWorkEntryRow
            key={workEntry.id}
            workEntry={workEntry}
            workspaceRoot={workspaceRoot}
          />
        ))}
      </div>
      {showsResumableRuntimeError ? (
        <div className="ms-7 pt-1">
          <Button
            type="button"
            variant="outline"
            size="xs"
            aria-label={
              ctx.isResumeIncompleteTurnBusy
                ? "Resuming after runtime error"
                : ctx.isResumeIncompleteTurnDisabled
                  ? "Resume unavailable while the remote machine is disconnected"
                  : "Resume after runtime error"
            }
            aria-busy={ctx.isResumeIncompleteTurnBusy}
            disabled={ctx.isResumeIncompleteTurnBusy || ctx.isResumeIncompleteTurnDisabled}
            onClick={ctx.onResumeIncompleteTurn}
            title={
              ctx.isResumeIncompleteTurnDisabled
                ? "Reconnect the remote machine to resume this task."
                : undefined
            }
            className="h-7 gap-1.5 rounded-lg bg-card/80 text-foreground shadow-sm disabled:text-muted-foreground disabled:opacity-55"
            data-runtime-error-resume="true"
          >
            {ctx.isResumeIncompleteTurnBusy ? (
              <LoaderCircleIcon aria-hidden="true" className="size-3.5 animate-spin" />
            ) : (
              <FastForwardIcon aria-hidden="true" className="size-3.5" />
            )}
            {ctx.isResumeIncompleteTurnBusy ? "Resuming…" : "Resume"}
          </Button>
        </div>
      ) : null}
    </section>
  );
});

function WorkGroupToggleTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "work-toggle" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const labelNoun = row.onlyToolEntries
    ? row.hiddenCount === 1
      ? "tool call"
      : "tool calls"
    : row.hiddenCount === 1
      ? "log entry"
      : "log entries";

  return (
    <button
      type="button"
      className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-[12px] leading-5 transition-colors duration-150 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      aria-expanded={row.expanded}
      onClick={(event) => {
        const anchorElement =
          event.currentTarget.closest<HTMLElement>("[data-timeline-row-id]") ?? event.currentTarget;
        ctx.onToggleWorkGroup(row.groupId, anchorElement);
      }}
    >
      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground/65">
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 opacity-70 transition-transform duration-200",
            row.expanded && "rotate-180",
          )}
        />
      </span>
      {row.expanded ? (
        <span className="font-medium text-foreground/82">
          Show fewer {row.onlyToolEntries ? "tool calls" : "log entries"}
        </span>
      ) : (
        <span className="font-medium text-foreground/82">
          +{row.hiddenCount} previous {labelNoun}
        </span>
      )}
    </button>
  );
}

/** Subscribes directly to the UI state store for expand/collapse state,
 *  so toggling re-renders only this component — not the entire list. */
const AssistantChangedFilesSection = memo(function AssistantChangedFilesSection({
  turnSummary,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary | undefined;
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  if (!turnSummary) return null;
  const checkpointFiles = turnSummary.files;
  if (checkpointFiles.length === 0) return null;

  return (
    <AssistantChangedFilesSectionInner
      turnSummary={turnSummary}
      checkpointFiles={checkpointFiles}
      routeThreadKey={routeThreadKey}
      resolvedTheme={resolvedTheme}
      onOpenTurnDiff={onOpenTurnDiff}
    />
  );
});

/** Inner component that only mounts when there are actual changed files,
 *  so the store subscription is unconditional (no hooks after early return). */
function AssistantChangedFilesSectionInner({
  turnSummary,
  checkpointFiles,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary;
  checkpointFiles: TurnDiffSummary["files"];
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  const activity = use(TimelineRowActivityCtx);
  const isLatestTurn = activity.latestTurnId === turnSummary.turnId;
  const persistedExpanded = useUiStateStore(
    (store) => store.threadChangedFilesExpandedById[routeThreadKey]?.[turnSummary.turnId],
  );
  const setExpanded = useUiStateStore((store) => store.setThreadChangedFilesExpanded);
  const [autoExpanded] = useState(() =>
    shouldAutoExpandChangedFiles(checkpointFiles, isLatestTurn),
  );
  const [allDirectoriesExpanded, setAllDirectoriesExpanded] = useState(autoExpanded);
  const expanded = persistedExpanded ?? (isLatestTurn && autoExpanded);

  return (
    <ChangedFilesCard
      turnId={turnSummary.turnId}
      files={checkpointFiles}
      expanded={expanded}
      showCompactPreview={isLatestTurn}
      allDirectoriesExpanded={allDirectoriesExpanded}
      resolvedTheme={resolvedTheme}
      onExpandedChange={(nextExpanded) =>
        setExpanded(routeThreadKey, turnSummary.turnId, nextExpanded)
      }
      onToggleAllDirectories={() => setAllDirectoriesExpanded((current) => !current)}
      onOpenTurnDiff={onOpenTurnDiff}
    />
  );
}

// ---------------------------------------------------------------------------
// Leaf components
// ---------------------------------------------------------------------------

const UserMessageTerminalContextInlineLabel = memo(
  function UserMessageTerminalContextInlineLabel(props: { context: ParsedTerminalContextEntry }) {
    const tooltipText =
      props.context.body.length > 0
        ? `${props.context.header}\n${props.context.body}`
        : props.context.header;

    return <TerminalContextInlineChip label={props.context.header} tooltipText={tooltipText} />;
  },
);

const UserMessageElementContextChip = memo(function UserMessageElementContextChip(props: {
  context: ParsedElementContextEntry;
}) {
  const tooltipText = props.context.body
    ? `${props.context.header}\n${props.context.body}`
    : props.context.header;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/70 bg-background/70 px-1.5 py-0.5 text-xs text-foreground/85">
            <MousePointerClickIcon className="size-3 shrink-0" />
            <span className="truncate">{props.context.header}</span>
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap leading-tight">
        {tooltipText}
      </TooltipPopup>
    </Tooltip>
  );
});

function UserMessagePreviewAnnotationCard(props: {
  annotation: ParsedPreviewAnnotation;
  image: NonNullable<TimelineMessage["attachments"]>[number] | null;
}) {
  const ctx = use(TimelineRowCtx);
  return (
    <div className="mb-2 flex max-w-full items-center overflow-hidden rounded-lg border border-border/70 bg-background/70">
      {props.image?.previewUrl ? (
        <button
          type="button"
          className="size-14 shrink-0 cursor-zoom-in overflow-hidden border-r border-border/70 bg-muted"
          aria-label={`Preview ${props.image.name}`}
          onClick={() => {
            if (!props.image) return;
            const preview = buildExpandedImagePreview([props.image], props.image.id);
            if (preview) ctx.onImageExpand(preview);
          }}
        >
          <img
            src={props.image.previewUrl}
            alt="Annotated preview crop"
            className="size-full object-cover"
            loading="lazy"
            decoding="async"
          />
        </button>
      ) : null}
      <div className="min-w-0 px-2.5 py-2">
        {props.annotation.comment ? (
          <div className="max-w-80 truncate text-xs font-medium text-foreground/90">
            {props.annotation.comment}
          </div>
        ) : null}
        <div
          className={cn(
            "flex items-center gap-2 text-[10px] text-muted-foreground",
            props.annotation.comment && "mt-1",
          )}
        >
          {props.annotation.targetSummary ? (
            <span className="truncate">{props.annotation.targetSummary}</span>
          ) : null}
          {props.annotation.styleChanges.length > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1">
              <PaintbrushIcon className="size-3" />
              {props.annotation.styleChanges.length}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const MAX_COLLAPSED_USER_MESSAGE_LINES = 8;
const MAX_COLLAPSED_USER_MESSAGE_LENGTH = 600;
const COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM = 1.75;
const COLLAPSED_USER_MESSAGE_FADE_MASK = `linear-gradient(to bottom, black calc(100% - ${COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM}rem), transparent)`;

function shouldCollapseUserMessage(text: string): boolean {
  if (text.trim().length === 0) {
    return false;
  }

  return (
    text.length > MAX_COLLAPSED_USER_MESSAGE_LENGTH ||
    text.split("\n").length > MAX_COLLAPSED_USER_MESSAGE_LINES
  );
}

const CollapsibleUserMessageBody = memo(function CollapsibleUserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  markdownCwd: string | undefined;
  footer?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasVisibleBody = props.text.trim().length > 0 || props.terminalContexts.length > 0;
  const canCollapse = hasVisibleBody && shouldCollapseUserMessage(props.text);
  const isCollapsed = canCollapse && !expanded;

  return (
    <div>
      {hasVisibleBody ? (
        <div
          className={cn("relative", isCollapsed && "max-h-44 overflow-hidden")}
          data-user-message-body="true"
          data-user-message-collapsed={isCollapsed ? "true" : "false"}
          data-user-message-collapsible={canCollapse ? "true" : "false"}
          data-user-message-fade={isCollapsed ? "true" : "false"}
          style={
            isCollapsed
              ? {
                  WebkitMaskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                  maskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                }
              : undefined
          }
        >
          <UserMessageBody
            text={props.text}
            terminalContexts={props.terminalContexts}
            skills={props.skills}
            markdownCwd={props.markdownCwd}
          />
        </div>
      ) : null}
      {canCollapse || props.footer ? (
        <div
          className={cn(
            "mt-1.5 flex items-center gap-2",
            canCollapse && props.footer ? "justify-between" : "justify-end",
          )}
          data-user-message-footer="true"
        >
          {canCollapse ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-expanded={expanded}
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
              className="-ml-1 h-6 rounded-md px-1.5 text-xs text-muted-foreground/72 hover:bg-muted/55 hover:text-foreground/85"
            >
              {expanded ? "Show less" : "Show full message"}
            </Button>
          ) : null}
          {props.footer ? (
            <div className="ml-auto flex items-center gap-2">{props.footer}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  markdownCwd: string | undefined;
}) {
  const ctx = use(TimelineRowCtx);
  const renderInlineMarkdownSegment = (text: string, key: string) => {
    const leadingWhitespace = /^\s+/.exec(text)?.[0] ?? "";
    const textWithoutLeadingWhitespace = text.slice(leadingWhitespace.length);
    const trailingWhitespace = /\s+$/.exec(textWithoutLeadingWhitespace)?.[0] ?? "";
    const content = textWithoutLeadingWhitespace.slice(
      0,
      textWithoutLeadingWhitespace.length - trailingWhitespace.length,
    );

    return (
      <Fragment key={key}>
        {leadingWhitespace ? <span aria-hidden="true">{leadingWhitespace}</span> : null}
        {content ? (
          <ChatMarkdown
            text={content}
            cwd={props.markdownCwd}
            threadRef={ctx.threadRef ?? undefined}
            skills={props.skills}
            className="text-foreground"
            lineBreaks
          />
        ) : null}
        {trailingWhitespace ? <span aria-hidden="true">{trailingWhitespace}</span> : null}
      </Fragment>
    );
  };

  const reviewCommentSegments = parseReviewCommentMessageSegments(props.text);
  if (reviewCommentSegments.some((segment) => segment.kind === "review-comment")) {
    return (
      <div className="space-y-3 text-sm leading-relaxed text-foreground">
        {reviewCommentSegments.map((segment) =>
          segment.kind === "text" ? (
            segment.text.trim().length > 0 ? (
              <div key={segment.id} className="wrap-break-word">
                <ChatMarkdown
                  text={segment.text.trim()}
                  cwd={props.markdownCwd}
                  threadRef={ctx.threadRef ?? undefined}
                  skills={props.skills}
                  className="text-foreground"
                  lineBreaks
                />
              </div>
            ) : null
          ) : (
            <UserMessageReviewCommentCard key={segment.comment.id} comment={segment.comment} />
          ),
        )}
      </div>
    );
  }

  if (props.terminalContexts.length > 0) {
    const hasEmbeddedInlineLabels = textContainsInlineTerminalContextLabels(
      props.text,
      props.terminalContexts,
    );
    const inlinePrefix = buildInlineTerminalContextText(props.terminalContexts);
    const inlineNodes: ReactNode[] = [];

    if (hasEmbeddedInlineLabels) {
      let cursor = 0;

      for (const context of props.terminalContexts) {
        const label = formatInlineTerminalContextLabel(context.header);
        const matchIndex = props.text.indexOf(label, cursor);
        if (matchIndex === -1) {
          inlineNodes.length = 0;
          break;
        }
        if (matchIndex > cursor) {
          inlineNodes.push(
            renderInlineMarkdownSegment(
              props.text.slice(cursor, matchIndex),
              `user-terminal-context-inline-before:${context.header}:${cursor}`,
            ),
          );
        }
        inlineNodes.push(
          <UserMessageTerminalContextInlineLabel
            key={`user-terminal-context-inline:${context.header}`}
            context={context}
          />,
        );
        cursor = matchIndex + label.length;
      }

      if (inlineNodes.length > 0) {
        if (cursor < props.text.length) {
          inlineNodes.push(
            renderInlineMarkdownSegment(
              props.text.slice(cursor),
              `user-message-terminal-context-inline-rest:${cursor}`,
            ),
          );
        }

        return (
          <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
            {inlineNodes}
          </div>
        );
      }
    }

    for (const context of props.terminalContexts) {
      inlineNodes.push(
        <UserMessageTerminalContextInlineLabel
          key={`user-terminal-context-inline:${context.header}`}
          context={context}
        />,
      );
      inlineNodes.push(
        <span key={`user-terminal-context-inline-space:${context.header}`} aria-hidden="true">
          {" "}
        </span>,
      );
    }

    if (props.text.length > 0) {
      inlineNodes.push(
        <ChatMarkdown
          key="user-message-terminal-context-inline-text"
          text={props.text}
          cwd={props.markdownCwd}
          threadRef={ctx.threadRef ?? undefined}
          skills={props.skills}
          className="text-foreground"
          lineBreaks
        />,
      );
    } else if (inlinePrefix.length === 0) {
      return null;
    }

    return (
      <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
        {inlineNodes}
      </div>
    );
  }

  if (props.text.length === 0) {
    return null;
  }

  return (
    <ChatMarkdown
      text={props.text}
      cwd={props.markdownCwd}
      threadRef={ctx.threadRef ?? undefined}
      skills={props.skills}
      className="text-foreground"
      lineBreaks
    />
  );
});

function UserMessageReviewCommentCard({ comment }: { comment: ReviewCommentContext }) {
  const ctx = use(TimelineRowCtx);
  const fenceLanguage = comment.fenceLanguage ?? "diff";
  const renderablePatch = getRenderablePatch(
    buildReviewCommentRenderablePatch(comment),
    `review-comment:${comment.id}`,
  );

  return (
    <div className="space-y-2 rounded-lg border border-border/70 bg-background/70 p-3">
      <div className="space-y-1">
        <div className="text-xs font-medium text-foreground">
          {formatWorkspaceRelativePath(comment.filePath, ctx.workspaceRoot)}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {comment.sectionTitle} · {comment.rangeLabel}
        </div>
      </div>
      {comment.text.length > 0 && (
        <div className="whitespace-pre-wrap wrap-break-word text-sm">
          <SkillInlineText text={comment.text} skills={ctx.skills} />
        </div>
      )}
      {fenceLanguage !== "diff" && comment.diff.trim().length > 0 && (
        <ChatMarkdown
          text={formatReviewCommentFence(fenceLanguage, comment.diff)}
          cwd={ctx.markdownCwd}
          threadRef={ctx.threadRef ?? undefined}
          skills={ctx.skills}
          className="text-foreground"
        />
      )}
      {renderablePatch?.kind === "files" &&
        renderablePatch.files.map((fileDiff) => (
          <FileDiff
            key={resolveFileDiffPath(fileDiff)}
            fileDiff={fileDiff}
            options={{
              collapsed: false,
              diffStyle: "unified",
              theme: resolveDiffThemeName(ctx.resolvedTheme),
            }}
          />
        ))}
      {renderablePatch?.kind === "raw" && (
        <pre className="overflow-x-auto rounded-md bg-muted/40 p-2 text-xs">
          {renderablePatch.text}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Structural sharing — reuse old row references when data hasn't changed
// so LegendList (and React) can skip re-rendering unchanged items.
// ---------------------------------------------------------------------------

/** Returns a structurally-shared copy of `rows`: for each row whose content
 *  hasn't changed since last call, the previous object reference is reused. */
function useStableRows(rows: MessagesTimelineRow[]): MessagesTimelineRow[] {
  const prevState = useRef<StableMessagesTimelineRowsState>({
    byId: new Map<string, MessagesTimelineRow>(),
    result: [],
  });

  return useMemo(() => {
    const nextState = computeStableMessagesTimelineRows(rows, prevState.current);
    prevState.current = nextState;
    return nextState.result;
  }, [rows]);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatWorkingTimerNow(startIso: string): string {
  return formatWorkingTimer(startIso, new Date().toISOString()) ?? "0s";
}

type WorkEntryIconName =
  | "bot"
  | "check"
  | "circle-alert"
  | "eye"
  | "file-search"
  | "globe"
  | "hammer"
  | "message-circle"
  | "mouse"
  | "square-pen"
  | "terminal"
  | "wrench"
  | "x"
  | "zap";

function WorkEntryIconSvg({ name, className }: { name: WorkEntryIconName; className: string }) {
  switch (name) {
    case "bot":
      return <BotIcon className={className} aria-hidden />;
    case "check":
      return <CheckIcon className={className} aria-hidden />;
    case "circle-alert":
      return <CircleAlertIcon className={className} aria-hidden />;
    case "eye":
      return <EyeIcon className={className} aria-hidden />;
    case "file-search":
      return <FileSearchIcon className={className} aria-hidden />;
    case "globe":
      return <GlobeIcon className={className} aria-hidden />;
    case "hammer":
      return <HammerIcon className={className} aria-hidden />;
    case "message-circle":
      return <MessageCircleIcon className={className} aria-hidden />;
    case "mouse":
      return <MouseIcon className={className} aria-hidden />;
    case "square-pen":
      return <SquarePenIcon className={className} aria-hidden />;
    case "terminal":
      return <TerminalIcon className={className} aria-hidden />;
    case "wrench":
      return <WrenchIcon className={className} aria-hidden />;
    case "x":
      return <XIcon className={className} aria-hidden />;
    case "zap":
      return <ZapIcon className={className} aria-hidden />;
  }
}

function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  iconName: WorkEntryIconName;
  className: string;
} {
  if (tone === "error") {
    return {
      iconName: "circle-alert",
      className: "text-foreground/92",
    };
  }
  if (tone === "thinking") {
    return {
      iconName: "bot",
      className: "text-foreground/92",
    };
  }
  if (tone === "info") {
    return {
      iconName: "check",
      className: "text-muted-foreground",
    };
  }
  return {
    iconName: "zap",
    className: "text-foreground/92",
  };
}

function workEntryPreview(
  workEntry: Pick<TimelineWorkEntry, "detail" | "command" | "changedFiles">,
  workspaceRoot: string | undefined,
) {
  if (workEntry.command) return workEntry.command;
  if (workEntry.detail) return workEntry.detail;
  if ((workEntry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = workEntry.changedFiles ?? [];
  if (!firstPath) return null;
  const displayPath = formatWorkspaceRelativePath(firstPath, workspaceRoot);
  return workEntry.changedFiles!.length === 1
    ? displayPath
    : `${displayPath} +${workEntry.changedFiles!.length - 1} more`;
}

function workEntryRawCommand(
  workEntry: Pick<TimelineWorkEntry, "command" | "rawCommand">,
): string | null {
  const rawCommand = workEntry.rawCommand?.trim();
  if (!rawCommand || !workEntry.command) {
    return null;
  }
  return rawCommand === workEntry.command.trim() ? null : rawCommand;
}

function buildToolCallExpandedBody(
  workEntry: TimelineWorkEntry,
  workspaceRoot: string | undefined,
): string | null {
  const blocks: string[] = [];
  if (workEntry.tokenOptimizer) {
    const optimized = workEntry.tokenOptimizer;
    blocks.push(
      [
        `${optimized.compressedChars.toLocaleString()} characters rendered across ${optimized.pageCount.toLocaleString()} ${optimized.pageCount === 1 ? "page" : "pages"}`,
        optimized.estimatedTextTokens !== undefined
          ? `Text baseline: ~${optimized.estimatedTextTokens.toLocaleString()} tokens`
          : null,
        optimized.estimatedImageTokens !== undefined
          ? `Image input: ~${optimized.estimatedImageTokens.toLocaleString()} tokens`
          : null,
        optimized.estimatedNativeTokens !== undefined
          ? `Optimizer framing: ~${optimized.estimatedNativeTokens.toLocaleString()} tokens`
          : null,
        optimized.estimatedTokensSaved !== undefined
          ? `Estimated saved: ~${optimized.estimatedTokensSaved.toLocaleString()} tokens`
          : null,
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
    );
  }
  if (workEntry.itemType === "mcp_tool_call" && workEntry.toolData !== undefined) {
    blocks.push(`MCP call\n${JSON.stringify(workEntry.toolData, null, 2)}`);
  }
  const raw = workEntryRawCommand(workEntry);
  if (raw?.trim()) {
    blocks.push(raw.trim());
  } else if (workEntry.command?.trim()) {
    blocks.push(workEntry.command.trim());
  }
  if (workEntry.detail?.trim()) {
    blocks.push(workEntry.detail.trim());
  }
  const changedFiles = workEntry.changedFiles ?? [];
  if (changedFiles.length > 0) {
    blocks.push(
      changedFiles
        .map((filePath) => formatWorkspaceRelativePath(filePath, workspaceRoot))
        .join("\n"),
    );
  }
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

function workEntryIconName(workEntry: TimelineWorkEntry): WorkEntryIconName {
  if (workEntry.sourceActivityKind === "token-optimizer.applied") {
    return "zap";
  }
  if (
    workEntry.sourceActivityKind === "user-input.requested" ||
    workEntry.sourceActivityKind === "user-input.resolved"
  ) {
    return "message-circle";
  }
  if (workEntry.requestKind === "command") return "terminal";
  if (workEntry.requestKind === "file-read") return "eye";
  if (workEntry.requestKind === "file-change") return "square-pen";

  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return "terminal";
  }
  if (workEntry.itemType === "file_change" || (workEntry.changedFiles?.length ?? 0) > 0) {
    return "square-pen";
  }
  if (
    normalizeCompactToolLabel(workEntry.toolTitle ?? workEntry.label).toLowerCase() ===
    "searched files"
  ) {
    return "file-search";
  }
  if (workEntry.itemType === "web_search") return "globe";
  if (workEntry.itemType === "image_view") return "eye";
  if (
    previewComputerControlAction({
      ...(workEntry.toolTitle !== undefined ? { toolTitle: workEntry.toolTitle } : {}),
      toolData: workEntry.toolData,
    }) !== null
  ) {
    return "mouse";
  }

  switch (workEntry.itemType) {
    case "mcp_tool_call":
      return "wrench";
    case "dynamic_tool_call":
    case "collab_agent_tool_call":
      return "hammer";
  }

  return workToneIcon(workEntry.tone).iconName;
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function toolWorkEntryHeading(workEntry: TimelineWorkEntry): string {
  // The built-in Preview MCP tools are the agent driving the user's browser;
  // "t3-code · preview_click" describes the transport, not the act.
  const computerControlAction = previewComputerControlAction({
    ...(workEntry.toolTitle !== undefined ? { toolTitle: workEntry.toolTitle } : {}),
    toolData: workEntry.toolData,
  });
  if (computerControlAction !== null) {
    return previewComputerControlHeading(computerControlAction);
  }
  if (!workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
}

const stopRowToggle = (e: { stopPropagation: () => void }) => e.stopPropagation();

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
}) {
  const { workEntry, workspaceRoot } = props;
  const activity = use(TimelineRowActivityCtx);
  const [expanded, setExpanded] = useState(false);
  const iconConfig = workToneIcon(workEntry.tone);
  const showWarningIndicator = workEntry.sourceActivityKind === "runtime.warning";
  const entryIconName = showWarningIndicator ? "x" : workEntryIconName(workEntry);
  const heading = toolWorkEntryHeading(workEntry);
  const rawPreview = workEntryPreview(workEntry, workspaceRoot);
  const preview =
    rawPreview &&
    normalizeCompactToolLabel(rawPreview).toLowerCase() ===
      normalizeCompactToolLabel(heading).toLowerCase()
      ? null
      : rawPreview;
  const displayText = preview ? `${heading} - ${preview}` : heading;
  const expandedBody = buildToolCallExpandedBody(workEntry, workspaceRoot);
  const canExpand = expandedBody !== null;
  const showFailedIndicator = workEntryIndicatesToolFailure(workEntry);
  const showDestructiveRowStyle =
    showFailedIndicator &&
    (workEntry.sourceActivityKind === "runtime.error" || !workLogEntryIsToolLike(workEntry));
  const iconWrapperClass = cn(
    "flex size-5 shrink-0 items-center justify-center",
    showWarningIndicator
      ? "text-destructive"
      : showDestructiveRowStyle
        ? "text-destructive"
        : workEntry.tone === "tool" || showFailedIndicator
          ? "text-muted-foreground/65"
          : iconConfig.className,
  );
  const headingClass = showWarningIndicator
    ? "font-medium text-warning"
    : showDestructiveRowStyle
      ? "font-medium text-destructive"
      : "font-medium text-foreground/82";
  const turnSettled = !activity.activeTurnInProgress;
  const showNeutralIndicator = !turnSettled && workEntryIndicatesToolNeutralStatus(workEntry);
  const showSuccessIndicator =
    workEntryIndicatesToolSuccess(workEntry) ||
    (turnSettled && workEntryIndicatesToolNeutralStatus(workEntry));
  const rowToggleProps = canExpand
    ? {
        role: "button" as const,
        tabIndex: 0 as const,
        "aria-label": displayText,
        onClick: () => setExpanded((v) => !v),
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        },
      }
    : {};

  return (
    <div
      className={cn(
        "flex flex-col rounded-md px-0.5 py-0.5 transition-colors",
        canExpand &&
          "cursor-pointer hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
      )}
      {...rowToggleProps}
    >
      <div className="flex select-none items-center gap-1.5 transition-[opacity,translate] duration-200">
        <span
          className={iconWrapperClass}
          {...(workEntry.sourceActivityKind === "token-optimizer.applied"
            ? { title: "Optimized", "aria-label": "Optimized" }
            : {})}
        >
          <WorkEntryIconSvg
            name={entryIconName}
            className="block size-3.5 shrink-0 stroke-[1.8] opacity-80"
          />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <div className="min-w-0 flex-1 overflow-hidden">
            <p className="flex min-w-0 w-full items-baseline gap-1.5 text-[12px] leading-5">
              <span className={cn("min-w-0 shrink truncate", headingClass)}>{heading}</span>
              {preview && (
                <span className="min-w-0 flex-1 truncate text-muted-foreground/55">{preview}</span>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-px text-muted-foreground/55">
            <span
              className="flex size-4 shrink-0 items-center justify-center"
              aria-hidden={!canExpand}
            >
              {canExpand ? (
                <ChevronDownIcon
                  className={cn(
                    "size-3 shrink-0 opacity-70 transition-transform duration-200",
                    expanded && "rotate-180",
                  )}
                  aria-hidden
                />
              ) : null}
            </span>
            <span className="flex size-4 shrink-0 items-center justify-center">
              {showFailedIndicator ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        className="flex size-4 items-center justify-center"
                        aria-label="Tool call failed"
                      />
                    }
                  >
                    <XIcon className="block size-3 shrink-0 text-destructive" aria-hidden />
                  </TooltipTrigger>
                  <TooltipPopup>Failed</TooltipPopup>
                </Tooltip>
              ) : showSuccessIndicator ? (
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="flex size-4 items-center justify-center" />}
                  >
                    <span className="inline-flex size-4 items-center justify-center">
                      <CheckIcon
                        className="block size-3 shrink-0 stroke-current"
                        stroke="currentColor"
                        aria-hidden
                      />
                    </span>
                  </TooltipTrigger>
                  <TooltipPopup>Completed</TooltipPopup>
                </Tooltip>
              ) : showNeutralIndicator ? (
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="flex size-4 items-center justify-center" />}
                  >
                    <MinusIcon className="block size-3 shrink-0 opacity-70" aria-hidden />
                  </TooltipTrigger>
                  <TooltipPopup>Empty</TooltipPopup>
                </Tooltip>
              ) : null}
            </span>
          </div>
        </div>
      </div>
      {workEntry.readImagePath ? (
        <ToolReadImagePreview
          path={workEntry.readImagePath}
          revision={workEntry.id}
          sourceActivityId={workEntry.readImageSourceActivityId ?? workEntry.id}
          workspaceRoot={workspaceRoot}
        />
      ) : null}
      {expanded && canExpand && expandedBody ? (
        <div
          className="mt-1 ms-7 cursor-default border-s border-border/45 ps-3 pt-0.5"
          onClick={stopRowToggle}
          onPointerDown={stopRowToggle}
        >
          <pre className="max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground select-text">
            {expandedBody}
          </pre>
          {workEntry.tokenOptimizer?.attachments.length ? (
            <TokenOptimizerPages
              attachments={workEntry.tokenOptimizer.attachments}
              revision={workEntry.id}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

function TokenOptimizerPages(props: {
  readonly attachments: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly revision: string;
}) {
  return (
    <div className="mt-2 grid max-w-2xl grid-cols-1 gap-2 sm:grid-cols-2">
      {props.attachments.map((attachment) => (
        <TokenOptimizerPage key={attachment.id} attachment={attachment} revision={props.revision} />
      ))}
    </div>
  );
}

function TokenOptimizerPage(props: {
  readonly attachment: { readonly id: string; readonly name: string };
  readonly revision: string;
}) {
  const ctx = use(TimelineRowCtx);
  const asset = useAssetUrlState(ctx.activeThreadEnvironmentId, {
    _tag: "attachment",
    attachmentId: props.attachment.id,
  });
  const previewUrl = asset._tag === "Success" ? withAssetRevision(asset.url, props.revision) : null;
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const failed = asset._tag === "Failure" || (previewUrl !== null && failedUrl === previewUrl);

  useEffect(() => setFailedUrl(null), [previewUrl]);

  const canOpen = previewUrl !== null && !failed;
  return (
    <button
      type="button"
      className="overflow-hidden rounded-md border border-border/45 bg-black/10 text-left disabled:cursor-default"
      aria-label={`Open optimized page: ${props.attachment.name}`}
      onClick={(event) => {
        event.stopPropagation();
        if (!canOpen || previewUrl === null) return;
        ctx.onImageExpand({
          images: [{ src: previewUrl, name: props.attachment.name }],
          index: 0,
        });
      }}
      onPointerDown={stopRowToggle}
      disabled={!canOpen}
    >
      <span className="flex h-32 w-full items-center justify-center text-muted-foreground">
        {canOpen && previewUrl !== null ? (
          <img
            src={previewUrl}
            alt={props.attachment.name}
            className="block size-full object-contain"
            loading="lazy"
            decoding="async"
            onError={() => setFailedUrl(previewUrl)}
          />
        ) : failed ? (
          <span className="px-3 text-center text-[11px]">Optimized page preview unavailable.</span>
        ) : (
          <LoaderCircleIcon className="size-4 animate-spin" aria-label="Loading optimized page" />
        )}
      </span>
      <span className="block truncate border-t border-border/45 px-2 py-1 text-[10px] text-muted-foreground">
        {props.attachment.name}
      </span>
    </button>
  );
}

function ToolReadImagePreview(props: {
  readonly path: string;
  readonly revision: string;
  readonly sourceActivityId: string;
  readonly workspaceRoot: string | undefined;
}) {
  const ctx = use(TimelineRowCtx);
  const threadRef = ctx.threadRef;
  if (!threadRef) return null;
  return (
    <ToolReadImagePreviewWithThread
      path={props.path}
      revision={props.revision}
      sourceActivityId={props.sourceActivityId}
      workspaceRoot={props.workspaceRoot}
      threadRef={threadRef}
    />
  );
}

function ToolReadImagePreviewWithThread(props: {
  readonly path: string;
  readonly revision: string;
  readonly sourceActivityId: string;
  readonly workspaceRoot: string | undefined;
  readonly threadRef: ScopedThreadRef;
}) {
  const ctx = use(TimelineRowCtx);
  const serverConfig = useAtomValue(
    serverEnvironment.configValueAtom(ctx.activeThreadEnvironmentId),
  );
  const openInPreferredEditor = useOpenInPreferredEditor(
    ctx.activeThreadEnvironmentId,
    serverConfig?.availableEditors ?? [],
  );
  const environment = useEnvironment(ctx.activeThreadEnvironmentId);
  const resource = useMemo(
    () => ({
      _tag: "workspace-file" as const,
      threadId: props.threadRef.threadId,
      path: props.path,
      sourceActivityId: EventId.make(props.sourceActivityId),
    }),
    [props.path, props.sourceActivityId, props.threadRef.threadId],
  );
  const asset = useAssetUrlState(ctx.activeThreadEnvironmentId, resource);
  const previewUrl = asset._tag === "Success" ? withAssetRevision(asset.url, props.revision) : null;
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const displayPath = formatWorkspaceRelativePath(props.path, props.workspaceRoot);
  const resolvedFilePath = useMemo(
    () => resolveLinkedFileAbsolutePath(props.path, props.workspaceRoot),
    [props.path, props.workspaceRoot],
  );
  const workspaceRelativePath = useMemo(() => {
    if (!props.workspaceRoot || !resolvedFilePath) return null;
    const normalizedPath = resolvedFilePath.replaceAll("\\", "/");
    const normalizedRoot = props.workspaceRoot.replaceAll("\\", "/").replace(/\/+$/, "");
    const pathForCompare = normalizedPath.toLowerCase();
    const rootForCompare = normalizedRoot.toLowerCase();
    return pathForCompare.startsWith(`${rootForCompare}/`)
      ? normalizedPath.slice(normalizedRoot.length + 1)
      : null;
  }, [props.workspaceRoot, resolvedFilePath]);
  const failed = asset._tag === "Failure" || (previewUrl !== null && previewUrl === failedUrl);
  const canRevealOnThisDevice =
    typeof window !== "undefined" &&
    window.desktopBridge !== undefined &&
    environment?.entry.target._tag === "PrimaryConnectionTarget" &&
    resolvedFilePath !== null;

  useEffect(() => {
    setFailedUrl(null);
  }, [previewUrl]);

  const handleOpenFile = useCallback(() => {
    if (workspaceRelativePath) {
      useRightPanelStore.getState().openFile(props.threadRef, workspaceRelativePath, undefined);
      return;
    }
    void openInPreferredEditor(resolvedFilePath ?? props.path).then((result) => {
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open file",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
  }, [openInPreferredEditor, props.path, props.threadRef, resolvedFilePath, workspaceRelativePath]);

  const handleRevealFile = useCallback(() => {
    if (!canRevealOnThisDevice || !window.desktopBridge || !resolvedFilePath) return;
    void window.desktopBridge.revealFile(resolvedFilePath).then(
      (revealed) => {
        if (revealed) return;
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to locate file",
            description: "The file no longer exists on this computer.",
          }),
        );
      },
      (cause) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to locate file",
            description: cause instanceof Error ? cause.message : "An error occurred.",
          }),
        );
      },
    );
  }, [canRevealOnThisDevice, resolvedFilePath]);

  const handleCopyPath = useCallback((path: string, label: string) => {
    void navigator.clipboard.writeText(path).then(
      () =>
        toastManager.add({
          type: "success",
          title: `${label} copied`,
          description: path,
        }),
      (cause) =>
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Unable to copy ${label.toLowerCase()}`,
            description: cause instanceof Error ? cause.message : "An error occurred.",
          }),
        ),
    );
  }, []);

  const handlePathContextMenu = useCallback(
    async (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const api = readLocalApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          ...(workspaceRelativePath ? ([{ id: "preview", label: "Open preview" }] as const) : []),
          { id: "editor", label: "Open in editor" },
          ...(canRevealOnThisDevice
            ? ([
                {
                  id: "reveal",
                  label: revealInFileExplorerLabel(navigator.platform),
                },
              ] as const)
            : []),
          ...(workspaceRelativePath
            ? ([{ id: "copy-relative", label: "Copy relative path" }] as const)
            : []),
          { id: "copy-full", label: "Copy full path" },
        ],
        { x: event.clientX, y: event.clientY },
      );
      if (clicked === "preview" && workspaceRelativePath) {
        useRightPanelStore.getState().openFile(props.threadRef, workspaceRelativePath, undefined);
      } else if (clicked === "editor") {
        void openInPreferredEditor(resolvedFilePath ?? props.path);
      } else if (clicked === "reveal") {
        handleRevealFile();
      } else if (clicked === "copy-relative" && workspaceRelativePath) {
        handleCopyPath(workspaceRelativePath, "Relative path");
      } else if (clicked === "copy-full") {
        handleCopyPath(props.path, "Full path");
      }
    },
    [
      canRevealOnThisDevice,
      handleCopyPath,
      handleRevealFile,
      openInPreferredEditor,
      props.path,
      props.threadRef,
      resolvedFilePath,
      workspaceRelativePath,
    ],
  );

  return (
    <div
      className="mt-1 ms-7 max-w-xl cursor-default overflow-hidden rounded-lg border border-border/60 bg-background/55"
      aria-label={`Image read preview: ${displayPath}`}
      onClick={stopRowToggle}
      onPointerDown={stopRowToggle}
    >
      {!failed && asset._tag === "Success" && previewUrl !== null ? (
        <button
          type="button"
          className="block h-48 w-full cursor-zoom-in bg-black/10 sm:h-64"
          aria-label={`Open image preview: ${displayPath}`}
          onClick={(event) => {
            event.stopPropagation();
            ctx.onImageExpand({
              images: [{ src: previewUrl, name: displayPath }],
              index: 0,
            });
          }}
          onPointerDown={stopRowToggle}
        >
          <img
            src={previewUrl}
            alt={displayPath}
            className="block size-full object-contain"
            loading="lazy"
            decoding="async"
            onError={() => setFailedUrl(previewUrl)}
          />
        </button>
      ) : failed ? (
        <div className="flex h-48 items-center justify-center px-4 py-3 text-center text-[11px] text-muted-foreground sm:h-64">
          Image preview unavailable. The file may be missing, too large, or not a valid supported
          image.
        </div>
      ) : (
        <div className="flex h-48 items-center justify-center text-muted-foreground sm:h-64">
          <LoaderCircleIcon className="size-4 animate-spin" aria-label="Loading image preview" />
        </div>
      )}
      <a
        href={props.path}
        className="block truncate border-t border-border/45 px-2.5 py-1.5 font-mono text-[10px] text-muted-foreground/65 transition-colors hover:bg-accent/20 hover:text-foreground hover:underline"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          handleOpenFile();
        }}
        onContextMenu={handlePathContextMenu}
      >
        {displayPath}
      </a>
    </div>
  );
}
