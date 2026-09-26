import { composerDraftMatchesSend, pendingSendMessages } from "./chat/pendingSends";
import { isAgentsProjectId } from "@t3tools/contracts";
import { collectThreadFileReferencesByTurnId } from "@t3tools/client-runtime/state/turn-file-references";
import { canResumeFailedThreadSession } from "@t3tools/client-runtime/state/thread-activity";
import { QueuedMessageCountdown } from "./chat/QueuedMessageCountdown";
import {
  OfflineOutboxChip,
  type OfflineOutboxMessage,
  useOfflineOutboxChipPhase,
} from "./chat/OfflineOutbox";
import { QueuedMessagesPanel } from "./chat/QueuedMessagesPanel";
import {
  HELD_MESSAGE_PREFIX,
  isHeldMessageId,
  removedHeldMessageIds,
} from "@t3tools/shared/heldMessages";
import { isSideChatSessionPreparing } from "@t3tools/client-runtime/state/thread-activity";
import {
  type ApprovalRequestId,
  CommandId,
  DEFAULT_MODEL,
  defaultInstanceIdForDriver,
  type EnvironmentId,
  MessageId,
  type OrchestrationMessage,
  type OrchestrationThreadHistoryWindow,
  type ModelSelection,
  type ProjectScript,
  type ProjectId,
  type ProviderAccountSwitchState,
  type ProviderApprovalDecision,
  ProviderInstanceId,
  type ServerProvider,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  type ThreadArtifactSummary,
  ThreadId,
  type TurnId,
  type KeybindingCommand,
  OrchestrationThreadActivity,
  type OrchestrationMessageInputOrigin,
  ProviderInteractionMode,
  ProviderDriverKind,
  RuntimeTaskId,
  RuntimeMode,
  TerminalOpenInput,
} from "@t3tools/contracts";
import {
  connectionStatusTitle,
  type EnvironmentConnectionPresentation,
} from "@t3tools/client-runtime/connection";
import { effectiveSettled, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  applyClaudePromptEffortPrefix,
  createModelSelection,
  resolvePromptInjectedEffort,
} from "@t3tools/shared/model";
import {
  scriptsForThread,
  projectScriptCwd,
  projectScriptRuntimeEnv,
} from "@t3tools/shared/projectScripts";
import { truncate } from "@t3tools/shared/String";
import { buildSettingsUpdatePrompt } from "@t3tools/shared/settingsPrompt";
import { nextTerminalId, resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabels";
import { providerDriverLaunchCommand } from "@t3tools/shared/terminalProvider";
import { useProviderSignInRequestStore } from "../providerSignInRequestStore";
import { Debouncer } from "@tanstack/react-pacer";
import { useAtomValue } from "@effect/atom-react";
import {
  type ComponentProps,
  lazy,
  memo,
  type DragEvent as ReactDragEvent,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { useNavigate } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { isElectron } from "../env";
import * as Option from "effect/Option";
import { readLocalApi } from "../localApi";
import { useDiffPanelStore } from "../diffPanelStore";
import {
  canReferenceLocalComposerFiles,
  parseStandaloneComposerSlashCommand,
} from "../composer-logic";
import { shouldTranscribeStoppedRecording } from "../pushToTalkTranscription";
import { takePendingTranscriptionToast } from "../voiceTranscriptionHandoff";
import {
  dismissVoiceTranscriptionResult,
  finishVoiceTranscriptionBackgroundTask,
  isBackgroundTaskActive,
  startVoiceTranscriptionBackgroundTask,
  useBackgroundTaskStore,
} from "../backgroundTasks";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  derivePhase,
  deriveTimelineEntries,
  deriveActiveWorkStartedAt,
  deriveActivePlanState,
  findSidebarProposedPlan,
  findLatestProposedPlan,
  deriveWorkLogEntries,
  hasActionableProposedPlan,
  isLatestTurnSettled,
} from "../session-logic";
import { type LegendListRef } from "@legendapp/list/react";
import {
  rememberTimelineThreadScroll,
  resolveTimelineScrollSnapshotFollowEnd,
  resolveTimelineSendScrollPlan,
  shouldResumeTimelineLiveFollow,
  type TimelineThreadScrollMemory,
  type TimelineScrollMode,
} from "./chat/timelineScrollAnchoring";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
import {
  buildAgentAnswers,
  isAgentMode,
  isAutoResumePendingWork,
  shouldAnnounceAgentAutoResume,
} from "../agentMode";
import { isGitInitRequestReady, useGitInitRequestStore } from "../gitInitRequest";
import {
  applyProviderTaskDismissals,
  deriveProviderTasks,
  confirmDestructiveSend,
  describeSendOverRunningTasks,
  isProviderTaskActive,
} from "../providerTasks";
import { useProviderTaskDismissalStore } from "../providerTaskDismissalStore";
import {
  deriveDeliveredMessageIds,
  derivePromotedQueuedMessageIds,
  deriveUnsentMessage,
  expandDeliveredMessageIds,
} from "../messageDelivery";
import { ProviderTaskPanel } from "./ProviderTaskPanel";
import { useUiStateStore } from "../uiStateStore";
import {
  buildPlanImplementationThreadTitle,
  buildPlanImplementationPrompt,
  resolvePlanFollowUpSubmission,
} from "../proposedPlan";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_THREAD_TERMINAL_ID,
  BROWSER_PANE_ID,
  isBrowserPaneId,
  MAX_TERMINALS_PER_GROUP,
  type ChatMessage,
  type SessionPhase,
  type Thread,
  type TurnDiffSummary,
} from "../types";
import { useTheme } from "../hooks/useTheme";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useOnScreenKeyboard } from "../hooks/useOnScreenKeyboard";
import { shouldOfferAppVoiceCapture } from "./chat/appVoiceCaptureAvailability";
import {
  composerViewportBottomInset,
  resolveChatFooterLayout,
  resolvePhoneKeyboardInset,
  shouldDockPhoneDraftComposer,
} from "./chat/mobileComposerViewport";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import {
  resolveRightPanelThreadFocus,
  selectActiveRightPanel,
  THREAD_TERMINAL_SURFACE_ID,
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  type RightPanelSurface,
  useRightPanelStore,
} from "../rightPanelStore";
import {
  isPreviewSupportedInRuntime,
  setActivePreviewTab,
  useThreadPreviewState,
  type DesktopPreviewOverlay,
} from "../previewStateStore";
import { sendWouldStopBackgroundWork, shouldHoldComposerSend } from "./chat/composerSendQueue";
import { heldMessageQueue } from "./chat/heldMessageQueue";
import { addBrowserSurface } from "./preview/addBrowserSurface";
import { closePreviewSession } from "./preview/closePreviewSession";
import { previewControllerFromAgentControl } from "./preview/previewTabAgentIndicator";
import { ThreadPreviewMiniPlayer } from "./preview/ThreadPreviewMiniPlayer";
import { RightPanelAutoCollapseOnEmpty } from "./RightPanelAutoCollapseOnEmpty";
import { PreviewDownloadDirectorySync } from "./preview/PreviewDownloadDirectorySync";
import { subscribePreviewAction } from "./preview/previewActionBus";
import { getConfiguredPreviewUrls } from "./preview/previewEmptyStateLogic";
import { PreviewSessionHydrator } from "./preview/PreviewSessionHydrator";
import {
  PreviewDownloadApprovalActions,
  previewDownloadApprovalSource,
} from "./preview/PreviewDownloadApprovalPrompt";
import { reconcileHydratedBrowserSurfaces } from "./preview/reconcileHydratedBrowserSurfaces";
import {
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
} from "../previewMiniPlayerStore";
import { RightPanelTabs, type SideChatTabStatus } from "./RightPanelTabs";
import {
  ThreadArtifactDeepLinkOpener,
  ThreadArtifactMenu,
  ThreadArtifactShelf,
} from "./artifacts/ThreadArtifactShelf";
import { ThreadArtifactSurface } from "./artifacts/ThreadArtifactSurface";
import { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";
import { BranchToolbar } from "./BranchToolbar";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import PlanSidebar from "./PlanSidebar";
import {
  AlarmClockIcon,
  ArrowUpRightIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  DownloadIcon,
  GitBranchIcon,
  LoaderCircleIcon,
  LogInIcon,
  MessageSquareIcon,
  MicIcon,
  PencilIcon,
  RotateCcwIcon,
  SendHorizontalIcon,
  TriangleAlertIcon,
  WifiOffIcon,
  XIcon,
} from "lucide-react";
import { cn, randomHex } from "~/lib/utils";
import {
  getSpeechRecognitionConstructor,
  shouldPreferNativeSpeechDictation,
  startNativeSpeechDictation,
  type NativeSpeechDictationSession,
} from "~/speechDictation";

import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { prependWaitingOnYouReply } from "@t3tools/shared/agentAttentionFollowUp";
import { resolveBlockedSend, resolveSendDisabledReason } from "./ChatView.logic";
import { WaitingOnYouComposerTag } from "./agents/WaitingOnYouComposerTag";
import {
  detachWaitingOnYou,
  getWaitingOnYouAttachment,
  useWaitingOnYouAttachment,
} from "./agents/waitingOnYouAttachment";
import { decodeProjectScriptKeybindingRule } from "~/lib/projectScriptKeybindings";
import {
  ProjectScriptsControlForProject,
  type NewProjectScriptInput,
} from "./ProjectScriptsControl";
import {
  buildProjectScript,
  commandForProjectScript,
  nextProjectScriptId,
  projectScriptIdFromCommand,
} from "~/projectScripts";
import { newCommandId, newDraftId, newMessageId, newThreadId } from "~/lib/utils";
import {
  formatProviderDriverKindLabel,
  getProviderModelCapabilities,
  resolveSelectableProvider,
} from "../providerModels";
import { NO_PROVIDER_MODEL_SELECTION } from "../providerInstances";
import { getClientSettings, useClientSettings, useEnvironmentSettings } from "../hooks/useSettings";
import { useNowMinute } from "../hooks/useNowMinute";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import {
  resolveAppModelSelectionForInstance,
  selectAppModelWithHighEffort,
} from "../modelSelection";
import { getTerminalFocusOwner } from "../lib/terminalFocus";
import { isPreviewFocused } from "../lib/previewFocus";
import { resolveNewDraftStartFromOrigin } from "../lib/chatThreadActions";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "../threadRoutes";
import {
  type ComposerImageAttachment,
  type DraftThreadEnvMode,
  markPromotedDraftThreadByRef,
  useComposerDraftModelState,
  useComposerDraftStore,
  type DraftId,
} from "../composerDraftStore";
import { microphoneConstraints } from "../orchestrator/voiceIsolation";
import {
  appendTerminalContextsToPrompt,
  formatTerminalContextLabel,
  type TerminalContextDraft,
  type TerminalContextSelection,
} from "../lib/terminalContext";
import {
  appendElementContextsToPrompt,
  type ElementContextDraft,
  formatElementContextLabel,
} from "../lib/elementContext";
import { appendPreviewAnnotationPrompt } from "../lib/previewAnnotation";
import { appendReviewCommentsToPrompt, type ReviewCommentContext } from "../reviewCommentContext";
import { appendInterruptedTasksNotice } from "../lib/interruptedTasksNotice";
import { environmentCatalog } from "../connection/catalog";
import {
  PHONE_TERMINAL_LAYOUT_MEDIA_QUERY,
  resolveTerminalModeFullscreen,
} from "../terminalModeLayout";
import {
  localTerminalGroupsToRemote,
  selectThreadTerminalUiState,
  useTerminalUiStateStore,
} from "../terminalUiStateStore";
import {
  useKnownTerminalSessions,
  useTerminalMetadataLoaded,
  useThreadRunningTerminalIds,
} from "../state/terminalSessions";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import {
  primaryServerAvailableEditorsAtom,
  primaryServerKeybindingsAtom,
  primaryServerSettingsAtom,
  serverEnvironment,
} from "../state/server";
import { terminalEnvironment } from "../state/terminal";
import { loadThreadHistory, threadEnvironment, useEnvironmentThread } from "../state/threads";
import { vcsEnvironment } from "../state/vcs";
import { useEnvironments, usePrimaryEnvironment } from "../state/environments";
import {
  useProject,
  useProjects,
  useThread,
  useThreadDetail,
  useThreadProposedPlans,
  useThreadShell,
  useThreadShells,
  useThreadStatus,
  readEnvironmentSupportsSideChats,
} from "../state/entities";
import { environmentShell } from "../state/shell";
import { ChatComposer, type ChatComposerHandle } from "./chat/ChatComposer";
import { RenderErrorBoundary } from "./RenderErrorBoundary";
import { ComposerStatusRail } from "./chat/ComposerStatusRail";
import { useTerminalLayoutSync } from "../hooks/useTerminalLayoutSync";
import type { TerminalLaunchProvider } from "./terminal/TerminalLaunchPad";
import { useThreadActions } from "../hooks/useThreadActions";
import {
  deriveWorkingSideChatsByParent,
  isSideChatActivelyWorking,
  sideChatDisplayTitle,
  sideChatParentActivityKey,
} from "../sideChat";
import { useStartupResumeStore } from "../startupResumeStore";
import { isStartupAutoResumeStalled } from "./StartupResumeCoordinator.logic";
import { ProviderAccountSwitchConfirmation } from "./chat/ProviderAccountSwitchConfirmation";
import { ProviderApiKeyAccountDialog } from "./settings/ProviderApiKeyAccounts";
import {
  isProviderAccountSwitchActive,
  reconcileProviderAccountSwitch,
} from "./chat/providerAccountSwitchState";
import { ProviderAccountSwitchOverlay } from "./chat/ProviderAccountSwitchOverlay";
import { DraftHeroHeadline } from "./chat/DraftHeroHeadline";
import { ExpandedImageDialog } from "./chat/ExpandedImageDialog";
import { PullRequestThreadDialog } from "./PullRequestThreadDialog";
import { MessagesTimeline } from "./chat/MessagesTimeline";
import {
  deriveResumableAssistantMessageId,
  deriveResumableRuntimeErrorActivityId,
} from "./chat/MessagesTimeline.logic";
import { ChatHeader } from "./chat/ChatHeader";
import { TerminalSessionIcon } from "./chat/TerminalSessionIcon";
import { SideChatSessionIcon } from "./chat/SideChatSessionIcon";
import { deriveWorkingTerminalActivity } from "../terminalActivity";
import { PanelLayoutControls, RightPanelMaximizeControl } from "./chat/PanelLayoutControls";
import {
  ExpandedImagePreviewProvider,
  type ExpandedImagePreview,
} from "./chat/ExpandedImagePreview";
import { THIN_PORTRAIT_MOBILE_MEDIA_QUERY } from "./chat/mobileImageViewer";
import { NoActiveThreadState, SideChatLoadingState } from "./NoActiveThreadState";
import { resolveEffectiveEnvMode, resolveLocalCheckoutBranchMismatch } from "./BranchToolbar.logic";
import {
  getProviderStatusBannerKey,
  ProviderStatusBanner,
  shouldShowProviderStatusBanner,
} from "./chat/ProviderStatusBanner";
import { isHostRepairEligibleThreadError, ThreadErrorBanner } from "./chat/ThreadErrorBanner";
import { resolveThreadPr } from "./ThreadStatusIndicators";
import { ComposerBannerStack, type ComposerBannerStackItem } from "./chat/ComposerBannerStack";
import { ProjectFolderMissingBanner } from "./chat/ProjectFolderMissingBanner";
import { UsageGuardPausedBanner } from "./chat/UsageGuardPausedBanner";
import { ProviderFailoverBanner } from "./chat/ProviderFailoverBanner";
import {
  findProviderFailoverNotice,
  isProviderFailoverActive,
} from "./chat/providerFailoverNotice";
import { findUsageGuardPauseNotice, isUsageGuardPauseActive } from "./chat/usageGuardPause";
import {
  isProviderAuthenticationPauseActive,
  resolveThreadProviderAuthStatus,
} from "./chat/providerAuthPause";
import { ThreadSyncOverlay } from "./chat/ThreadSyncStatusPill";
import {
  deriveProviderUsageReports,
  ProviderUsageBar,
  ProviderUsagePlacementRow,
  providerUsageDetailsSide,
  resolveProviderUsagePlacement,
} from "./chat/ProviderUsageBar";
import { useProviderUsageStore } from "../providerUsageStore";
import {
  DRAFT_HERO_TRANSITION_ANIMATION_ID,
  DRAFT_HERO_TRANSITION_DURATION_MS,
  DRAFT_HERO_TRANSITION_EASING,
  MOBILE_COMPOSER_VIEW_TRANSITION_NAME,
  MOBILE_DRAFT_HEADLINE_VIEW_TRANSITION_NAME,
  runMobileComposerTransition,
} from "./chat/draftHeroTransition";
import {
  authoritativeThreadSettingsFingerprint,
  branchMismatchKey,
  buildExpiredTerminalContextToastCopy,
  buildLocalDraftThread,
  buildLoadingThreadFromShell,
  buildThreadTurnInterruptInput,
  canQueueLocalMessageDuringReconnect,
  collectUserMessageBlobPreviewUrls,
  createLocalDispatchSnapshot,
  deriveActiveSessionProviderDriver,
  deriveComposerSendState,
  deriveQueuedGrokMessageIds,
  isHeldMessageStillQueued,
  wasHeldMessageDelivered,
  expireStaleQueuedMessagePromotion,
  nextQueuedMessageToPromote,
  queuedMessageAutoPromoteDelayMs,
  QUEUED_MESSAGE_PROMOTION_STALE_MS,
  dismissBranchMismatchForSession,
  hasServerAcknowledgedLocalDispatch,
  isBranchMismatchDismissedForSession,
  isSteerWaitingBehindSubagent,
  isThreadAlreadyExistsError,
  describePendingTurnStart,
  isThreadWorkInterruptible,
  shouldShowBranchMismatchBanner,
  shouldCreateServerThreadForTerminalStart,
  shouldPersistComposerModelDefaults,
  LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
  LastInvokedScriptByProjectSchema,
  type LocalDispatchSnapshot,
  PullRequestDialogState,
  type QueuedMessagePromotionPhases,
  runQueuedMessagePromotion,
  runResumeIncompleteTurn,
  cloneComposerImageForRetry,
  deriveLockedProvider,
  retainClosingSideChatThreadIds,
  shouldAutoFocusComposerOnThreadOpen,
  shouldRestoreComposerFocus,
  resolveDraftThreadCreateModelSelection,
  resolveSendEnvMode,
  revokeBlobPreviewUrl,
  revokeUserMessagePreviewUrls,
  settleQueuedMessagePromotion,
  shouldWriteThreadErrorToCurrentServerThread,
  resolveVisibleServerThreadError,
  startNewThreadForProject,
} from "./ChatView.logic";
import { createVoiceNoteDraft, prepareComposerAttachmentsForSend } from "../voiceNote";
import { runCompactAndContinue } from "../lib/lowContextWarning";
import { resolveThreadSyncPhase, threadSyncBlocksSend, type ThreadSyncPhase } from "../threadSync";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useComposerHandleContext } from "../composerHandleContext";
import { sanitizeThreadErrorMessage } from "~/rpc/transportError";
import { createProviderUsageRefreshCoordinator } from "./settings/providerUsageRefresh";
import { RightPanelSheet } from "./RightPanelSheet";
import { previewEnvironment } from "../state/preview";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { ServerUpdateAction } from "./ServerUpdateAction";
import {
  buildVersionMismatchDismissalKey,
  dismissVersionMismatch,
  isVersionMismatchDismissed,
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  resolveVersionSkewDirection,
  versionSkewGuidance,
} from "../versionSkew";
import { useAssetUrls } from "../assets/assetUrls";
import {
  cancelActiveTranscription,
  cueThenMuteSystemAudio,
  isPushToTalkReleaseEvent,
  isPushToTalkShortcut,
  isTranscriptionCancellationError,
  playRecordingStartCue,
  restorePushToTalkFocus,
  resolveVisiblePushToTalkStatus,
  shouldHandlePushToTalkForSurface,
  shouldRouteTranscriptToTerminal,
  startRecorderWithCue,
  transcribeRecordedAudio,
} from "../pushToTalk";
import {
  buildVoiceTranscriptConversationContext,
  cancelActiveVoiceTranscriptCorrection,
  correctVoiceTranscriptWithFallback,
} from "../voiceTranscriptCorrection";
import { resolveVoiceCuePolicy } from "../orchestrator/voiceCues";

const ThreadTerminalDrawer = lazy(() => import("./ThreadTerminalDrawer"));

function ThreadTerminalDrawerMount(props: ComponentProps<typeof ThreadTerminalDrawer>) {
  return (
    <Suspense fallback={null}>
      <RenderErrorBoundary
        fallback={
          <div className="flex h-full min-h-0 items-center justify-center px-4 text-center text-sm text-muted-foreground">
            Couldn’t load the terminal. Close it and open it again.
          </div>
        }
      >
        <ThreadTerminalDrawer {...props} />
      </RenderErrorBoundary>
    </Suspense>
  );
}

interface PushToTalkTerminalTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly terminalId: string;
}

function VoiceTranscriptionStatusChip({
  status,
  label,
}: {
  readonly status: "recording" | "loading" | "transcribing" | "refining";
  readonly label: string | null;
}) {
  return (
    <button
      aria-label={
        status === "recording" ? (label ?? undefined) : `${label} Cancel voice transcription.`
      }
      className="chat-composer-status-chip pointer-events-auto flex items-center gap-1.5 rounded-full border border-border bg-background/95 px-2.5 py-1 text-xs font-medium text-muted-foreground  disabled:cursor-default"
      data-chat-composer-status-chip="voice"
      disabled={status === "recording"}
      onClick={() => {
        cancelActiveTranscription();
        cancelActiveVoiceTranscriptCorrection();
      }}
      role="status"
      aria-live="polite"
      title={status === "recording" ? undefined : "Cancel voice transcription"}
      type="button"
    >
      {status === "recording" ? (
        <MicIcon aria-hidden className="size-3" />
      ) : (
        <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
      )}
      <span aria-hidden className="chat-composer-status-label-full">
        {label}
      </span>
      <span aria-hidden className="chat-composer-status-label-compact">
        {status === "recording"
          ? "Listening…"
          : status === "loading"
            ? "Loading…"
            : status === "transcribing"
              ? "Transcribing…"
              : "Refining…"}
      </span>
      <span aria-hidden className="chat-composer-status-label-minimal">
        {status === "recording"
          ? "Live"
          : status === "loading"
            ? "Loading"
            : status === "transcribing"
              ? "Text"
              : "Refine"}
      </span>
      {status === "recording" ? null : (
        <span aria-hidden className="text-base leading-none text-foreground/75">
          ×
        </span>
      )}
    </button>
  );
}

const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";
const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
const EMPTY_PROVIDERS: ServerProvider[] = [];
const EMPTY_PROVIDER_SKILLS: ServerProvider["skills"] = [];
const EMPTY_PROVIDER_SLASH_COMMANDS: ServerProvider["slashCommands"] = [];
const EMPTY_PENDING_USER_INPUT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};
// Leave encoder finalization headroom below the host's strict two-minute limit.
const PUSH_TO_TALK_MAX_RECORDING_MS = 119_000;

type SideChatSurface = Extract<RightPanelSurface, { kind: "side-chat" }>;

interface PendingSideChatArchive {
  readonly parentThreadRef: ScopedThreadRef;
  readonly surface: SideChatSurface;
}

const observedAuthoritativeThreadSettings = new Map<string, string>();
const timelineThreadScrollMemory = new Map<string, TimelineThreadScrollMemory>();
function useDraftHeroLayoutTransition(isDraftHeroState: boolean) {
  const transitionGroupRef = useRef<HTMLDivElement | null>(null);
  const composerAnchorRef = useRef<HTMLDivElement | null>(null);
  const previousStateRef = useRef(isDraftHeroState);
  const previousComposerRectRef = useRef<DOMRect | null>(null);
  const animationRef = useRef<Animation | null>(null);
  const attachTransitionGroupRef = (element: HTMLDivElement | null) => {
    transitionGroupRef.current = element;
  };
  const attachComposerAnchorRef = (element: HTMLDivElement | null) => {
    composerAnchorRef.current = element;
  };
  const captureComposerRect = () => {
    previousComposerRectRef.current = composerAnchorRef.current?.getBoundingClientRect() ?? null;
  };

  useLayoutEffect(() => {
    const transitionGroup = transitionGroupRef.current;
    const nextComposerRect = composerAnchorRef.current?.getBoundingClientRect() ?? null;
    const stateChanged = previousStateRef.current !== isDraftHeroState;
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const mobileComposerTransitionActive =
      typeof document !== "undefined" &&
      document.documentElement.dataset.mobileComposerRouteTransition === "true";

    animationRef.current?.cancel();
    animationRef.current = null;

    const previousComposerRect = previousComposerRectRef.current;
    if (
      stateChanged &&
      !prefersReducedMotion &&
      !mobileComposerTransitionActive &&
      transitionGroup &&
      previousComposerRect &&
      nextComposerRect &&
      typeof transitionGroup.animate === "function"
    ) {
      const translateX = previousComposerRect.left - nextComposerRect.left;
      const translateY = previousComposerRect.top - nextComposerRect.top;
      if (Math.abs(translateX) >= 0.5 || Math.abs(translateY) >= 0.5) {
        const animation = transitionGroup.animate(
          [
            { transform: `translate3d(${translateX}px, ${translateY}px, 0)` },
            { transform: "translate3d(0, 0, 0)" },
          ],
          {
            duration: DRAFT_HERO_TRANSITION_DURATION_MS,
            easing: DRAFT_HERO_TRANSITION_EASING,
          },
        );
        animation.id = DRAFT_HERO_TRANSITION_ANIMATION_ID;
        animationRef.current = animation;
        void animation.finished
          .catch(() => undefined)
          .then(() => {
            if (animationRef.current !== animation) {
              return;
            }
            animationRef.current = null;
          });
      }
    }

    previousStateRef.current = isDraftHeroState;
    previousComposerRectRef.current = nextComposerRect;
  }, [isDraftHeroState]);

  return [attachTransitionGroupRef, attachComposerAnchorRef, captureComposerRect] as const;
}
const PreviewPanel = lazy(() =>
  import("./preview/PreviewPanel").then((module) => ({ default: module.PreviewPanel })),
);
const DiffPanel = lazy(() => import("./DiffPanel"));
const FilePreviewPanel = lazy(() => import("./files/FilePreviewPanel"));
const EMPTY_PENDING_FILE_SURFACE_IDS: ReadonlySet<string> = new Set();
const TYPE_TO_FOCUS_EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
].join(",");
const TYPE_TO_FOCUS_INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "summary",
  '[role="button"]',
  '[role="checkbox"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
].join(",");
const TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR = [
  '[data-slot="dialog"]',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="popover-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
].join(",");
/**
 * Typing that belongs to the collaborative browser must never be stolen.
 * Electron re-dispatches guest keyboard events on the embedder with the
 * <webview> element as the target, so the type-to-focus redirect saw a
 * printable key, inserted it into the composer, and preventDefault()ed the
 * guest delivery — making it impossible to type into any page input (the
 * composer swallowed every character). The activeElement check covers the
 * same steal when the re-dispatched event carries an empty composed path.
 */
const TYPE_TO_FOCUS_BROWSER_SURFACE_SELECTOR = "webview,[data-preview-viewport]";

type EnvironmentUnavailableState = {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: EnvironmentConnectionPresentation;
};

type ThreadPlanCatalogEntry = Pick<Thread, "id" | "proposedPlans">;

function eventPathContainsSelector(event: Event, selector: string): boolean {
  const path = event.composedPath();
  if (path.length === 0 && event.target) {
    path.push(event.target);
  }
  return path.some((target) => target instanceof Element && target.closest(selector));
}

function shouldTypeToFocusComposer(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing) return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.key.length !== 1) return false;

  if (eventPathContainsSelector(event, TYPE_TO_FOCUS_EDITABLE_SELECTOR)) return false;
  if (eventPathContainsSelector(event, TYPE_TO_FOCUS_INTERACTIVE_SELECTOR)) return false;
  if (eventPathContainsSelector(event, TYPE_TO_FOCUS_BROWSER_SURFACE_SELECTOR)) return false;
  const activeElement = document.activeElement;
  if (
    activeElement instanceof Element &&
    (activeElement.tagName.toUpperCase() === "WEBVIEW" ||
      activeElement.closest(TYPE_TO_FOCUS_BROWSER_SURFACE_SELECTOR) !== null)
  ) {
    return false;
  }
  if (document.querySelector(TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR)) return false;

  return true;
}

function formatOutgoingPrompt(params: {
  provider: ProviderDriverKind;
  model: string | null;
  models: ReadonlyArray<ServerProvider["models"][number]>;
  effort: string | null;
  text: string;
}): string {
  const caps = getProviderModelCapabilities(params.models, params.model, params.provider);
  const promptEffort = resolvePromptInjectedEffort(caps, params.effort);
  return applyClaudePromptEffortPrefix(params.text, promptEffort);
}
const SCRIPT_TERMINAL_COLS = 120;
const SCRIPT_TERMINAL_ROWS = 30;

type ChatViewProps =
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      onDiffPanelOpen?: () => void;
      reserveTitleBarControlInset?: boolean;
      forceExpandedMobileComposer?: boolean;
      embeddedSideChat?: boolean;
      hideWorkspaceHeader?: boolean;
      projectScriptsPortalTarget?: HTMLElement | null;
      /** Agent threads: Browser, Terminal, and Side Chat live in the right panel. */
      agentSurfaces?: boolean;
      /** Agent alert rendered at the live end of the real chat timeline. */
      inlineTimelineNotice?: { readonly id: string; readonly content: ReactNode } | null;
      threadSyncPhase?: ThreadSyncPhase | null;
      artifactId?: string;
      routeKind: "server";
      draftId?: never;
    }
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      onDiffPanelOpen?: () => void;
      reserveTitleBarControlInset?: boolean;
      forceExpandedMobileComposer?: boolean;
      embeddedSideChat?: boolean;
      hideWorkspaceHeader?: boolean;
      projectScriptsPortalTarget?: HTMLElement | null;
      agentSurfaces?: boolean;
      inlineTimelineNotice?: { readonly id: string; readonly content: ReactNode } | null;
      threadSyncPhase?: never;
      artifactId?: never;
      routeKind: "draft";
      draftId: DraftId;
    };

interface TerminalLaunchContext {
  threadId: ThreadId;
  cwd: string;
  worktreePath: string | null;
}

type PersistentTerminalLaunchContext = Pick<TerminalLaunchContext, "cwd" | "worktreePath">;

function useLocalDispatchState(input: {
  activeThread: Thread | undefined;
  activeLatestTurn: Thread["latestTurn"] | null;
  phase: SessionPhase;
  activePendingApproval: ApprovalRequestId | null;
  activePendingUserInput: ApprovalRequestId | null;
  threadError: string | null | undefined;
}) {
  const [localDispatch, setLocalDispatch] = useState<LocalDispatchSnapshot | null>(null);
  const latestUserMessageId =
    input.activeThread?.messages.findLast((message) => message.role === "user")?.id ?? null;

  const resetLocalDispatch = useCallback(() => {
    setLocalDispatch(null);
  }, []);

  const serverAcknowledgedLocalDispatch = useMemo(
    () =>
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: input.phase,
        latestTurn: input.activeLatestTurn,
        latestUserMessageId,
        session: input.activeThread?.session ?? null,
        hasPendingApproval: input.activePendingApproval !== null,
        hasPendingUserInput: input.activePendingUserInput !== null,
        threadError: input.threadError,
      }),
    [
      input.activeLatestTurn,
      input.activePendingApproval,
      input.activePendingUserInput,
      input.activeThread?.session,
      input.phase,
      input.threadError,
      latestUserMessageId,
      localDispatch,
    ],
  );
  const activeLocalDispatch = serverAcknowledgedLocalDispatch ? null : localDispatch;
  const beginLocalDispatch = useCallback(
    (options?: { preparingWorktree?: boolean }) => {
      const preparingWorktree = Boolean(options?.preparingWorktree);
      setLocalDispatch((current) => {
        const active = serverAcknowledgedLocalDispatch ? null : current;
        if (active) {
          return active.preparingWorktree === preparingWorktree
            ? active
            : { ...active, preparingWorktree };
        }
        return createLocalDispatchSnapshot(input.activeThread, options);
      });
    },
    [input.activeThread, serverAcknowledgedLocalDispatch],
  );

  return {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt: activeLocalDispatch?.startedAt ?? null,
    isPreparingWorktree: activeLocalDispatch?.preparingWorktree ?? false,
    isSendBusy: activeLocalDispatch !== null,
  };
}

interface PersistentThreadTerminalDrawerProps {
  threadRef: { environmentId: EnvironmentId; threadId: ThreadId };
  threadId: ThreadId;
  paneLayout?: "split" | "tabs";
  tabStripTrailing?: ReactNode;
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
  visible: boolean;
  launchContext: PersistentTerminalLaunchContext | null;
  focusRequestId: number;
  splitShortcutLabel: string | undefined;
  splitVerticalShortcutLabel: string | undefined;
  newShortcutLabel: string | undefined;
  closeShortcutLabel: string | undefined;
  keybindings: ResolvedKeybindingsConfig;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
}

const EMPTY_PERSISTED_TERMINAL_IDS: readonly string[] = [];

const PersistentThreadTerminalDrawer = memo(function PersistentThreadTerminalDrawer({
  threadRef,
  threadId,
  paneLayout,
  tabStripTrailing,
  fullscreen,
  onToggleFullscreen,
  visible,
  launchContext,
  focusRequestId,
  splitShortcutLabel,
  splitVerticalShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  keybindings,
  onAddTerminalContext,
}: PersistentThreadTerminalDrawerProps) {
  const openTerminal = useAtomCommand(terminalEnvironment.open, "terminal open");
  const publishTerminalLayout = useAtomCommand(
    terminalEnvironment.setLayout,
    "terminal launch layout",
  );
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "terminal write");
  const closeTerminalMutation = useAtomCommand(terminalEnvironment.close, "terminal close");
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const serverThread = useThread(threadRef, { waitForShell: draftThread !== null });
  const projectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const project = useProject(projectRef);
  const terminalUiState = useTerminalUiStateStore((state) =>
    selectThreadTerminalUiState(state.terminalUiStateByThreadKey, threadRef),
  );
  const knownTerminalSessions = useKnownTerminalSessions({
    environmentId: threadRef.environmentId,
    threadId,
  });
  const terminalMetadataLoaded = useTerminalMetadataLoaded(threadRef.environmentId);
  const terminalThreadStateKey = useMemo(() => scopedThreadKey(threadRef), [threadRef]);
  const suppressedTerminalIds = useTerminalUiStateStore(
    (state) =>
      state.suppressedTerminalIdsByThreadKey[terminalThreadStateKey] ??
      EMPTY_PERSISTED_TERMINAL_IDS,
  );
  const closeRetriesInFlightRef = useRef(new Set<string>());
  useEffect(() => {
    if (!terminalMetadataLoaded || suppressedTerminalIds.length === 0) {
      return;
    }
    const serverTerminalIds = new Set(
      knownTerminalSessions.map((session) => session.target.terminalId),
    );
    for (const terminalId of suppressedTerminalIds) {
      if (!serverTerminalIds.has(terminalId) || closeRetriesInFlightRef.current.has(terminalId)) {
        continue;
      }
      closeRetriesInFlightRef.current.add(terminalId);
      void closeTerminalMutation({
        environmentId: threadRef.environmentId,
        input: { threadId, terminalId, deleteHistory: true },
      }).finally(() => {
        closeRetriesInFlightRef.current.delete(terminalId);
      });
    }
  }, [
    closeTerminalMutation,
    knownTerminalSessions,
    suppressedTerminalIds,
    terminalMetadataLoaded,
    threadId,
    threadRef.environmentId,
  ]);
  // Every terminal in the thread, including the ones the right panel is
  // showing. The two surfaces used to partition this list — a terminal open in
  // the panel was filtered out of the terminals view and vice versa — so the
  // same thread showed two different sets depending on where you looked. They
  // are one list now, and the panel renders it as tabs.
  const drawerTerminalSessions = knownTerminalSessions;
  const terminalLabelsById = useMemo(() => {
    const next = new Map<string, string>();
    for (const session of drawerTerminalSessions) {
      next.set(
        session.target.terminalId,
        resolveTerminalSessionLabel(session.target.terminalId, session.state.summary),
      );
    }
    next.set(BROWSER_PANE_ID, "Browser");
    return next;
  }, [drawerTerminalSessions]);
  const terminalLaunchLocationsById = useMemo(() => {
    const next = new Map<
      string,
      {
        readonly cwd: string;
        readonly worktreePath: string | null;
        readonly runtimeEnv: Record<string, string>;
      }
    >();
    if (!project) {
      return next;
    }

    for (const session of drawerTerminalSessions) {
      const summary = session.state.summary;
      if (!summary) {
        continue;
      }
      const worktreePathForLaunch =
        launchContext !== null ? launchContext.worktreePath : summary.worktreePath;
      next.set(session.target.terminalId, {
        cwd: launchContext?.cwd ?? summary.cwd,
        worktreePath: worktreePathForLaunch,
        runtimeEnv: projectScriptRuntimeEnv({
          project: { cwd: project.workspaceRoot },
          worktreePath: worktreePathForLaunch,
        }),
      });
    }

    return next;
  }, [drawerTerminalSessions, launchContext, project]);
  const serverOrderedTerminalIds = useMemo(
    () => drawerTerminalSessions.map((session) => session.target.terminalId),
    [drawerTerminalSessions],
  );
  const knownTerminalIds = useMemo(
    () => [...new Set([...serverOrderedTerminalIds, ...terminalUiState.terminalIds])],
    [serverOrderedTerminalIds, terminalUiState.terminalIds],
  );
  const storeSetTerminalHeight = useTerminalUiStateStore((state) => state.setTerminalHeight);
  const storeSplitTerminal = useTerminalUiStateStore((state) => state.splitTerminal);
  const storeSplitTerminalVertical = useTerminalUiStateStore(
    (state) => state.splitTerminalVertical,
  );
  const storeNewTerminal = useTerminalUiStateStore((state) => state.newTerminal);
  const storeFlattenTerminalGroups = useTerminalUiStateStore(
    (state) => state.flattenTerminalGroups,
  );
  const storeLaunchTerminalGrid = useTerminalUiStateStore((state) => state.launchTerminalGrid);
  const storeAddBrowserPane = useTerminalUiStateStore((state) => state.addBrowserPane);
  const serverProviders =
    useAtomValue(serverEnvironment.providersValueAtom(threadRef.environmentId)) ?? EMPTY_PROVIDERS;
  const storeSetActiveTerminal = useTerminalUiStateStore((state) => state.setActiveTerminal);
  const storeCloseTerminal = useTerminalUiStateStore((state) => state.closeTerminal);
  const storeRejectPendingTerminalOpen = useTerminalUiStateStore(
    (state) => state.rejectPendingTerminalOpen,
  );
  const storeMoveTerminalInGroup = useTerminalUiStateStore((state) => state.moveTerminalInGroup);
  const storeMoveTerminalToGroup = useTerminalUiStateStore((state) => state.moveTerminalToGroup);
  const storeReorderTerminalGroups = useTerminalUiStateStore(
    (state) => state.reorderTerminalGroups,
  );
  const storeSetGroupSplitSizes = useTerminalUiStateStore((state) => state.setGroupSplitSizes);
  const storeRenameTerminalGroup = useTerminalUiStateStore((state) => state.renameTerminalGroup);
  const storeSetTerminalSidebarWidth = useTerminalUiStateStore(
    (state) => state.setTerminalSidebarWidth,
  );
  const reconcileTerminalIds = useTerminalUiStateStore((state) => state.reconcileTerminalIds);

  // Full-screen programs in a background-mounted terminal need a repaint when
  // the thread returns to view; count reveals so viewports can nudge the PTY.
  const [revealNudgeEpoch, setRevealNudgeEpoch] = useState(0);
  const wasVisibleRef = useRef(visible);
  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      setRevealNudgeEpoch((value) => value + 1);
    }
    wasVisibleRef.current = visible;
  }, [visible]);

  useEffect(() => {
    // Only a delivered metadata snapshot is authoritative; an empty list
    // while the query is still loading must not wipe the persisted layout.
    // The store keeps locally-opened ids the server hasn't confirmed yet and
    // drops everything else it no longer lists (closed on another machine).
    if (!terminalMetadataLoaded) {
      return;
    }
    reconcileTerminalIds(threadRef, serverOrderedTerminalIds);
  }, [
    reconcileTerminalIds,
    serverOrderedTerminalIds,
    terminalMetadataLoaded,
    terminalUiState.terminalIds,
    threadRef,
  ]);
  useTerminalLayoutSync({
    threadRef,
    terminalIds: terminalUiState.terminalIds,
    terminalGroups: terminalUiState.terminalGroups,
  });
  // The main terminal surface is one layout. Groups from older builds (or
  // right-panel surfaces) would otherwise hide behind the active one, which
  // is exactly the "which group am I in" confusion this removes.
  useEffect(() => {
    if (terminalUiState.terminalGroups.length > 1) {
      storeFlattenTerminalGroups(threadRef);
    }
  }, [storeFlattenTerminalGroups, terminalUiState.terminalGroups.length, threadRef]);
  const [localFocusRequestId, setLocalFocusRequestId] = useState(0);
  const worktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const effectiveWorktreePath = useMemo(() => {
    if (launchContext !== null) {
      return launchContext.worktreePath;
    }
    return worktreePath;
  }, [launchContext, worktreePath]);
  const cwd = useMemo(
    () =>
      launchContext?.cwd ??
      (project
        ? projectScriptCwd({
            project: { cwd: project.workspaceRoot },
            worktreePath: effectiveWorktreePath,
          })
        : null),
    [effectiveWorktreePath, launchContext?.cwd, project],
  );
  const runtimeEnv = useMemo(
    () =>
      project
        ? projectScriptRuntimeEnv({
            project: { cwd: project.workspaceRoot },
            worktreePath: effectiveWorktreePath,
          })
        : {},
    [effectiveWorktreePath, project],
  );

  const openTerminalWithRollback = useCallback(
    async (terminalId: string, input: TerminalOpenInput) => {
      const result = await openTerminal({ environmentId: threadRef.environmentId, input });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        storeRejectPendingTerminalOpen(threadRef, terminalId);
      }
      return result;
    },
    [openTerminal, storeRejectPendingTerminalOpen, threadRef],
  );

  const bumpFocusRequestId = useCallback(() => {
    if (!visible) {
      return;
    }
    setLocalFocusRequestId((value) => value + 1);
  }, [visible]);

  const setTerminalHeight = useCallback(
    (height: number) => {
      storeSetTerminalHeight(threadRef, height);
    },
    [storeSetTerminalHeight, threadRef],
  );

  const splitTerminal = useCallback(
    (sourceTerminalId?: string) => {
      if (!cwd) {
        return;
      }
      if (sourceTerminalId) {
        storeSetActiveTerminal(threadRef, sourceTerminalId);
      }
      const terminalId = nextTerminalId(knownTerminalIds);
      storeSplitTerminal(threadRef, terminalId);
      bumpFocusRequestId();
      void openTerminalWithRollback(terminalId, {
        threadId,
        terminalId,
        cwd,
        ...(effectiveWorktreePath != null ? { worktreePath: effectiveWorktreePath } : {}),
        env: runtimeEnv,
      });
    },
    [
      bumpFocusRequestId,
      cwd,
      effectiveWorktreePath,
      knownTerminalIds,
      openTerminalWithRollback,
      runtimeEnv,
      storeSetActiveTerminal,
      storeSplitTerminal,
      threadId,
      threadRef,
    ],
  );
  const splitTerminalVertical = useCallback(
    (sourceTerminalId?: string) => {
      if (!cwd) {
        return;
      }
      if (sourceTerminalId) {
        storeSetActiveTerminal(threadRef, sourceTerminalId);
      }
      const terminalId = nextTerminalId(knownTerminalIds);
      storeSplitTerminalVertical(threadRef, terminalId);
      bumpFocusRequestId();
      void openTerminalWithRollback(terminalId, {
        threadId,
        terminalId,
        cwd,
        ...(effectiveWorktreePath != null ? { worktreePath: effectiveWorktreePath } : {}),
        env: runtimeEnv,
      });
    },
    [
      bumpFocusRequestId,
      cwd,
      effectiveWorktreePath,
      knownTerminalIds,
      openTerminalWithRollback,
      runtimeEnv,
      storeSetActiveTerminal,
      storeSplitTerminalVertical,
      threadId,
      threadRef,
    ],
  );

  const activeLayoutPaneCount = useMemo(() => {
    const group =
      terminalUiState.terminalGroups.find(
        (candidate) => candidate.id === terminalUiState.activeTerminalGroupId,
      ) ??
      terminalUiState.terminalGroups.find((candidate) =>
        candidate.terminalIds.includes(terminalUiState.activeTerminalId),
      );
    return group?.terminalIds.length ?? 0;
  }, [
    terminalUiState.activeTerminalGroupId,
    terminalUiState.activeTerminalId,
    terminalUiState.terminalGroups,
  ]);
  const openTerminalPane = useCallback(
    (terminalId: string, apiKeyInstanceId?: ProviderInstanceId) =>
      openTerminalWithRollback(terminalId, {
        threadId,
        terminalId,
        cwd: cwd ?? "",
        ...(effectiveWorktreePath != null ? { worktreePath: effectiveWorktreePath } : {}),
        env: apiKeyInstanceId
          ? { ...runtimeEnv, SOLLA_API_KEY_ACCOUNT_INSTANCE: apiKeyInstanceId }
          : runtimeEnv,
      }),
    [cwd, effectiveWorktreePath, openTerminalWithRollback, runtimeEnv, threadId],
  );
  // "New terminal" adds a pane to the thread's one layout — beside the active
  // pane when it is wide, beneath it otherwise — rather than opening a second
  // group that hides the panes already on screen.
  const createNewTerminal = useCallback(
    (direction: "horizontal" | "vertical" = "horizontal") => {
      if (!cwd) {
        return;
      }
      const terminalId = nextTerminalId([...knownTerminalIds, ...terminalUiState.terminalIds]);
      if (terminalUiState.terminalIds.length === 0) {
        storeNewTerminal(threadRef, terminalId);
      } else {
        if (activeLayoutPaneCount >= MAX_TERMINALS_PER_GROUP) {
          return;
        }
        if (direction === "vertical") {
          storeSplitTerminalVertical(threadRef, terminalId);
        } else {
          storeSplitTerminal(threadRef, terminalId);
        }
      }
      bumpFocusRequestId();
      void openTerminalPane(terminalId);
    },
    [
      activeLayoutPaneCount,
      bumpFocusRequestId,
      cwd,
      knownTerminalIds,
      openTerminalPane,
      storeNewTerminal,
      storeSplitTerminal,
      storeSplitTerminalVertical,
      terminalUiState.terminalIds,
      threadRef,
    ],
  );
  // Launch pad: open every pane as one grid, then type each provider's CLI
  // command into its pane once the shell is up.
  const launchTerminals = useCallback(
    (commands: ReadonlyArray<string | null>) => {
      if (!cwd || commands.length === 0) {
        return;
      }
      const used = [...knownTerminalIds, ...terminalUiState.terminalIds];
      const terminalIds: string[] = [];
      for (let index = 0; index < commands.length; index += 1) {
        const terminalId = nextTerminalId(used);
        used.push(terminalId);
        terminalIds.push(terminalId);
      }
      storeLaunchTerminalGrid(threadRef, terminalIds);
      // Persist the complete batch before the first open can announce a partial layout.
      const launchState = selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        threadRef,
      );
      const layoutReady = publishTerminalLayout({
        environmentId: threadRef.environmentId,
        input: { threadId, groups: localTerminalGroupsToRemote(launchState.terminalGroups) },
      });
      bumpFocusRequestId();
      terminalIds.forEach((terminalId, index) => {
        const command = commands[index] ?? null;
        void (async () => {
          const layoutResult = await layoutReady;
          if (layoutResult._tag === "Failure") {
            storeRejectPendingTerminalOpen(threadRef, terminalId);
            return;
          }
          const apiKeyInstanceId =
            command === "deepcode"
              ? serverProviders.find(
                  (provider) =>
                    provider.driver === "deepcode" &&
                    provider.installed &&
                    provider.enabled &&
                    (provider.availability ?? "available") === "available",
                )?.instanceId
              : undefined;
          const result = await openTerminalPane(terminalId, apiKeyInstanceId);
          if (result._tag === "Failure" || command === null) {
            return;
          }
          // Give the shell a beat to print its prompt so the command lands
          // on a fresh line instead of racing the login banner.
          await new Promise((resolve) => setTimeout(resolve, 400));
          await writeTerminal({
            environmentId: threadRef.environmentId,
            input: { threadId, terminalId, data: `${command}\r` },
          });
        })();
      });
    },
    [
      bumpFocusRequestId,
      cwd,
      knownTerminalIds,
      openTerminalPane,
      storeLaunchTerminalGrid,
      publishTerminalLayout,
      storeRejectPendingTerminalOpen,
      serverProviders,
      terminalUiState.terminalIds,
      threadId,
      threadRef,
      writeTerminal,
    ],
  );
  const addBrowserPane = useCallback(
    (direction: "horizontal" | "vertical" = "horizontal") => {
      if (
        !terminalUiState.terminalIds.includes(BROWSER_PANE_ID) &&
        activeLayoutPaneCount >= MAX_TERMINALS_PER_GROUP
      ) {
        return;
      }
      storeAddBrowserPane(threadRef, direction);
      bumpFocusRequestId();
    },
    [
      activeLayoutPaneCount,
      bumpFocusRequestId,
      storeAddBrowserPane,
      terminalUiState.terminalIds,
      threadRef,
    ],
  );

  /**
   * The fallback half of the settings sign-in: providers with no in-app flow
   * get their login command run in a real pane, where the CLI prints its URL
   * and takes input exactly as it would anywhere else.
   *
   * Waits for `cwd`. Servicing the request before the thread has one opens a
   * pane that immediately fails, and the request is already gone.
   */
  const pendingTerminalSignIn = useProviderSignInRequestStore((state) => state.pending);
  const consumeTerminalSignIn = useProviderSignInRequestStore((state) => state.consumeIf);
  useEffect(() => {
    if (pendingTerminalSignIn === null || pendingTerminalSignIn.supportsAccountSwitch) return;
    if (!cwd || !visible) return;
    const request = consumeTerminalSignIn((candidate) => !candidate.supportsAccountSwitch);
    if (request === null) return;
    launchTerminals([request.command]);
  }, [consumeTerminalSignIn, cwd, launchTerminals, pendingTerminalSignIn, visible]);

  const launchProviders = useMemo<ReadonlyArray<TerminalLaunchProvider>>(() => {
    const byDriver = new Map<string, TerminalLaunchProvider>();
    for (const provider of serverProviders) {
      if (!provider.installed || !provider.enabled) continue;
      if ((provider.availability ?? "available") !== "available") continue;
      const command = providerDriverLaunchCommand(provider.driver);
      if (command === null || byDriver.has(provider.driver)) continue;
      byDriver.set(provider.driver, {
        driverKind: provider.driver,
        label: provider.displayName ?? provider.driver,
        command,
      });
    }
    return [...byDriver.values()];
  }, [serverProviders]);
  const renderBrowserPane = useCallback(
    () => (
      <Suspense fallback={null}>
        <PreviewPanel mode="embedded" threadRef={threadRef} tabId={null} visible={visible} />
      </Suspense>
    ),
    [threadRef, visible],
  );

  const activateTerminal = useCallback(
    (terminalId: string) => {
      storeSetActiveTerminal(threadRef, terminalId);
      bumpFocusRequestId();
    },
    [bumpFocusRequestId, storeSetActiveTerminal, threadRef],
  );

  const closeTerminal = useCallback(
    (terminalId: string) => {
      if (isBrowserPaneId(terminalId)) {
        // No PTY behind a browser pane: just take it out of the layout.
        storeCloseTerminal(threadRef, terminalId);
        bumpFocusRequestId();
        return;
      }
      const fallbackExitWrite = () =>
        writeTerminal({
          environmentId: threadRef.environmentId,
          input: { threadId, terminalId, data: "exit\n" },
        });

      void (async () => {
        const closeResult = await closeTerminalMutation({
          environmentId: threadRef.environmentId,
          input: {
            threadId,
            terminalId,
            deleteHistory: true,
          },
        });
        if (closeResult._tag === "Failure" && !isAtomCommandInterrupted(closeResult)) {
          await fallbackExitWrite();
        }
      })();

      storeCloseTerminal(threadRef, terminalId);
      bumpFocusRequestId();
    },
    [
      bumpFocusRequestId,
      storeCloseTerminal,
      threadId,
      threadRef,
      closeTerminalMutation,
      writeTerminal,
    ],
  );

  const handleAddTerminalContext = useCallback(
    (selection: TerminalContextSelection) => {
      if (!visible) {
        return;
      }
      onAddTerminalContext(selection);
    },
    [onAddTerminalContext, visible],
  );

  if (!project || !cwd) {
    return null;
  }
  // The terminal is only ever the main surface; the drawer variant that used
  // to render under the chat is gone.
  return (
    <div className={visible ? "flex min-h-0 min-w-0 flex-1" : "hidden"}>
      <ThreadTerminalDrawerMount
        showPaneHeaders={paneLayout !== "tabs"}
        mode="panel"
        focusOwner="drawer"
        {...(paneLayout !== undefined ? { paneLayout } : {})}
        {...(tabStripTrailing !== undefined ? { tabStripTrailing } : {})}
        threadRef={threadRef}
        threadId={threadId}
        cwd={cwd}
        worktreePath={effectiveWorktreePath}
        runtimeEnv={runtimeEnv}
        visible={visible}
        nudgeEpoch={revealNudgeEpoch}
        height={terminalUiState.terminalHeight}
        // Known-session order is MRU and changes on focus; persisted store order keeps sidebar labels stable.
        terminalIds={terminalUiState.terminalIds}
        activeTerminalId={terminalUiState.activeTerminalId}
        terminalGroups={terminalUiState.terminalGroups}
        activeTerminalGroupId={terminalUiState.activeTerminalGroupId}
        focusRequestId={focusRequestId + localFocusRequestId + (visible ? 1 : 0)}
        onSplitTerminal={splitTerminal}
        onSplitTerminalVertical={splitTerminalVertical}
        onNewTerminal={createNewTerminal}
        onLaunchTerminals={launchTerminals}
        launchProviders={launchProviders}
        onAddBrowserPane={addBrowserPane}
        renderBrowserPane={renderBrowserPane}
        splitShortcutLabel={visible ? splitShortcutLabel : undefined}
        splitVerticalShortcutLabel={visible ? splitVerticalShortcutLabel : undefined}
        newShortcutLabel={visible ? newShortcutLabel : undefined}
        closeShortcutLabel={visible ? closeShortcutLabel : undefined}
        keybindings={keybindings}
        onActiveTerminalChange={activateTerminal}
        onCloseTerminal={closeTerminal}
        onHeightChange={setTerminalHeight}
        onMoveTerminal={(groupId, terminalId, targetTerminalId, zone) =>
          storeMoveTerminalInGroup(threadRef, groupId, terminalId, targetTerminalId, zone)
        }
        onMoveTerminalToGroup={(terminalId, destinationGroupId, placement) =>
          storeMoveTerminalToGroup(threadRef, terminalId, destinationGroupId, placement)
        }
        onReorderTerminalGroups={(groupId, placement) =>
          storeReorderTerminalGroups(threadRef, groupId, placement)
        }
        {...(onToggleFullscreen !== undefined
          ? { fullscreen: fullscreen === true, onToggleFullscreen }
          : {})}
        onSplitSizesChange={(groupId, path, sizes) =>
          storeSetGroupSplitSizes(threadRef, groupId, path, sizes)
        }
        onRenameGroup={(groupId, name) => storeRenameTerminalGroup(threadRef, groupId, name)}
        sidebarWidth={terminalUiState.sidebarWidth}
        onSidebarWidthChange={(width) => storeSetTerminalSidebarWidth(threadRef, width)}
        onAddTerminalContext={handleAddTerminalContext}
        terminalLabelsById={terminalLabelsById}
        terminalLaunchLocationsById={terminalLaunchLocationsById}
      />
    </div>
  );
});

interface PersistentThreadTerminalPanelProps {
  threadRef: ScopedThreadRef;
  surface: Extract<RightPanelSurface, { kind: "terminal" }>;
  launchContext: PersistentTerminalLaunchContext | null;
  focusRequestId: number;
  keybindings: ResolvedKeybindingsConfig;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  onNewTerminal: () => void;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
  splitShortcutLabel?: string | undefined;
  splitVerticalShortcutLabel?: string | undefined;
  newShortcutLabel?: string | undefined;
  closeShortcutLabel?: string | undefined;
}

const PersistentThreadTerminalPanel = memo(function PersistentThreadTerminalPanel({
  threadRef,
  surface,
  launchContext,
  focusRequestId,
  keybindings,
  onAddTerminalContext,
  onNewTerminal,
  onActiveTerminalChange,
  onCloseTerminal,
  newShortcutLabel,
  closeShortcutLabel,
}: PersistentThreadTerminalPanelProps) {
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const serverThread = useThread(threadRef, { waitForShell: draftThread !== null });
  const projectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const project = useProject(projectRef);
  const knownTerminalSessions = useKnownTerminalSessions({
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
  });
  const threadWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  // The terminals view's own list, so the panel and the view show the same
  // terminals in the same order. Known-session order is MRU and reshuffles on
  // focus, which would make the tabs jump around as you use them.
  const panelTerminalIds = useTerminalUiStateStore(
    (state) => selectThreadTerminalUiState(state.terminalUiStateByThreadKey, threadRef).terminalIds,
  );
  const activePanelTerminalId = panelTerminalIds.includes(surface.activeTerminalId)
    ? surface.activeTerminalId
    : (panelTerminalIds[0] ?? surface.activeTerminalId);
  const activeSummary =
    knownTerminalSessions.find((session) => session.target.terminalId === activePanelTerminalId)
      ?.state.summary ?? null;
  const worktreePath =
    launchContext?.worktreePath ?? activeSummary?.worktreePath ?? threadWorktreePath;
  const cwd = useMemo(
    () =>
      launchContext?.cwd ??
      activeSummary?.cwd ??
      (project
        ? projectScriptCwd({
            project: { cwd: project.workspaceRoot },
            worktreePath,
          })
        : null),
    [activeSummary?.cwd, launchContext?.cwd, project, worktreePath],
  );
  const runtimeEnv = useMemo(
    () =>
      project
        ? projectScriptRuntimeEnv({
            project: { cwd: project.workspaceRoot },
            worktreePath,
          })
        : {},
    [project, worktreePath],
  );
  const terminalLabelsById = useMemo(() => {
    const labels = new Map<string, string>();
    for (const terminalId of panelTerminalIds) {
      const summary =
        knownTerminalSessions.find((session) => session.target.terminalId === terminalId)?.state
          .summary ?? null;
      labels.set(terminalId, resolveTerminalSessionLabel(terminalId, summary));
    }
    return labels;
  }, [knownTerminalSessions, panelTerminalIds]);
  const terminalLaunchLocationsById = useMemo(() => {
    const locations = new Map<
      string,
      {
        readonly cwd: string;
        readonly worktreePath: string | null;
        readonly runtimeEnv: Record<string, string>;
      }
    >();
    for (const terminalId of panelTerminalIds) {
      const summary =
        knownTerminalSessions.find((session) => session.target.terminalId === terminalId)?.state
          .summary ?? null;
      const terminalWorktreePath =
        launchContext?.worktreePath ?? summary?.worktreePath ?? threadWorktreePath;
      const terminalCwd =
        launchContext?.cwd ??
        summary?.cwd ??
        (project
          ? projectScriptCwd({
              project: { cwd: project.workspaceRoot },
              worktreePath: terminalWorktreePath,
            })
          : null);
      if (!terminalCwd || !project) continue;
      locations.set(terminalId, {
        cwd: terminalCwd,
        worktreePath: terminalWorktreePath,
        runtimeEnv: projectScriptRuntimeEnv({
          project: { cwd: project.workspaceRoot },
          worktreePath: terminalWorktreePath,
        }),
      });
    }
    return locations;
  }, [
    knownTerminalSessions,
    launchContext?.cwd,
    launchContext?.worktreePath,
    panelTerminalIds,
    project,
    threadWorktreePath,
  ]);

  if (!project || !cwd) return null;

  return (
    <ThreadTerminalDrawerMount
      mode="panel"
      threadRef={threadRef}
      threadId={threadRef.threadId}
      cwd={cwd}
      worktreePath={worktreePath}
      runtimeEnv={runtimeEnv}
      height={0}
      // One terminal per tab, the same chrome the fullscreen terminals view
      // uses. Pane headers belong to the split workspace, which the panel no
      // longer has.
      paneLayout="tabs"
      showPaneHeaders={false}
      allowSplit={false}
      terminalIds={panelTerminalIds}
      activeTerminalId={activePanelTerminalId}
      terminalGroups={[{ id: surface.id, terminalIds: panelTerminalIds }]}
      activeTerminalGroupId={surface.id}
      focusRequestId={focusRequestId}
      // Unreachable while allowSplit is false; the drawer still requires them.
      onSplitTerminal={() => undefined}
      onSplitTerminalVertical={() => undefined}
      onNewTerminal={onNewTerminal}
      newShortcutLabel={newShortcutLabel}
      closeShortcutLabel={closeShortcutLabel}
      onActiveTerminalChange={onActiveTerminalChange}
      onCloseTerminal={onCloseTerminal}
      onHeightChange={() => undefined}
      onAddTerminalContext={onAddTerminalContext}
      terminalLabelsById={terminalLabelsById}
      terminalLaunchLocationsById={terminalLaunchLocationsById}
      keybindings={keybindings}
    />
  );
});

// Errors surface through two maps (draft-keyed and thread-keyed) whose entries
// can race around promotion, so each write carries its time to let the latest
// one win when they collide.
type LocalThreadErrorEntry = {
  readonly message: string | null;
  readonly at: number;
};

type LoadedThreadHistory = {
  readonly routeThreadKey: string;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly window: OrchestrationThreadHistoryWindow | null;
};

function chatActionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

function ChatViewContent(props: ChatViewProps) {
  const {
    environmentId,
    threadId,
    routeKind,
    onDiffPanelOpen,
    reserveTitleBarControlInset = true,
    forceExpandedMobileComposer = false,
    embeddedSideChat = false,
    hideWorkspaceHeader = false,
    projectScriptsPortalTarget = null,
    agentSurfaces = false,
    inlineTimelineNotice = null,
  } = props;
  const requestedArtifactId = routeKind === "server" ? (props.artifactId ?? null) : null;
  const chatViewRootRef = useRef<HTMLDivElement | null>(null);
  const draftId = routeKind === "draft" ? props.draftId : null;
  const handleNewThread = useNewThreadHandler();
  const routeThreadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const routeServerThreadRef = routeKind === "server" ? routeThreadRef : null;
  const routeServerThreadShell = useThreadShell(routeServerThreadRef);
  const routeServerThreadDetail = useThreadDetail(routeServerThreadRef);
  const routeServerThreadStatus = useThreadStatus(routeServerThreadRef);
  const routeEnvironmentThreadState = useEnvironmentThread(
    routeKind === "server" ? environmentId : null,
    routeKind === "server" ? threadId : null,
  );
  const inferredThreadSyncPhase = resolveThreadSyncPhase({
    detailExists: routeServerThreadDetail !== null,
    shellExists: routeServerThreadShell !== null,
    status: routeServerThreadStatus,
  });
  // Full-page routes already compute this phase, while embedded side chats do
  // not pass route props. Falling back to the same authoritative thread state
  // gives both surfaces identical loading and catch-up behavior.
  const threadSyncPhase =
    routeKind === "server"
      ? props.threadSyncPhase === undefined
        ? inferredThreadSyncPhase
        : props.threadSyncPhase
      : null;
  const threadDetailLoading = threadSyncPhase === "loading";
  // Only the no-detail phase blocks submission. Once the bounded snapshot is
  // present, the server remains authoritative for the command even while this
  // client applies replay events. Holding the composer through that replay
  // made startup latency user-visible as a thread that could not be answered.
  const threadCatchingUp = threadSyncBlocksSend(threadSyncPhase);
  const routeThreadKey = useMemo(() => scopedThreadKey(routeThreadRef), [routeThreadRef]);
  const { environments } = useEnvironments();
  // A thread on a host we cannot reach reports last-known state, not live
  // state. An unknown environment is treated as reachable so nothing changes
  // for the ordinary local case.
  const threadEnvironmentUnreachable = useMemo(() => {
    const environment = environments.find((candidate) => candidate.environmentId === environmentId);
    return environment !== undefined && environment.connection.phase !== "connected";
  }, [environments, environmentId]);
  const primaryEnvironment = usePrimaryEnvironment();
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });

  const upsertKeybinding = useAtomCommand(serverEnvironment.upsertKeybinding, {
    reportFailure: false,
  });
  const refreshServerProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const correctVoiceTranscript = useAtomCommand(serverEnvironment.correctVoiceTranscript, {
    reportFailure: false,
  });
  const consumeProviderUsageReset = useAtomCommand(serverEnvironment.consumeProviderUsageReset, {
    reportFailure: false,
  });
  const resumeUsageGuard = useAtomCommand(serverEnvironment.resumeUsageGuard, {
    reportFailure: false,
  });
  const startProviderAccountSwitch = useAtomCommand(serverEnvironment.startProviderAccountSwitch, {
    reportFailure: false,
  });
  const getProviderAccountSwitch = useAtomCommand(serverEnvironment.getProviderAccountSwitch, {
    reportFailure: false,
  });
  const openProviderAccountSwitchAuthLink = useAtomCommand(
    serverEnvironment.openProviderAccountSwitchAuthLink,
    { reportFailure: false },
  );
  const submitProviderAccountSwitchCode = useAtomCommand(
    serverEnvironment.submitProviderAccountSwitchCode,
    { reportFailure: false },
  );
  const cancelProviderAccountSwitch = useAtomCommand(
    serverEnvironment.cancelProviderAccountSwitch,
    { reportFailure: false },
  );
  const startHostRepair = useAtomCommand(serverEnvironment.startHostRepair, {
    reportFailure: false,
  });
  const [providerAccountSwitch, setProviderAccountSwitch] =
    useState<ProviderAccountSwitchState | null>(null);
  const [providerAccountSwitchCancelling, setProviderAccountSwitchCancelling] = useState(false);
  const [providerAccountSwitchSubmittingCode, setProviderAccountSwitchSubmittingCode] =
    useState(false);
  const [pendingProviderAccountSwitchInstanceId, setPendingProviderAccountSwitchInstanceId] =
    useState<ProviderInstanceId | null>(null);
  const dismissedProviderAccountSwitchIdRef = useRef<string | null>(null);
  const providerUsageRefreshRpcRef = useRef<(instanceId: ProviderInstanceId) => Promise<void>>(
    async () => undefined,
  );
  const providerUsageRefreshCoordinatorRef = useRef(
    createProviderUsageRefreshCoordinator({
      refresh: (instanceId) => providerUsageRefreshRpcRef.current(instanceId),
    }),
  );

  const beginProviderAccountSwitch = useCallback(
    async (instanceId: ProviderInstanceId) => {
      dismissedProviderAccountSwitchIdRef.current = null;
      setProviderAccountSwitchCancelling(false);
      setProviderAccountSwitchSubmittingCode(false);
      const result = await startProviderAccountSwitch({
        environmentId,
        input: { instanceId },
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not switch provider account",
          description: chatActionErrorMessage(error),
        });
        return;
      }
      setProviderAccountSwitch(result.value);
    },
    [environmentId, startProviderAccountSwitch],
  );

  const requestProviderAccountSwitch = useCallback((instanceId: ProviderInstanceId) => {
    setPendingProviderAccountSwitchInstanceId(instanceId);
  }, []);

  /**
   * Service a sign-in asked for from the provider settings route.
   *
   * Settings is a route of its own with no thread mounted, so its button parks
   * the request and navigates here. This half handles providers that can sign
   * in inside the app; the terminal fallback is serviced by the terminal
   * panel, which is the component that owns a `cwd`.
   */
  const pendingSignIn = useProviderSignInRequestStore((state) => state.pending);
  const consumeSignInRequest = useProviderSignInRequestStore((state) => state.consumeIf);
  useEffect(() => {
    if (pendingSignIn === null || !pendingSignIn.supportsAccountSwitch) return;
    const request = consumeSignInRequest((candidate) => candidate.supportsAccountSwitch);
    if (request === null) return;
    requestProviderAccountSwitch(request.instanceId);
  }, [consumeSignInRequest, pendingSignIn, requestProviderAccountSwitch]);

  const dismissProviderAccountSwitch = useCallback(() => {
    dismissedProviderAccountSwitchIdRef.current = providerAccountSwitch?.id ?? null;
    setProviderAccountSwitch(null);
    setProviderAccountSwitchCancelling(false);
    setProviderAccountSwitchSubmittingCode(false);
  }, [providerAccountSwitch]);

  const cancelActiveProviderAccountSwitch = useCallback(async () => {
    if (!providerAccountSwitch || !isProviderAccountSwitchActive(providerAccountSwitch)) return;
    setProviderAccountSwitchCancelling(true);
    const result = await cancelProviderAccountSwitch({
      environmentId,
      input: {
        instanceId: providerAccountSwitch.instanceId,
        switchId: providerAccountSwitch.id,
      },
    });
    if (result._tag === "Failure") {
      // A restarted host or a newer login can retire this flow before Cancel arrives.
      // Read its exact identity before deciding whether cancellation really failed.
      const refreshed = await getProviderAccountSwitch({
        environmentId,
        input: {
          instanceId: providerAccountSwitch.instanceId,
          switchId: providerAccountSwitch.id,
        },
      });
      setProviderAccountSwitchCancelling(false);
      if (refreshed._tag !== "Failure") {
        setProviderAccountSwitch((current) =>
          reconcileProviderAccountSwitch(current, providerAccountSwitch.id, refreshed.value),
        );
        if (refreshed.value === null || !isProviderAccountSwitchActive(refreshed.value)) return;
      }
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not cancel account switch",
        description: chatActionErrorMessage(error),
      });
      return;
    }
    setProviderAccountSwitchCancelling(false);
    setProviderAccountSwitch((current) =>
      reconcileProviderAccountSwitch(current, providerAccountSwitch.id, result.value),
    );
  }, [cancelProviderAccountSwitch, environmentId, getProviderAccountSwitch, providerAccountSwitch]);

  const submitActiveProviderAuthenticationCode = useCallback(
    async (code: string): Promise<boolean> => {
      if (!providerAccountSwitch || providerAccountSwitch.status !== "waiting_for_code") {
        return false;
      }
      setProviderAccountSwitchSubmittingCode(true);
      const result = await submitProviderAccountSwitchCode({
        environmentId,
        input: {
          instanceId: providerAccountSwitch.instanceId,
          switchId: providerAccountSwitch.id,
          code,
        },
      });
      setProviderAccountSwitchSubmittingCode(false);
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not submit authentication code",
          description: chatActionErrorMessage(error),
        });
        return false;
      }
      setProviderAccountSwitch((current) =>
        reconcileProviderAccountSwitch(current, providerAccountSwitch.id, result.value),
      );
      return true;
    },
    [environmentId, providerAccountSwitch, submitProviderAccountSwitchCode],
  );

  const openProviderAuthenticationLink = useCallback(() => {
    if (!providerAccountSwitch?.authUrl) return;
    void openProviderAccountSwitchAuthLink({
      environmentId,
      input: {
        instanceId: providerAccountSwitch.instanceId,
        switchId: providerAccountSwitch.id,
      },
    }).then((result) => {
      if (result._tag !== "Failure") return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "warning",
        title: "Could not open the provider login on the host",
        description: chatActionErrorMessage(error),
      });
    });
  }, [environmentId, openProviderAccountSwitchAuthLink, providerAccountSwitch]);

  const activeProviderAccountSwitchId =
    providerAccountSwitch && isProviderAccountSwitchActive(providerAccountSwitch)
      ? providerAccountSwitch.id
      : null;
  const activeProviderAccountSwitchInstanceId =
    providerAccountSwitch && isProviderAccountSwitchActive(providerAccountSwitch)
      ? providerAccountSwitch.instanceId
      : null;
  useEffect(() => {
    if (!activeProviderAccountSwitchId || !activeProviderAccountSwitchInstanceId) return;
    let disposed = false;
    let polling = false;
    let timeout: number | null = null;
    const schedule = () => {
      if (disposed || document.visibilityState !== "visible") return;
      timeout = window.setTimeout(() => void poll(), 750);
    };
    const poll = async () => {
      if (polling || disposed || document.visibilityState !== "visible") return;
      polling = true;
      const result = await getProviderAccountSwitch({
        environmentId,
        input: {
          instanceId: activeProviderAccountSwitchInstanceId,
          switchId: activeProviderAccountSwitchId,
        },
      });
      polling = false;
      if (!disposed && result._tag !== "Failure") {
        setProviderAccountSwitch((current) =>
          reconcileProviderAccountSwitch(current, activeProviderAccountSwitchId, result.value),
        );
      }
      schedule();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void poll();
      } else if (timeout !== null) {
        window.clearTimeout(timeout);
        timeout = null;
      }
    };
    void poll();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      if (timeout !== null) window.clearTimeout(timeout);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [
    activeProviderAccountSwitchId,
    activeProviderAccountSwitchInstanceId,
    environmentId,
    getProviderAccountSwitch,
  ]);

  useEffect(() => {
    if (!providerAccountSwitch) return;
    if (
      providerAccountSwitch.status !== "succeeded" &&
      providerAccountSwitch.status !== "cancelled"
    ) {
      return;
    }
    const timeout = window.setTimeout(
      dismissProviderAccountSwitch,
      providerAccountSwitch.status === "succeeded" ? 1_200 : 350,
    );
    return () => window.clearTimeout(timeout);
  }, [dismissProviderAccountSwitch, providerAccountSwitch]);
  const openTerminal = useAtomCommand(terminalEnvironment.open, "terminal open");
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "terminal write");
  const closeTerminalMutation = useAtomCommand(terminalEnvironment.close, "terminal close");
  const refreshThreadPlanCommand = useAtomCommand(threadEnvironment.refreshPlan, "plan refresh");
  const loadThreadHistoryCommand = useAtomCommand(loadThreadHistory, {
    reportFailure: false,
  });
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const switchGitRef = useAtomCommand(vcsEnvironment.switchRef, { reportFailure: false });
  const removeQueuedMessage = useAtomCommand(threadEnvironment.removeQueuedMessage, {
    reportFailure: false,
  });
  const sendQueuedMessageNow = useAtomCommand(threadEnvironment.sendQueuedMessageNow, {
    reportFailure: false,
  });
  const startThreadTurn = useAtomCommand(threadEnvironment.enqueueTurn, { reportFailure: false });
  const {
    forkThread: forkThreadAction,
    promoteSideChat: promoteSideChatAction,
    archiveThread: archiveThreadAction,
  } = useThreadActions();
  const interruptThreadTurn = useAtomCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const promoteQueuedThreadTurns = useAtomCommand(threadEnvironment.promoteQueuedTurns, {
    reportFailure: false,
  });
  const queuedMessagePromotionPhasesRef = useRef<QueuedMessagePromotionPhases>({});
  const [queuedMessagePromotionPhases, setQueuedMessagePromotionPhases] =
    useState<QueuedMessagePromotionPhases>({});
  const stopThreadSession = useAtomCommand(threadEnvironment.stopSession, {
    reportFailure: false,
  });
  const stopThreadTask = useAtomCommand(threadEnvironment.stopTask, { reportFailure: false });
  const respondToThreadApproval = useAtomCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondToThreadUserInput = useAtomCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const revertThreadCheckpoint = useAtomCommand(threadEnvironment.revertCheckpoint, {
    reportFailure: false,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const closePreview = useAtomCommand(previewEnvironment.close, "preview close");
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const environmentById = useMemo(
    () => new Map(environments.map((environment) => [environment.environmentId, environment])),
    [environments],
  );
  const composerDraftTarget: ScopedThreadRef | DraftId =
    routeKind === "server" ? routeThreadRef : props.draftId;
  const transcriptionOwnerKey =
    typeof composerDraftTarget === "string"
      ? `draft:${composerDraftTarget}`
      : `thread:${scopedThreadKey(composerDraftTarget)}`;
  const draftThread = useComposerDraftStore((store) =>
    routeKind === "server"
      ? store.getDraftSessionByRef(routeThreadRef)
      : draftId
        ? store.getDraftSession(draftId)
        : null,
  );
  const recentServerThread = useThread(routeThreadRef, { waitForShell: draftThread !== null });
  const [loadedThreadHistory, setLoadedThreadHistory] = useState<LoadedThreadHistory>(() => ({
    routeThreadKey,
    messages: [],
    activities: [],
    window: routeEnvironmentThreadState.history ?? null,
  }));
  const historyLoadInFlightRef = useRef(false);
  const historyRouteKeyRef = useRef(routeThreadKey);
  historyRouteKeyRef.current = routeThreadKey;
  useEffect(() => {
    historyLoadInFlightRef.current = false;
    setLoadedThreadHistory((current) => {
      if (current.routeThreadKey !== routeThreadKey) {
        return {
          routeThreadKey,
          messages: [],
          activities: [],
          window: routeEnvironmentThreadState.history ?? null,
        };
      }
      if (current.messages.length === 0 && current.activities.length === 0) {
        return { ...current, window: routeEnvironmentThreadState.history ?? null };
      }
      return current;
    });
  }, [routeEnvironmentThreadState.history, routeThreadKey]);
  const serverThread = useMemo(() => {
    if (recentServerThread === null || loadedThreadHistory.routeThreadKey !== routeThreadKey) {
      return recentServerThread;
    }
    if (loadedThreadHistory.messages.length === 0 && loadedThreadHistory.activities.length === 0) {
      return recentServerThread;
    }
    const recentMessageIds = new Set(recentServerThread.messages.map((message) => message.id));
    const recentActivityIds = new Set(recentServerThread.activities.map((activity) => activity.id));
    return {
      ...recentServerThread,
      messages: [
        ...loadedThreadHistory.messages.filter((message) => !recentMessageIds.has(message.id)),
        ...recentServerThread.messages,
      ],
      activities: [
        ...loadedThreadHistory.activities.filter((activity) => !recentActivityIds.has(activity.id)),
        ...recentServerThread.activities,
      ],
    };
  }, [loadedThreadHistory, recentServerThread, routeThreadKey]);
  const olderHistoryWindow =
    loadedThreadHistory.routeThreadKey === routeThreadKey
      ? loadedThreadHistory.window
      : (routeEnvironmentThreadState.history ?? null);
  const hasOlderThreadHistory =
    olderHistoryWindow !== null &&
    (olderHistoryWindow.messageCursor !== null || olderHistoryWindow.activityCursor !== null);
  const olderHistoryMessageCount = Math.max(
    0,
    (olderHistoryWindow?.totalMessages ?? 0) -
      (recentServerThread?.messages.length ?? 0) -
      loadedThreadHistory.messages.length,
  );
  const [olderHistoryLoading, setOlderHistoryLoading] = useState(false);
  const loadOlderThreadHistory = useCallback(async () => {
    if (
      routeKind !== "server" ||
      olderHistoryWindow === null ||
      historyLoadInFlightRef.current ||
      (olderHistoryWindow.messageCursor === null && olderHistoryWindow.activityCursor === null)
    ) {
      return;
    }
    historyLoadInFlightRef.current = true;
    setOlderHistoryLoading(true);
    const requestedRouteKey = routeThreadKey;
    try {
      const result = await loadThreadHistoryCommand({
        environmentId,
        input: {
          threadId,
          page: {
            ...(olderHistoryWindow.messageCursor === null
              ? {}
              : {
                  beforeMessageCreatedAt: olderHistoryWindow.messageCursor.createdAt,
                  beforeMessageId: olderHistoryWindow.messageCursor.messageId,
                }),
            ...(olderHistoryWindow.activityCursor === null
              ? {}
              : {
                  beforeActivityCreatedAt: olderHistoryWindow.activityCursor.createdAt,
                  beforeActivityId: olderHistoryWindow.activityCursor.activityId,
                }),
            limit: 150,
          },
        },
      });
      const commandValue = AsyncResult.value(result);
      if (Option.isNone(commandValue) || Option.isNone(commandValue.value)) return;
      const page = commandValue.value.value;
      if (historyRouteKeyRef.current !== requestedRouteKey) return;
      setLoadedThreadHistory((current) => {
        if (current.routeThreadKey !== requestedRouteKey) return current;
        const knownMessageIds = new Set(current.messages.map((message) => message.id));
        const knownActivityIds = new Set(current.activities.map((activity) => activity.id));
        return {
          ...current,
          messages: [
            ...page.messages.filter((message) => !knownMessageIds.has(message.id)),
            ...current.messages,
          ],
          activities: [
            ...page.activities.filter((activity) => !knownActivityIds.has(activity.id)),
            ...current.activities,
          ],
          window: page.history,
        };
      });
    } finally {
      historyLoadInFlightRef.current = false;
      if (historyRouteKeyRef.current === requestedRouteKey) {
        setOlderHistoryLoading(false);
      }
    }
  }, [
    environmentId,
    loadThreadHistoryCommand,
    olderHistoryWindow,
    routeKind,
    routeThreadKey,
    threadId,
  ]);
  const loadingServerThread = useMemo(
    () =>
      threadDetailLoading && routeServerThreadShell
        ? buildLoadingThreadFromShell(routeServerThreadShell)
        : null,
    [routeServerThreadShell, threadDetailLoading],
  );
  const activeServerThread = serverThread ?? loadingServerThread;
  const markThreadVisited = useUiStateStore((store) => store.markThreadVisited);
  const showProviderUsageBar = useUiStateStore((store) => store.showProviderUsageBar);
  const recordProviderUsage = useProviderUsageStore((store) => store.record);
  const activeThreadLastVisitedAt = useUiStateStore(
    (store) => store.threadLastVisitedAtById[routeThreadKey],
  );
  const settings = useEnvironmentSettings(environmentId);
  // New-thread defaults live in the primary environment's settings.json (the
  // settings UI never writes to remote environments), so read them from the
  // primary server rather than the thread's environment.
  const primaryServerSettings = useAtomValue(primaryServerSettingsAtom);
  const setStickyComposerModelSelection = useComposerDraftStore(
    (store) => store.setStickyModelSelection,
  );
  const timestampFormat = settings.timestampFormat;
  const autoOpenPlanSidebar = settings.autoOpenPlanSidebar;
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  // Granular store selectors — avoid subscribing to prompt changes.
  const composerRuntimeMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.runtimeMode ?? null,
  );
  const composerInteractionMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.interactionMode ?? null,
  );
  const composerActiveProvider = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.activeProvider ?? null,
  );
  const composerDraftModelState = useComposerDraftModelState(composerDraftTarget);
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const getDraftSessionByLogicalProjectKey = useComposerDraftStore(
    (store) => store.getDraftSessionByLogicalProjectKey,
  );
  const getDraftSession = useComposerDraftStore((store) => store.getDraftSession);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const promptRef = useRef("");
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const composerElementContextsRef = useRef<ElementContextDraft[]>([]);
  const localComposerRef = useRef<ChatComposerHandle | null>(null);
  const sharedComposerRef = useComposerHandleContext();
  // The command palette intentionally owns the main chat's composer handle.
  // Reusing that ref in the recursively mounted side chat lets the last
  // composer to mount steal focus/reset/transcription calls from the other.
  const composerRef = embeddedSideChat ? localComposerRef : (sharedComposerRef ?? localComposerRef);
  const [isFileDragOverTimeline, setIsFileDragOverTimeline] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<ChatMessage[]>([]);
  const optimisticUserMessagesRef = useRef(optimisticUserMessages);
  optimisticUserMessagesRef.current = optimisticUserMessages;
  const [localDraftErrorsByDraftId, setLocalDraftErrorsByDraftId] = useState<
    Record<string, LocalThreadErrorEntry>
  >({});
  const [localServerErrorsByThreadKey, setLocalServerErrorsByThreadKey] = useState<
    Record<string, LocalThreadErrorEntry>
  >({});
  const [dismissedServerErrorsByThreadKey, setDismissedServerErrorsByThreadKey] = useState<
    Record<string, string>
  >({});
  const [isConnecting, _setIsConnecting] = useState(false);
  const [isRevertingCheckpoint, setIsRevertingCheckpoint] = useState(false);
  const [hostRepairStartingErrorKey, setHostRepairStartingErrorKey] = useState<string | null>(null);
  const [hostRepairStartedErrorKey, setHostRepairStartedErrorKey] = useState<string | null>(null);
  const [pushToTalkStatus, setPushToTalkStatus] = useState<
    "recording" | "loading" | "transcribing" | "refining" | null
  >(null);
  // Every transcription phase must read as busy, not just the two the worker
  // reports progress for. The composer gates submission on this value, so a
  // phase that resolved to `null` here let Enter land a message mid-turn.
  const backgroundPushToTalkStatus = useBackgroundTaskStore((store) => {
    const task = store.tasks.find(
      (candidate) =>
        candidate.kind === "voice-transcription" &&
        candidate.ownerKey === transcriptionOwnerKey &&
        isBackgroundTaskActive(candidate.status),
    );
    return task?.status === "loading" ||
      task?.status === "transcribing" ||
      task?.status === "refining"
      ? task.status
      : null;
  });
  const readyVoiceTranscriptionTask = useBackgroundTaskStore(
    (store) =>
      store.tasks.find(
        (candidate) =>
          candidate.kind === "voice-transcription" &&
          candidate.ownerKey === transcriptionOwnerKey &&
          candidate.status === "ready" &&
          candidate.transcript !== null,
      ) ?? null,
  );
  const anyBackgroundVoiceTranscriptionActive = useBackgroundTaskStore((store) =>
    store.tasks.some(
      (candidate) =>
        candidate.kind === "voice-transcription" && isBackgroundTaskActive(candidate.status),
    ),
  );
  const visiblePushToTalkStatus = resolveVisiblePushToTalkStatus(
    pushToTalkStatus,
    backgroundPushToTalkStatus,
  );
  const visiblePushToTalkLabel =
    visiblePushToTalkStatus === "recording"
      ? "Recording voice note… release to attach"
      : visiblePushToTalkStatus === "loading"
        ? "Loading local transcription model…"
        : visiblePushToTalkStatus === "transcribing"
          ? "Transcribing…"
          : visiblePushToTalkStatus === "refining"
            ? "Refining transcription…"
            : null;
  const pushToTalkStatusRef = useRef(pushToTalkStatus);
  pushToTalkStatusRef.current = pushToTalkStatus;
  const pushToTalkEnabledRef = useRef(false);
  const pushToTalkStartRef = useRef<() => void>(() => undefined);
  const pushToTalkStopRef = useRef<() => void>(() => undefined);
  // Captured when the chord goes down so the transcript lands where the user
  // was dictating, even if focus moves while the recording transcribes.
  const pushToTalkTerminalTargetRef = useRef<PushToTalkTerminalTarget | null>(null);
  const resolvePushToTalkTerminalTargetRef = useRef<
    (eventTarget: EventTarget | null) => PushToTalkTerminalTarget | null
  >(() => null);
  const writePushToTalkTranscriptRef = useRef<
    (target: PushToTalkTerminalTarget, transcript: string) => Promise<void>
  >(() => Promise.resolve());
  const [maximizedRightPanelThreadKey, setMaximizedRightPanelThreadKey] = useState<string | null>(
    null,
  );
  const [respondingRequestIds, setRespondingRequestIds] = useState<ApprovalRequestId[]>([]);
  const [respondingUserInputRequestIds, setRespondingUserInputRequestIds] = useState<
    ApprovalRequestId[]
  >([]);
  const [pendingUserInputAnswersByRequestId, setPendingUserInputAnswersByRequestId] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});
  const [pendingUserInputQuestionIndexByRequestId, setPendingUserInputQuestionIndexByRequestId] =
    useState<Record<string, number>>({});
  const shouldUsePlanSidebarSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const hasCoarsePointer = useMediaQuery({ pointer: "coarse" });
  const isPhonePortraitViewport = useMediaQuery(THIN_PORTRAIT_MOBILE_MEDIA_QUERY);
  const usesOnScreenKeyboard = useOnScreenKeyboard();
  const appVoiceCaptureEnabled = shouldOfferAppVoiceCapture({
    isDesktopElectron: isElectron,
    hasCoarsePointer,
    // Must match the button's own availability check. If this one says no, the
    // push-to-talk effect never arms and the microphone renders as a control
    // that does nothing at all.
    hasAudioCapture:
      typeof MediaRecorder !== "undefined" &&
      typeof navigator !== "undefined" &&
      typeof navigator.mediaDevices?.getUserMedia === "function",
  });
  // Tracks whether the user explicitly dismissed the sidebar for the active turn.
  const planSidebarDismissedForTurnRef = useRef<string | null>(null);
  // When set, the thread-change reset effect will open the sidebar instead of closing it.
  // Used by "Implement in a new thread" to carry the sidebar-open intent across navigation.
  const planSidebarOpenOnNextThreadRef = useRef(false);
  const [terminalFocusRequestId, setTerminalFocusRequestId] = useState(0);
  const [pullRequestDialogState, setPullRequestDialogState] =
    useState<PullRequestDialogState | null>(null);
  const [terminalUiLaunchContext, setTerminalUiLaunchContext] =
    useState<TerminalLaunchContext | null>(null);
  const [attachmentPreviewHandoffByMessageId, setAttachmentPreviewHandoffByMessageId] = useState<
    Record<string, string[]>
  >({});
  const [pendingServerThreadEnvMode, setPendingServerThreadEnvMode] =
    useState<DraftThreadEnvMode | null>(null);
  const [pendingServerThreadBranch, setPendingServerThreadBranch] = useState<string | null>();
  const [
    pendingServerThreadStartFromOriginByThreadId,
    setPendingServerThreadStartFromOriginByThreadId,
  ] = useState<Record<string, boolean>>({});
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useLocalStorage(
    LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
    {},
    LastInvokedScriptByProjectSchema,
  );
  const legendListRef = useRef<LegendListRef | null>(null);
  const [composerOverlayElement, setComposerOverlayElement] = useState<HTMLDivElement | null>(null);
  const [composerOverlayHeight, setComposerOverlayHeight] = useState(0);
  const [phoneComposerFocused, setPhoneComposerFocused] = useState(false);
  const [phoneVisualViewportBottomInset, setPhoneVisualViewportBottomInset] = useState(0);
  const floatingFooterBottomInset = composerViewportBottomInset({
    composerHeight: composerOverlayHeight,
    keyboardInset: phoneVisualViewportBottomInset,
  });
  const isAtEndRef = useRef(true);
  const attachmentPreviewHandoffByMessageIdRef = useRef<Record<string, string[]>>({});
  const attachmentPreviewPromotionInFlightByMessageIdRef = useRef<Record<string, true>>({});
  const sendInFlightRef = useRef(false);
  const composerSendScopeRef = useRef(0);
  /**
   * A send the user made before the thread had finished loading or the socket
   * had reconnected. Held rather than refused, then replayed by the flush
   * effect below — waiting ten seconds for a spinner before you are allowed
   * to type is the thing being fixed.
   */
  const deferredSendOriginRef = useRef<{
    readonly origin: OrchestrationMessageInputOrigin | undefined;
    readonly threadKey: string | null;
  } | null>(null);
  const draftThreadPersistedRef = useRef(false);
  const persistDraftThreadPromiseRef = useRef<Promise<boolean> | null>(null);
  const activeThreadIdRef = useRef(threadId);
  activeThreadIdRef.current = threadId;
  const terminalUiOpenByThreadRef = useRef<Record<string, boolean>>({});

  useLayoutEffect(() => {
    if (!composerOverlayElement) return;

    const updateHeight = () => {
      const nextHeight = Math.ceil(composerOverlayElement.getBoundingClientRect().height);
      if (nextHeight <= 0) return;
      setComposerOverlayHeight((currentHeight) =>
        currentHeight === nextHeight ? currentHeight : nextHeight,
      );
    };

    updateHeight();
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(updateHeight);
    observer.observe(composerOverlayElement);
    return () => observer.disconnect();
  }, [composerOverlayElement]);

  useEffect(() => {
    if (!isPhonePortraitViewport || !composerOverlayElement) {
      setPhoneComposerFocused(false);
      return;
    }

    let blurFrame: number | null = null;
    const syncFocus = () => {
      const activeElement = document.activeElement;
      setPhoneComposerFocused(
        activeElement instanceof Node && composerOverlayElement.contains(activeElement),
      );
    };
    const onFocusIn = () => {
      if (blurFrame !== null) window.cancelAnimationFrame(blurFrame);
      syncFocus();
    };
    const onFocusOut = () => {
      if (blurFrame !== null) window.cancelAnimationFrame(blurFrame);
      blurFrame = window.requestAnimationFrame(() => {
        blurFrame = null;
        syncFocus();
      });
    };

    composerOverlayElement.addEventListener("focusin", onFocusIn);
    composerOverlayElement.addEventListener("focusout", onFocusOut);
    syncFocus();
    return () => {
      if (blurFrame !== null) window.cancelAnimationFrame(blurFrame);
      composerOverlayElement.removeEventListener("focusin", onFocusIn);
      composerOverlayElement.removeEventListener("focusout", onFocusOut);
    };
  }, [composerOverlayElement, isPhonePortraitViewport]);

  useLayoutEffect(() => {
    if (!isPhonePortraitViewport || !composerOverlayElement) {
      setPhoneVisualViewportBottomInset(0);
      return;
    }

    const visualViewport = window.visualViewport;
    const updateInset = () => {
      const paneBottom =
        composerOverlayElement.parentElement?.getBoundingClientRect().bottom ?? window.innerHeight;
      setPhoneVisualViewportBottomInset((currentInset) =>
        visualViewport
          ? resolvePhoneKeyboardInset({
              paneBottom,
              visualViewportHeight: visualViewport.height,
              visualViewportOffsetTop: visualViewport.offsetTop,
              composerFocused: phoneComposerFocused,
              currentInset,
            })
          : 0,
      );
    };

    updateInset();
    visualViewport?.addEventListener("resize", updateInset);
    visualViewport?.addEventListener("scroll", updateInset);
    window.addEventListener("resize", updateInset);
    return () => {
      visualViewport?.removeEventListener("resize", updateInset);
      visualViewport?.removeEventListener("scroll", updateInset);
      window.removeEventListener("resize", updateInset);
    };
  }, [composerOverlayElement, isPhonePortraitViewport, phoneComposerFocused]);

  const terminalUiState = useTerminalUiStateStore((state) =>
    selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef),
  );
  const storeSetMainSurface = useTerminalUiStateStore((state) => state.setMainSurface);
  const storeSetTerminalFullscreen = useTerminalUiStateStore(
    (state) => state.setTerminalFullscreen,
  );
  const terminalMainSurfaceActive = !agentSurfaces && terminalUiState.mainSurface === "terminal";
  const phoneTerminalLayout = useMediaQuery(PHONE_TERMINAL_LAYOUT_MEDIA_QUERY);
  const terminalFullscreen = resolveTerminalModeFullscreen({
    phoneLayout: phoneTerminalLayout,
    storedFullscreen: terminalUiState.terminalFullscreen,
  });
  const storeSplitTerminal = useTerminalUiStateStore((s) => s.splitTerminal);
  const storeSplitTerminalVertical = useTerminalUiStateStore((s) => s.splitTerminalVertical);
  const storeNewTerminal = useTerminalUiStateStore((s) => s.newTerminal);
  const storeSetActiveTerminal = useTerminalUiStateStore((s) => s.setActiveTerminal);
  const storeCloseTerminal = useTerminalUiStateStore((s) => s.closeTerminal);
  const storeRejectPendingTerminalOpen = useTerminalUiStateStore(
    (state) => state.rejectPendingTerminalOpen,
  );

  const fallbackDraftProjectRef = draftThread
    ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
    : null;
  const fallbackDraftProject = useProject(fallbackDraftProjectRef);
  const localDraftError = activeServerThread
    ? null
    : ((draftId ? localDraftErrorsByDraftId[draftId]?.message : null) ?? null);
  const localServerErrorEntry = localServerErrorsByThreadKey[routeThreadKey];
  // Draft errors are keyed by draftId while server errors are keyed by thread
  // key, so a pending draft entry must migrate when the server thread loads or
  // a failed send would silently disappear on promotion. When both keys hold
  // an entry, the most recent write wins.
  useEffect(() => {
    if (!activeServerThread || !draftId) {
      return;
    }
    const pendingDraftEntry = localDraftErrorsByDraftId[draftId];
    if (pendingDraftEntry === undefined) {
      return;
    }
    setLocalDraftErrorsByDraftId((existing) => {
      if (existing[draftId] === undefined) {
        return existing;
      }
      const next = { ...existing };
      delete next[draftId];
      return next;
    });
    setLocalServerErrorsByThreadKey((existing) => {
      const currentEntry = existing[routeThreadKey];
      if (
        currentEntry !== undefined &&
        (currentEntry.at > pendingDraftEntry.at ||
          currentEntry.message === pendingDraftEntry.message)
      ) {
        return existing;
      }
      return {
        ...existing,
        [routeThreadKey]: pendingDraftEntry,
      };
    });
  }, [activeServerThread, draftId, localDraftErrorsByDraftId, routeThreadKey]);
  const localDraftThread = useMemo(
    () =>
      draftThread
        ? buildLocalDraftThread(
            threadId,
            draftThread,
            fallbackDraftProject?.defaultModelSelection ?? NO_PROVIDER_MODEL_SELECTION,
          )
        : undefined,
    [draftThread, fallbackDraftProject?.defaultModelSelection, threadId],
  );
  // Promotion is data-driven: the draft route keeps rendering while the
  // server thread (same pre-allocated ref) starts, so live state must not
  // depend on which route is mounted.
  const isServerThread = activeServerThread !== null;
  const activeThread = activeServerThread ?? localDraftThread;
  const activeThreadKey = activeThread
    ? scopedThreadKey(scopeThreadRef(activeThread.environmentId, activeThread.id))
    : null;
  const activeThreadKeyRef = useRef(activeThreadKey);
  activeThreadKeyRef.current = activeThreadKey;
  const chatViewMountedRef = useRef(false);
  useEffect(() => {
    chatViewMountedRef.current = true;
    return () => {
      chatViewMountedRef.current = false;
    };
  }, []);

  const activeQueuedMessagePromotionState = activeThreadKey
    ? queuedMessagePromotionPhases[activeThreadKey]
    : undefined;
  const queuedMessagePromotionInFlight = activeQueuedMessagePromotionState !== undefined;
  // Same lookup `activeEnvironment` makes further down; the pause is derived
  // here because `threadError` below already depends on it.
  const activeThreadEnvironmentProviders =
    (activeThread == null
      ? undefined
      : environmentById.get(activeThread.environmentId)?.serverConfig?.providers) ??
    EMPTY_PROVIDERS;
  const activeThreadProviderAuthStatus = resolveThreadProviderAuthStatus({
    instanceId:
      activeThread?.session?.providerInstanceId ?? activeThread?.modelSelection.instanceId ?? null,
    providers: activeThreadEnvironmentProviders,
  });
  const activeProviderAuthenticationPaused = isProviderAuthenticationPauseActive({
    sessionStatus: activeThread?.session?.status,
    sessionLastError: activeThread?.session?.lastError,
    providerAuthStatus: activeThreadProviderAuthStatus,
  });
  const threadError = activeProviderAuthenticationPaused
    ? null
    : isServerThread
      ? resolveVisibleServerThreadError(
          localServerErrorEntry,
          activeServerThread?.session?.lastError,
          dismissedServerErrorsByThreadKey[routeThreadKey] ?? null,
        )
      : localDraftError;
  const hostRepairErrorKey =
    isServerThread && threadError && isHostRepairEligibleThreadError(threadError)
      ? `${routeThreadKey}:${activeServerThread?.session?.updatedAt ?? "local"}:${threadError}`
      : null;
  const runtimeMode = composerRuntimeMode ?? activeThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const interactionMode =
    composerInteractionMode ?? activeThread?.interactionMode ?? DEFAULT_INTERACTION_MODE;
  // `interactionMode` above is the *staged* composer value — it changes the
  // instant the picker is touched, which is what the composer should render.
  // Agent continuation must not read it. Agent mode only governs a thread once it
  // has actually been applied (via Apply, or by the first send of a local draft
  // creating the thread with it), so keying the loop off the staged value made
  // merely picking "Agent" start sending with no configuration update at all.
  const appliedInteractionMode = activeThread?.interactionMode ?? DEFAULT_INTERACTION_MODE;
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined;
  const canCheckoutPullRequestIntoThread = isLocalDraftThread;
  const activeThreadId = activeThread?.id ?? null;
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: activeThread?.environmentId ?? null,
    threadId: activeThreadId,
  });
  const activeThreadKnownSessionsRaw = useKnownTerminalSessions({
    environmentId: activeThread?.environmentId ?? null,
    threadId: activeThreadId,
  });
  const activeThreadKnownSessions = useMemo(() => {
    if (activeThreadId === null) {
      return [];
    }
    return activeThreadKnownSessionsRaw.filter(
      (session) => session.target.threadId === activeThreadId,
    );
  }, [activeThreadId, activeThreadKnownSessionsRaw]);
  const activeServerOrderedTerminalIds = useMemo(
    () => activeThreadKnownSessions.map((session) => session.target.terminalId),
    [activeThreadKnownSessions],
  );
  const activeKnownTerminalIds = useMemo(
    () => [...new Set([...activeServerOrderedTerminalIds, ...terminalUiState.terminalIds])],
    [activeServerOrderedTerminalIds, terminalUiState.terminalIds],
  );
  const activeTerminalLabelsById = useMemo(() => {
    const labels = new Map<string, string>();
    for (const session of activeThreadKnownSessions) {
      labels.set(
        session.target.terminalId,
        resolveTerminalSessionLabel(session.target.terminalId, session.state.summary),
      );
    }
    return labels;
  }, [activeThreadKnownSessions]);
  const activeTerminalActivity = useMemo(
    () => deriveWorkingTerminalActivity(activeThreadKnownSessions),
    [activeThreadKnownSessions],
  );
  const activeThreadRef = useMemo(
    () => (activeThread ? scopeThreadRef(activeThread.environmentId, activeThread.id) : null),
    [activeThread],
  );
  // Fullscreen is a multi-pane affordance: once a single terminal remains the
  // layout drops back so the pane never sits maximised with nothing to hide.
  // A phone is exempt. There the tabbed layout is the only readable one, and a
  // phone is usually down to exactly one terminal -- so this rule fired on the
  // common case and kept pulling terminal mode back out of full screen.
  useEffect(() => {
    if (
      !phoneTerminalLayout &&
      terminalFullscreen &&
      activeThreadRef &&
      terminalUiState.terminalIds.length <= 1
    ) {
      storeSetTerminalFullscreen(activeThreadRef, false);
    }
  }, [
    activeThreadRef,
    phoneTerminalLayout,
    storeSetTerminalFullscreen,
    terminalFullscreen,
    terminalUiState.terminalIds.length,
  ]);
  const runPushToTalkTerminalWrite = useAtomCommand(terminalEnvironment.write, "terminal write");
  resolvePushToTalkTerminalTargetRef.current = (eventTarget) => {
    if (!activeThreadRef) return null;
    const targetNode = eventTarget instanceof Node ? eventTarget : document.activeElement;
    const targetElement =
      targetNode instanceof Element ? targetNode : (targetNode?.parentElement ?? null);
    const paneTerminalId = targetElement
      ?.closest("[data-terminal-pane-id]")
      ?.getAttribute("data-terminal-pane-id");
    const terminalId = paneTerminalId || terminalUiState.activeTerminalId;
    if (
      !shouldRouteTranscriptToTerminal({
        targetWithinTerminalSurface: Boolean(targetElement?.closest("[data-terminal-owner]")),
        terminalMainSurfaceActive,
        activeTerminalId: terminalId,
      })
    ) {
      return null;
    }
    return {
      environmentId: activeThreadRef.environmentId,
      threadId: activeThreadRef.threadId,
      terminalId,
    };
  };
  writePushToTalkTranscriptRef.current = async (target, transcript) => {
    const result = await runPushToTalkTerminalWrite({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, terminalId: target.terminalId, data: transcript },
    });
    if (result._tag === "Failure") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Transcript not delivered",
          description: "The transcribed text could not be typed into the terminal.",
        }),
      );
    }
  };
  const persistComposerModelDefaults = shouldPersistComposerModelDefaults({
    embeddedSideChat,
    threadIsSideChat: activeThread?.isSideChat === true,
  });
  const allThreadShells = useThreadShells();
  const startupResumePendingByThreadKey = useStartupResumeStore(
    (state) => state.pendingStartedAtByThreadKey,
  );
  const [closingSideChatThreadIds, setClosingSideChatThreadIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pendingSideChatArchives, setPendingSideChatArchives] = useState<
    readonly PendingSideChatArchive[]
  >([]);
  const [archivingSideChatThreadId, setArchivingSideChatThreadId] = useState<string | null>(null);
  const [promotingSideChatThreadId, setPromotingSideChatThreadId] = useState<string | null>(null);
  const sideChatChildShells = useMemo(
    () =>
      activeThreadRef
        ? allThreadShells.filter(
            (thread) =>
              thread.environmentId === activeThreadRef.environmentId &&
              thread.isSideChat === true &&
              thread.sideChatParentThreadId === activeThreadRef.threadId &&
              thread.archivedAt === null,
          )
        : [],
    [activeThreadRef, allThreadShells],
  );
  const allSideChatChildren = useMemo(
    () =>
      sideChatChildShells.map((thread) => ({
        threadId: thread.id,
        title: sideChatDisplayTitle(thread.title),
      })),
    [sideChatChildShells],
  );
  const sideChatChildren = useMemo(
    () => allSideChatChildren.filter((thread) => !closingSideChatThreadIds.has(thread.threadId)),
    [allSideChatChildren, closingSideChatThreadIds],
  );
  const activeSideChatActivity = useMemo(() => {
    if (!activeThreadRef) return null;
    return (
      deriveWorkingSideChatsByParent(
        sideChatChildShells.filter((thread) => !closingSideChatThreadIds.has(thread.id)),
        startupResumePendingByThreadKey,
      ).get(sideChatParentActivityKey(activeThreadRef.environmentId, activeThreadRef.threadId)) ??
      null
    );
  }, [
    activeThreadRef,
    closingSideChatThreadIds,
    sideChatChildShells,
    startupResumePendingByThreadKey,
  ]);
  /**
   * A waiting-on-you request the user tagged onto this message. Sending the
   * message is what closes it out, so it is read here rather than in the card.
   */
  const waitingOnYouAttachment = useWaitingOnYouAttachment(activeThreadKey);
  const activeRightPanelKind = useRightPanelStore((state) =>
    selectActiveRightPanel(state.byThreadKey, activeThreadRef),
  );
  const diffOpen = activeRightPanelKind === "diff";
  const rightPanelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, activeThreadRef),
  );
  const activeRightPanelSurface = useRightPanelStore((state) =>
    selectActiveRightPanelSurface(state.byThreadKey, activeThreadRef),
  );
  const activeFileSurface =
    activeRightPanelSurface?.kind === "file" ? activeRightPanelSurface : null;
  const activePreviewState = useThreadPreviewState(activeThreadRef);
  // Flattened to a plain controller-per-tab map so the tab strip re-renders on
  // a controller change alone, not on every navigation or zoom the overlay
  // also carries.
  const pendingPreviewDownloadApprovals = useMemo(() => {
    const pending: DesktopPreviewOverlay["pendingDownloadApprovals"][number][] = [];
    for (const overlay of Object.values(activePreviewState.desktopByTabId)) {
      pending.push(...overlay.pendingDownloadApprovals);
    }
    return pending;
  }, [activePreviewState.desktopByTabId]);
  // A client with no desktop overlay (a phone) reads who drives each tab from
  // what the rendering desktop reported on it. Recomputed when that report
  // changes, not on every navigation that also replaces the tab's snapshot.
  const reportedPreviewControlKey = Object.values(activePreviewState.sessions)
    .map((session) => `${session.tabId}:${session.agentControl ?? "none"}`)
    .join(",");
  const previewControllerByTabId = useMemo(() => {
    const entries: Record<string, Pick<DesktopPreviewOverlay, "controller" | "agentActive">> = {};
    for (const session of Object.values(activePreviewState.sessions)) {
      if (session.agentControl === undefined || session.agentControl === "none") continue;
      entries[session.tabId] = previewControllerFromAgentControl(session.agentControl);
    }
    for (const [tabId, overlay] of Object.entries(activePreviewState.desktopByTabId)) {
      entries[tabId] = { controller: overlay.controller, agentActive: overlay.agentActive };
    }
    return entries;
  }, [activePreviewState.desktopByTabId, reportedPreviewControlKey]);
  const activePreviewMiniPlayer = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayer(state.byThreadKey, activeThreadRef),
  );
  const floatingPreviewTabIds = useMemo(() => {
    const tabIds = new Set<string>();
    if (activePreviewMiniPlayer) tabIds.add(activePreviewMiniPlayer.tabId);
    for (const [tabId, desktop] of Object.entries(activePreviewState.desktopByTabId)) {
      if (desktop.pictureInPicture) tabIds.add(tabId);
    }
    return tabIds;
  }, [activePreviewMiniPlayer, activePreviewState.desktopByTabId]);
  const panelTerminalIds = useMemo(
    () =>
      new Set(
        rightPanelState.surfaces.flatMap((surface) =>
          surface.kind === "terminal" ? surface.terminalIds : [],
        ),
      ),
    [rightPanelState.surfaces],
  );
  const previewPanelOpen = activeRightPanelKind === "preview" && isPreviewSupportedInRuntime();
  const rightPanelOpen = rightPanelState.isOpen;
  const visibleRightPanelOpen = !embeddedSideChat && rightPanelOpen && !terminalMainSurfaceActive;
  const canMaximizeRightPanel = visibleRightPanelOpen && !shouldUsePlanSidebarSheet;
  const rightPanelMaximized =
    canMaximizeRightPanel && maximizedRightPanelThreadKey === routeThreadKey;
  const inlineRightPanelOwnsTitleBar = visibleRightPanelOpen && !shouldUsePlanSidebarSheet;
  const showWorkspaceHeader = !embeddedSideChat && !hideWorkspaceHeader;
  const focusedRightPanelThreadKeyRef = useRef<string | null>(null);

  const sideChatAvailable =
    !embeddedSideChat &&
    isServerThread &&
    activeThread?.isSideChat !== true &&
    readEnvironmentSupportsSideChats(environmentId);

  useEffect(() => {
    if (!activeThreadRef) return;
    useRightPanelStore.getState().reconcileSideChatSurfaces(activeThreadRef, sideChatChildren);
  }, [activeThreadRef, sideChatChildren]);

  useLayoutEffect(() => {
    const focus = resolveRightPanelThreadFocus(
      focusedRightPanelThreadKeyRef.current,
      activeThreadKey,
    );
    focusedRightPanelThreadKeyRef.current = focus.focusedThreadKey;
    if (activeThreadRef && focus.shouldCloseEmptyPanel && !agentSurfaces) {
      useRightPanelStore.getState().closeEmptyOnFocus(activeThreadRef);
    }
  }, [activeThreadKey, activeThreadRef, agentSurfaces]);

  useEffect(() => {
    const presentThreadIds = new Set(allSideChatChildren.map((thread) => thread.threadId));
    setClosingSideChatThreadIds((current) =>
      retainClosingSideChatThreadIds(current, presentThreadIds),
    );
  }, [allSideChatChildren]);

  useEffect(() => {
    if (!activeThreadRef) return;
    reconcileHydratedBrowserSurfaces(activeThreadRef, {
      serverEpoch: activePreviewState.serverEpoch,
      sessions: activePreviewState.sessions,
    });
  }, [activePreviewState.serverEpoch, activePreviewState.sessions, activeThreadRef]);

  useEffect(() => {
    if (!activeThreadRef || !activePreviewMiniPlayer) return;
    const miniTabStillExists = Boolean(activePreviewState.sessions[activePreviewMiniPlayer.tabId]);
    const sameTabOpenInPanel =
      previewPanelOpen &&
      activeRightPanelSurface?.kind === "preview" &&
      activeRightPanelSurface.resourceId === activePreviewMiniPlayer.tabId;
    if (!miniTabStillExists || sameTabOpenInPanel) {
      usePreviewMiniPlayerStore.getState().close(activeThreadRef);
    }
  }, [
    activePreviewMiniPlayer,
    activePreviewState.sessions,
    activeRightPanelSurface,
    activeThreadRef,
    previewPanelOpen,
  ]);

  const planSidebarOpen = activeRightPanelKind === "plan";

  const activeLatestTurn = activeThread?.latestTurn ?? null;
  const sourcePlanThreadRef = useMemo(() => {
    const sourceThreadId = activeLatestTurn?.sourceProposedPlan?.threadId;
    if (!activeThread || !sourceThreadId || sourceThreadId === activeThread.id) {
      return null;
    }
    return scopeThreadRef(activeThread.environmentId, sourceThreadId);
  }, [activeLatestTurn?.sourceProposedPlan?.threadId, activeThread]);
  const sourceThreadProposedPlans = useThreadProposedPlans(sourcePlanThreadRef);
  const threadPlanCatalog = useMemo<ThreadPlanCatalogEntry[]>(() => {
    if (!activeThread) {
      return [];
    }
    const entries: ThreadPlanCatalogEntry[] = [
      { id: activeThread.id, proposedPlans: activeThread.proposedPlans },
    ];
    if (sourcePlanThreadRef) {
      entries.push({
        id: sourcePlanThreadRef.threadId,
        proposedPlans: sourceThreadProposedPlans,
      });
    }
    return entries;
  }, [activeThread, sourcePlanThreadRef, sourceThreadProposedPlans]);
  const latestTurnSettled = isLatestTurnSettled(activeLatestTurn, activeThread?.session ?? null);
  const activeProjectRef = activeThread
    ? scopeProjectRef(activeThread.environmentId, activeThread.projectId)
    : null;
  const activeProject = useProject(activeProjectRef);
  const visibleProjectScripts = useMemo(
    () =>
      activeProject
        ? scriptsForThread(activeProject.scripts, activeProject.id, activeThreadId)
        : [],
    [activeProject, activeThreadId],
  );
  const openTerminalWithRollback = useCallback(
    async (
      threadRef: ScopedThreadRef,
      terminalId: string,
      input: TerminalOpenInput,
      rollbackSurface?: () => void,
    ) => {
      const result = await openTerminal({ environmentId: threadRef.environmentId, input });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        storeRejectPendingTerminalOpen(threadRef, terminalId);
        rollbackSurface?.();
      }
      return result;
    },
    [openTerminal, storeRejectPendingTerminalOpen],
  );
  const handleNewThreadInActiveProject = useCallback(() => {
    startNewThreadForProject(activeProjectRef, handleNewThread);
  }, [activeProjectRef, handleNewThread]);
  const persistLocalDraftThread = useCallback(
    (options?: { notify?: boolean }): Promise<boolean> => {
      if (draftThreadPersistedRef.current || isServerThread) {
        return Promise.resolve(true);
      }
      if (persistDraftThreadPromiseRef.current) {
        return persistDraftThreadPromiseRef.current;
      }
      if (
        !shouldCreateServerThreadForTerminalStart({
          isLocalDraftThread,
          isServerThread,
        }) ||
        !activeThread ||
        !activeProject
      ) {
        return Promise.resolve(false);
      }
      const notify = options?.notify !== false;
      const threadRef = scopeThreadRef(activeThread.environmentId, activeThread.id);
      const persistedThreadId = activeThread.id;
      const promise = (async () => {
        const sendCtx = composerRef.current?.getSendContext();
        const modelSelection = resolveDraftThreadCreateModelSelection({
          composerModelSelection: sendCtx?.selectedModelSelection,
          projectDefaultModelSelection: activeProject.defaultModelSelection,
        });
        if (modelSelection === null) {
          if (notify) {
            toastManager.add(
              stackedThreadToast({
                type: "warning",
                title: "Could not save thread",
                description: "No model is configured, so this workspace was not stored.",
              }),
            );
          }
          return false;
        }
        const createResult = await createThread({
          environmentId,
          input: {
            threadId: persistedThreadId,
            projectId: activeProject.id,
            title: truncate(activeThread.title || "New thread"),
            modelSelection,
            runtimeMode,
            interactionMode,
            branch: activeThread.branch,
            worktreePath: activeThread.worktreePath,
            createdAt: activeThread.createdAt,
          },
        });
        if (activeThreadIdRef.current !== persistedThreadId) {
          return false;
        }
        if (createResult._tag === "Failure") {
          if (isAtomCommandInterrupted(createResult)) {
            return false;
          }
          const error = squashAtomCommandFailure(createResult);
          if (isThreadAlreadyExistsError(error)) {
            draftThreadPersistedRef.current = true;
            markPromotedDraftThreadByRef(threadRef);
            return true;
          }
          if (notify) {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Could not save thread",
                description:
                  error instanceof Error ? error.message : "The terminal workspace was not stored.",
              }),
            );
          }
          return false;
        }
        draftThreadPersistedRef.current = true;
        markPromotedDraftThreadByRef(threadRef);
        return true;
      })();
      persistDraftThreadPromiseRef.current = promise;
      void promise.finally(() => {
        if (persistDraftThreadPromiseRef.current === promise) {
          persistDraftThreadPromiseRef.current = null;
        }
      });
      return promise;
    },
    [
      activeProject,
      activeThread,
      createThread,
      environmentId,
      interactionMode,
      isLocalDraftThread,
      isServerThread,
      runtimeMode,
    ],
  );
  useEffect(() => {
    draftThreadPersistedRef.current = false;
    persistDraftThreadPromiseRef.current = null;
  }, [threadId]);
  useEffect(() => {
    if (isServerThread) {
      draftThreadPersistedRef.current = true;
    }
  }, [isServerThread]);
  const persistLocalDraftThreadRef = useRef(persistLocalDraftThread);
  persistLocalDraftThreadRef.current = persistLocalDraftThread;
  const handleMainSurfaceChange = useCallback(
    (surface: "chat" | "terminal") => {
      if (!routeThreadRef || agentSurfaces) {
        return;
      }
      // A thread with no terminals shows the launch pad instead of an
      // auto-opened shell, so the first switch never spawns anything.
      storeSetMainSurface(routeThreadRef, surface);
      if (surface === "terminal") {
        void persistLocalDraftThreadRef.current();
      }
    },
    [agentSurfaces, routeThreadRef, storeSetMainSurface],
  );
  useEffect(() => {
    if (terminalMainSurfaceActive) {
      void persistLocalDraftThreadRef.current({ notify: false });
    }
  }, [terminalMainSurfaceActive]);
  const activeEnvironmentShell = useEnvironmentQuery(
    activeThread ? environmentShell.stateAtom(activeThread.environmentId) : null,
  );
  const deferredCommands = useEnvironmentQuery(environmentShell.deferredAtom(environmentId));
  const pendingSends = useMemo(
    () =>
      (deferredCommands.data ?? []).filter(
        (entry) =>
          entry.command.type === "thread.turn.start" && entry.command.threadId === threadId,
      ),
    [deferredCommands.data, threadId],
  );
  const recoveredSendMessages = useMemo(
    () => pendingSendMessages(pendingSends, threadId),
    [pendingSends, threadId],
  );
  const outboxMessages = useMemo(
    () =>
      pendingSends.flatMap((entry): OfflineOutboxMessage[] =>
        !entry.accepted && entry.command.type === "thread.turn.start"
          ? [
              {
                id: entry.command.commandId,
                text: entry.command.message.text,
                attachmentCount: entry.command.message.attachments.length,
                savedAt: entry.enqueuedAt,
                error: entry.error,
              },
            ]
          : [],
      ),
    [pendingSends],
  );
  const updateOutboxMessage = useAtomCommand(threadEnvironment.updateOutboxMessage);
  const outboxChipPhase = useOfflineOutboxChipPhase(outboxMessages);
  const resolveOutboxMessage = (commandId: string, action: "retry" | "discard") =>
    void updateOutboxMessage({
      environmentId,
      input: { threadId, commandId: CommandId.make(commandId), action },
    });
  const activeEnvironmentBootstrapComplete = activeEnvironmentShell.data?.snapshot._tag === "Some";
  const activeProjectKey = activeProject
    ? `${activeProject.environmentId}:${activeProject.workspaceRoot}`
    : null;
  const [pendingFileSurfaceIdsByProject, setPendingFileSurfaceIdsByProject] = useState<
    ReadonlyMap<string, ReadonlySet<string>>
  >(() => new Map());
  const pendingFileSurfaceIds = activeProjectKey
    ? (pendingFileSurfaceIdsByProject.get(activeProjectKey) ?? EMPTY_PENDING_FILE_SURFACE_IDS)
    : EMPTY_PENDING_FILE_SURFACE_IDS;
  const handleFilePendingChange = useCallback(
    (relativePath: string, pending: boolean) => {
      if (!activeProjectKey) return;
      setPendingFileSurfaceIdsByProject((currentByProject) => {
        const current = currentByProject.get(activeProjectKey) ?? EMPTY_PENDING_FILE_SURFACE_IDS;
        const surfaceId = `file:${relativePath}`;
        if (current.has(surfaceId) === pending) return currentByProject;
        const next = new Set(current);
        if (pending) next.add(surfaceId);
        else next.delete(surfaceId);
        const nextByProject = new Map(currentByProject);
        if (next.size === 0) nextByProject.delete(activeProjectKey);
        else nextByProject.set(activeProjectKey, next);
        return nextByProject;
      });
    },
    [activeProjectKey],
  );
  const configuredPreviewUrls = useMemo(
    () => getConfiguredPreviewUrls(visibleProjectScripts),
    [visibleProjectScripts],
  );

  useEffect(() => {
    if (!activeThreadRef || !activeEnvironmentBootstrapComplete) return;
    useRightPanelStore.getState().reconcileFileSurfaces(activeThreadRef, activeProject !== null);
  }, [activeEnvironmentBootstrapComplete, activeProject, activeThreadRef]);

  // Compute the list of environments this logical project spans, used to
  // drive the environment picker in BranchToolbar.
  const allProjects = useProjects();
  const primaryEnvironmentId = primaryEnvironment?.environmentId ?? null;
  const activeEnvironment =
    activeThread == null ? null : (environmentById.get(activeThread.environmentId) ?? null);
  const activeEnvironmentConnectionPhase = activeEnvironment?.connection.phase ?? "available";
  const composerEnvironment = environmentById.get(environmentId) ?? null;
  const canReferenceLocalFiles = canReferenceLocalComposerFiles({
    hasDesktopPathResolver:
      typeof window !== "undefined" && typeof window.desktopBridge?.getPathForFile === "function",
    // Drafts do not have an active thread yet, so resolve against the route's
    // environment instead of the thread-derived environment.
    environmentTargetKind: composerEnvironment?.entry.target._tag ?? null,
  });
  const activeEnvironmentUnavailable =
    activeEnvironment !== null && activeEnvironmentConnectionPhase !== "connected";
  const canQueueLocalMessage = canQueueLocalMessageDuringReconnect({
    targetKind: activeEnvironment?.entry.target._tag ?? null,
    phase: activeEnvironmentConnectionPhase,
    threadDetailLoaded: activeThread !== null && !threadDetailLoading,
  });
  const showThreadSyncOverlay = threadSyncPhase !== null && !activeEnvironmentUnavailable;
  const activeEnvironmentUnavailableLabel = activeEnvironment?.label ?? null;
  const activeEnvironmentUnavailableState = useMemo<EnvironmentUnavailableState | null>(() => {
    if (!activeEnvironmentUnavailable || !activeEnvironmentUnavailableLabel || !activeEnvironment) {
      return null;
    }

    return {
      environmentId: activeEnvironment.environmentId,
      label: activeEnvironmentUnavailableLabel,
      connection: activeEnvironment.connection,
    };
  }, [activeEnvironment, activeEnvironmentUnavailable, activeEnvironmentUnavailableLabel]);
  const handleReconnectActiveEnvironment = useCallback(
    async (environmentId: EnvironmentId) => {
      const result = await retryEnvironment(environmentId);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not reconnect environment",
            description: error instanceof Error ? error.message : "Failed to reconnect.",
          }),
        );
      }
    },
    [retryEnvironment],
  );
  const projectGroupingSettings = selectProjectGroupingSettings(settings);
  const logicalProjectEnvironments = useMemo(() => {
    if (!activeProject) return [];
    const logicalKey = deriveLogicalProjectKeyFromSettings(activeProject, projectGroupingSettings);
    const memberProjects = allProjects.filter(
      (p) => deriveLogicalProjectKeyFromSettings(p, projectGroupingSettings) === logicalKey,
    );
    const seen = new Set<string>();
    const envs: Array<{
      environmentId: EnvironmentId;
      projectId: ProjectId;
      label: string;
      isPrimary: boolean;
    }> = [];
    for (const p of memberProjects) {
      if (seen.has(p.environmentId)) continue;
      seen.add(p.environmentId);
      const isPrimary = p.environmentId === primaryEnvironmentId;
      const label = environmentById.get(p.environmentId)?.label ?? p.environmentId;
      envs.push({
        environmentId: p.environmentId,
        projectId: p.id,
        label,
        isPrimary,
      });
    }
    // Sort: primary first, then alphabetical
    envs.sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
    return envs;
  }, [activeProject, allProjects, projectGroupingSettings, primaryEnvironmentId, environmentById]);
  const hasMultipleEnvironments = logicalProjectEnvironments.length > 1;

  const openPullRequestDialog = useCallback(
    (reference?: string) => {
      if (!canCheckoutPullRequestIntoThread) {
        return;
      }
      setPullRequestDialogState({
        initialReference: reference ?? null,
        key: Date.now(),
      });
    },
    [canCheckoutPullRequestIntoThread],
  );

  const closePullRequestDialog = useCallback(() => {
    setPullRequestDialogState(null);
  }, []);

  const openOrReuseProjectDraftThread = useCallback(
    async (input: { branch: string; worktreePath: string | null; envMode: DraftThreadEnvMode }) => {
      if (!activeProject) {
        throw new Error("No active project is available for this pull request.");
      }
      const activeProjectRef = scopeProjectRef(activeProject.environmentId, activeProject.id);
      const logicalProjectKey = deriveLogicalProjectKeyFromSettings(
        activeProject,
        projectGroupingSettings,
      );
      const storedDraftSession = getDraftSessionByLogicalProjectKey(logicalProjectKey);
      if (storedDraftSession) {
        setDraftThreadContext(storedDraftSession.draftId, input);
        setLogicalProjectDraftThreadId(
          logicalProjectKey,
          activeProjectRef,
          storedDraftSession.draftId,
          {
            threadId: storedDraftSession.threadId,
            ...input,
          },
        );
        if (routeKind !== "draft" || draftId !== storedDraftSession.draftId) {
          await navigate({
            to: "/draft/$draftId",
            params: buildDraftThreadRouteParams(storedDraftSession.draftId),
          });
        }
        return storedDraftSession.threadId;
      }

      const activeDraftSession = routeKind === "draft" && draftId ? getDraftSession(draftId) : null;
      if (
        !isServerThread &&
        activeDraftSession?.logicalProjectKey === logicalProjectKey &&
        draftId
      ) {
        setDraftThreadContext(draftId, input);
        setLogicalProjectDraftThreadId(logicalProjectKey, activeProjectRef, draftId, {
          threadId: activeDraftSession.threadId,
          createdAt: activeDraftSession.createdAt,
          runtimeMode: activeDraftSession.runtimeMode,
          interactionMode: activeDraftSession.interactionMode,
          ...input,
        });
        return activeDraftSession.threadId;
      }

      const nextDraftId = newDraftId();
      const nextThreadId = newThreadId();
      setLogicalProjectDraftThreadId(logicalProjectKey, activeProjectRef, nextDraftId, {
        threadId: nextThreadId,
        createdAt: new Date().toISOString(),
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        ...input,
      });
      await navigate({
        to: "/draft/$draftId",
        params: buildDraftThreadRouteParams(nextDraftId),
      });
      return nextThreadId;
    },
    [
      activeProject,
      draftId,
      getDraftSession,
      getDraftSessionByLogicalProjectKey,
      isServerThread,
      navigate,
      projectGroupingSettings,
      routeKind,
      setDraftThreadContext,
      setLogicalProjectDraftThreadId,
    ],
  );

  const handlePreparedPullRequestThread = useCallback(
    async (input: { branch: string; worktreePath: string | null }) => {
      await openOrReuseProjectDraftThread({
        branch: input.branch,
        worktreePath: input.worktreePath,
        envMode: input.worktreePath ? "worktree" : "local",
      });
    },
    [openOrReuseProjectDraftThread],
  );

  useEffect(() => {
    if (!serverThread?.id) return;
    const threadUpdatedAt = Date.parse(serverThread.updatedAt);
    if (Number.isNaN(threadUpdatedAt)) return;
    const lastVisitedAt = activeThreadLastVisitedAt ? Date.parse(activeThreadLastVisitedAt) : NaN;
    if (!Number.isNaN(lastVisitedAt) && lastVisitedAt >= threadUpdatedAt) return;

    markThreadVisited(
      scopedThreadKey(scopeThreadRef(serverThread.environmentId, serverThread.id)),
      serverThread.updatedAt,
    );
  }, [
    activeThreadLastVisitedAt,
    markThreadVisited,
    serverThread?.environmentId,
    serverThread?.id,
    serverThread?.updatedAt,
  ]);

  const selectedProviderByThreadId = composerActiveProvider ?? null;
  useLayoutEffect(() => {
    if (!isServerThread || !activeThread || !activeThreadKey) return;
    const fingerprint = authoritativeThreadSettingsFingerprint(activeThread);
    if (observedAuthoritativeThreadSettings.get(activeThreadKey) === fingerprint) return;
    observedAuthoritativeThreadSettings.set(activeThreadKey, fingerprint);
    const nextSelection = activeThread.modelSelection;
    setComposerDraftModelSelection(
      scopeThreadRef(activeThread.environmentId, activeThread.id),
      nextSelection,
      { replaceOptions: true },
    );
    setComposerDraftRuntimeMode(composerDraftTarget, activeThread.runtimeMode);
    setComposerDraftInteractionMode(composerDraftTarget, activeThread.interactionMode);
  }, [
    activeThread,
    activeThreadKey,
    composerDraftTarget,
    isServerThread,
    setComposerDraftInteractionMode,
    setComposerDraftModelSelection,
    setComposerDraftRuntimeMode,
  ]);
  const threadProvider =
    activeThread?.modelSelection.instanceId ??
    activeProject?.defaultModelSelection?.instanceId ??
    null;
  const lockedProvider = deriveLockedProvider({
    thread: activeThread,
    selectedProvider: selectedProviderByThreadId,
    threadProvider,
  });
  // Once a thread selects an environment, never substitute the primary
  // environment's config while the selected environment is still loading.
  const serverConfig = activeThread
    ? (activeEnvironment?.serverConfig ?? null)
    : (primaryEnvironment?.serverConfig ?? null);
  const versionMismatch = resolveServerConfigVersionMismatch(serverConfig);
  const versionMismatchDismissKey =
    versionMismatch && activeThread
      ? buildVersionMismatchDismissalKey(activeThread.environmentId, versionMismatch)
      : null;
  const [dismissedVersionMismatchKey, setDismissedVersionMismatchKey] = useState<string | null>(
    null,
  );
  const versionMismatchDismissed =
    versionMismatchDismissKey === dismissedVersionMismatchKey ||
    isVersionMismatchDismissed(versionMismatchDismissKey);
  const showVersionMismatchBanner =
    versionMismatch !== null && versionMismatchDismissKey !== null && !versionMismatchDismissed;
  const hasMultipleRegisteredEnvironments = environments.length > 1;
  const versionMismatchServerLabel =
    hasMultipleRegisteredEnvironments && activeThread
      ? `${environmentById.get(activeThread.environmentId)?.label ?? serverConfig?.environment.label ?? activeThread.environmentId} server`
      : "server";
  const versionMismatchEnvironmentId =
    versionMismatch && activeThread ? activeThread.environmentId : null;
  const versionMismatchSelfUpdate = resolveServerSelfUpdateCapability(serverConfig);
  const systemComposerBannerItems = useMemo<ComposerBannerStackItem[]>(() => {
    const items: ComposerBannerStackItem[] = [];
    if (activeProviderAuthenticationPaused) {
      const instanceId =
        activeThread?.session?.providerInstanceId ??
        activeThread?.modelSelection.instanceId ??
        null;
      items.push({
        id: `provider-authentication-required:${instanceId ?? "unknown"}`,
        variant: "error",
        icon: <LogInIcon />,
        title: "Provider sign-in required",
        description:
          "This chat is paused because its provider login expired. It will continue automatically after sign-in.",
        actions: (
          <Button
            size="xs"
            disabled={instanceId === null}
            onClick={() => {
              if (instanceId !== null) requestProviderAccountSwitch(instanceId);
            }}
          >
            Sign in
          </Button>
        ),
      });
    }
    if (activeEnvironmentUnavailableState) {
      const connection = activeEnvironmentUnavailableState.connection;
      const isReconnecting =
        connection.phase === "connecting" || connection.phase === "reconnecting";
      items.push({
        id: `environment-unavailable:${activeEnvironmentUnavailableState.environmentId}`,
        variant: connection.phase === "error" ? "error" : "warning",
        icon: <WifiOffIcon />,
        title: `${activeEnvironmentUnavailableState.label}: ${connectionStatusTitle(connection)}`,
        description: canQueueLocalMessage
          ? "Messages sent now are saved on this device and dispatch when the connection returns."
          : (connection.error ??
            "Reconnect this environment before sending messages or running actions."),
        actions: (
          <>
            <Button
              size="xs"
              disabled={isReconnecting}
              onClick={() =>
                void handleReconnectActiveEnvironment(
                  activeEnvironmentUnavailableState.environmentId,
                )
              }
            >
              {isReconnecting ? "Reconnecting..." : "Reconnect"}
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => void navigate({ to: "/settings/connections" })}
            >
              Connections
            </Button>
          </>
        ),
      });
    }
    if (pendingPreviewDownloadApprovals.length > 0) {
      const first = pendingPreviewDownloadApprovals[0]!;
      items.push({
        id: `preview-download-approval:${first.id}`,
        variant: "warning",
        icon: <DownloadIcon />,
        title: "Browser download waiting for you",
        description: `${previewDownloadApprovalSource(first)} wants to save ${first.fileName}. The agent is paused until you choose.`,
        actions: <PreviewDownloadApprovalActions approval={first} size="xs" />,
      });
    }
    if (
      showVersionMismatchBanner &&
      versionMismatch &&
      versionMismatchDismissKey &&
      versionMismatchEnvironmentId
    ) {
      items.push({
        id: `version-mismatch:${versionMismatchDismissKey}`,
        variant: "warning",
        icon: <TriangleAlertIcon />,
        title: "Client and server versions differ",
        description: (
          <>
            Client {versionMismatch.clientVersion} is connected to {versionMismatchServerLabel}{" "}
            {versionMismatch.serverVersion}.{" "}
            {versionSkewGuidance({
              direction: resolveVersionSkewDirection(versionMismatch),
              capability: versionMismatchSelfUpdate,
              serverLabel: versionMismatchServerLabel,
            })}
          </>
        ),
        // The desktop-managed guidance is already the description; the action
        // slot would only repeat it. A client that is *behind* gets no server
        // action at all — updating a server that is already ahead cannot clear
        // the banner.
        actions:
          versionMismatchSelfUpdate === "desktop-managed" ||
          resolveVersionSkewDirection(versionMismatch) === "client-behind" ? undefined : (
            <ServerUpdateAction
              environmentId={versionMismatchEnvironmentId}
              serverLabel={versionMismatchServerLabel}
              selfUpdate={versionMismatchSelfUpdate}
              targetVersion={versionMismatch.clientVersion}
            />
          ),
        dismissLabel: "Dismiss version mismatch warning",
        onDismiss: () => {
          dismissVersionMismatch(versionMismatchDismissKey);
          setDismissedVersionMismatchKey(versionMismatchDismissKey);
        },
      });
    }
    return items;
  }, [
    activeProviderAuthenticationPaused,
    activeThread?.modelSelection.instanceId,
    activeThread?.session?.providerInstanceId,
    activeEnvironmentUnavailableState,
    canQueueLocalMessage,
    handleReconnectActiveEnvironment,
    navigate,
    requestProviderAccountSwitch,
    setDismissedVersionMismatchKey,
    showVersionMismatchBanner,
    versionMismatch,
    versionMismatchDismissKey,
    versionMismatchEnvironmentId,
    versionMismatchSelfUpdate,
    versionMismatchServerLabel,
    pendingPreviewDownloadApprovals,
  ]);
  const providerStatuses = serverConfig?.providers ?? EMPTY_PROVIDERS;
  const activeSessionProviderDriver = deriveActiveSessionProviderDriver({
    thread: activeThread,
    providers: providerStatuses,
  });
  const sideChatStatusByThreadId = useMemo(() => {
    const statusByThreadId = new Map<string, SideChatTabStatus>();
    for (const thread of sideChatChildShells) {
      const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
      const provider = providerStatuses.find((entry) => entry.instanceId === instanceId) ?? null;
      const persistedProviderName = thread.session?.providerName?.trim() || null;
      statusByThreadId.set(thread.id, {
        hasConversation: thread.latestUserMessageAt !== null,
        isWorking:
          isSideChatActivelyWorking(thread) ||
          // Server-reported queued work (continuations, resumes) counts as
          // working; the local marker only bridges dispatch on older servers.
          isAutoResumePendingWork(thread.pendingWork) ||
          startupResumePendingByThreadKey[
            sideChatParentActivityKey(thread.environmentId, thread.id)
          ] !== undefined,
        provider: provider
          ? {
              driverKind: provider.driver,
              displayName: provider.displayName ?? String(provider.driver),
              ...(provider.accentColor !== undefined ? { accentColor: provider.accentColor } : {}),
            }
          : persistedProviderName === null
            ? null
            : {
                driverKind: ProviderDriverKind.make(persistedProviderName),
                displayName: persistedProviderName,
              },
      });
    }
    return statusByThreadId;
  }, [providerStatuses, sideChatChildShells, startupResumePendingByThreadKey]);
  providerUsageRefreshRpcRef.current = async (instanceId) => {
    const result = await refreshServerProviders({
      environmentId,
      input: { instanceId },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        console.warn("Failed to refresh provider usage", {
          operation: "refresh-provider-usage",
          environmentId,
          providerInstanceId: instanceId,
          error: chatActionErrorMessage(squashAtomCommandFailure(result)),
        });
      }
      throw new Error("Provider usage refresh failed.");
    }
    for (const report of Object.values(
      deriveProviderUsageReports(result.value.providers, [], environmentId),
    )) {
      recordProviderUsage(report);
    }
  };
  const refreshProviderUsage = useCallback(async (provider: ServerProvider) => {
    const request = providerUsageRefreshCoordinatorRef.current.request(provider);
    if (request === null) {
      throw new Error("Sign in to this enabled provider before refreshing usage.");
    }
    await request;
  }, []);
  const redeemProviderUsageReset = useCallback(
    async (provider: ServerProvider, creditId: string | undefined, idempotencyKey: string) => {
      const result = await consumeProviderUsageReset({
        environmentId,
        input: {
          instanceId: provider.instanceId,
          idempotencyKey,
          ...(creditId ? { creditId } : {}),
        },
      });
      if (result._tag === "Failure") {
        throw squashAtomCommandFailure(result);
      }
      for (const report of Object.values(
        deriveProviderUsageReports(result.value.providers, [], environmentId),
      )) {
        recordProviderUsage(report);
      }
      return result.value.outcome;
    },
    [consumeProviderUsageReset, environmentId, recordProviderUsage],
  );
  const unlockedSelectedProvider = resolveSelectableProvider(
    providerStatuses,
    selectedProviderByThreadId ?? threadProvider,
  );
  const selectedProvider: ProviderDriverKind = lockedProvider ?? unlockedSelectedProvider;
  // Prefer an instance-id match so a custom provider instance surfaces its
  // own model and usage instead of collapsing into the default driver bucket.
  const selectedProviderInstanceId =
    providerStatuses.find((status) => status.instanceId === selectedProviderByThreadId)
      ?.instanceId ?? null;
  const activeProviderInstanceId =
    selectedProviderInstanceId ??
    activeThread?.session?.providerInstanceId ??
    activeThread?.modelSelection.instanceId ??
    activeProject?.defaultModelSelection?.instanceId ??
    null;
  const providerUsageModelSelection = useMemo<ModelSelection | null>(() => {
    const instanceId =
      activeProviderInstanceId ??
      settings.textGenerationModelSelection?.instanceId ??
      defaultInstanceIdForDriver(selectedProvider);
    const candidates = [
      composerDraftModelState.modelSelectionByProvider[instanceId],
      activeThread?.modelSelection,
      activeProject?.defaultModelSelection,
      settings.textGenerationModelSelection,
    ];
    const candidate = candidates.find((selection) => selection?.instanceId === instanceId) ?? null;
    const model = resolveAppModelSelectionForInstance(
      instanceId,
      settings,
      providerStatuses,
      candidate?.model ?? null,
    );
    return model ? { instanceId, model } : null;
  }, [
    activeProject?.defaultModelSelection,
    activeProviderInstanceId,
    activeThread?.modelSelection,
    composerDraftModelState.modelSelectionByProvider,
    providerStatuses,
    selectedProvider,
    settings,
  ]);
  const phase = isSideChatSessionPreparing(activeThread)
    ? "ready"
    : derivePhase(activeThread?.session ?? null);
  const isThreadInterruptible = isThreadWorkInterruptible({
    phase,
    pendingWork: routeServerThreadShell?.pendingWork,
  });
  const threadActivities = activeThread?.activities ?? EMPTY_ACTIVITIES;
  const contextCompactionActivityCount = useMemo(
    () => threadActivities.filter((activity) => activity.kind === "context-compaction").length,
    [threadActivities],
  );
  const [isCompactAndContinueBusy, setIsCompactAndContinueBusy] = useState(false);
  const [compactionOperationStage, setCompactionOperationStage] = useState<
    "compacting" | "continuing" | null
  >(null);
  const compactAndContinueInFlightRef = useRef(false);
  const resumeIncompleteTurnInFlightRef = useRef(false);
  const [isResumeIncompleteTurnBusy, setIsResumeIncompleteTurnBusy] = useState(false);
  const [isApplyingComposerSettings, setIsApplyingComposerSettings] = useState(false);
  const [interruptRequestedThreadKey, setInterruptRequestedThreadKey] = useState<string | null>(
    null,
  );
  const isInterrupting = isThreadInterruptible && interruptRequestedThreadKey === activeThreadKey;
  useEffect(() => {
    if (!isThreadInterruptible && interruptRequestedThreadKey !== null) {
      setInterruptRequestedThreadKey(null);
    }
  }, [interruptRequestedThreadKey, isThreadInterruptible]);
  // The latch above disables Stop for as long as the thread still reads
  // "running" — which is correct while an interrupt is genuinely in flight, and
  // a trap when it is not. If the interrupt itself is lost (server restart,
  // dropped command, an adapter that never answers), the button stays disabled
  // against a turn nobody can kill and the only escape is reloading the app.
  // Re-arm after the server's own stop budget (2s cooperative + 10s forced) has
  // elapsed, so a second press is always possible.
  const INTERRUPT_REARM_MS = 15_000;
  useEffect(() => {
    if (interruptRequestedThreadKey === null) return;
    const timer = setTimeout(() => setInterruptRequestedThreadKey(null), INTERRUPT_REARM_MS);
    return () => clearTimeout(timer);
  }, [interruptRequestedThreadKey]);
  const resumableAssistantMessageId = useMemo(
    () =>
      deriveResumableAssistantMessageId({
        messages: activeThread?.messages ?? [],
        latestTurn: activeLatestTurn,
        session: activeThread?.session ?? null,
      }),
    [activeLatestTurn, activeThread?.messages, activeThread?.session],
  );
  const compactionCompletionWaiterRef = useRef<{
    readonly threadKey: string;
    readonly baselineActivityCount: number;
    readonly baselineTurnId: TurnId | null;
    settled: boolean;
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
  } | null>(null);
  const workLogEntries = useMemo(() => deriveWorkLogEntries(threadActivities), [threadActivities]);
  const receiptedMessageIds = useMemo(
    () => deriveDeliveredMessageIds(threadActivities),
    [threadActivities],
  );
  const requestedProviderInstanceId = activeThread?.modelSelection.instanceId ?? null;
  const deliveryProvider = useMemo(() => {
    const provider = providerStatuses.find(
      (status) => status.instanceId === activeProviderInstanceId,
    );
    const driver = provider?.driver ?? selectedProvider;
    // While a provider switch is being applied the live session still belongs
    // to the old provider, so the thread's own selection — not the session —
    // names the one the queued send is starting.
    const requested = providerStatuses.find(
      (status) => status.instanceId === requestedProviderInstanceId,
    );
    return {
      name: provider?.displayName?.trim() || formatProviderDriverKindLabel(driver),
      requestedName:
        requested?.displayName?.trim() ||
        formatProviderDriverKindLabel(requested?.driver ?? driver),
      receiptsExpected:
        driver === "codex" ||
        driver === "claudeAgent" ||
        driver === "grok" ||
        driver === "opencode",
    };
  }, [activeProviderInstanceId, providerStatuses, requestedProviderInstanceId, selectedProvider]);
  const pendingApprovals = useMemo(
    () => derivePendingApprovals(threadActivities),
    [threadActivities],
  );
  const pendingUserInputs = useMemo(
    () => derivePendingUserInputs(threadActivities, activeLatestTurn?.turnId ?? undefined),
    [activeLatestTurn?.turnId, threadActivities],
  );
  useEffect(() => {
    const pendingRequestIds = new Set(pendingApprovals.map((request) => request.requestId));
    setRespondingRequestIds((existing) => {
      const retained = existing.filter((requestId) => pendingRequestIds.has(requestId));
      return retained.length === existing.length ? existing : retained;
    });
  }, [pendingApprovals]);
  useEffect(() => {
    const pendingRequestIds = new Set(pendingUserInputs.map((request) => request.requestId));
    setRespondingUserInputRequestIds((existing) => {
      const retained = existing.filter((requestId) => pendingRequestIds.has(requestId));
      return retained.length === existing.length ? existing : retained;
    });
  }, [pendingUserInputs]);
  // Staleness is a function of elapsed time, not of new events — without a
  // ticking clock a task whose runtime died would keep reporting "Running"
  // until some unrelated activity happened to arrive.
  const [providerTaskNowMs, setProviderTaskNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setProviderTaskNowMs(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  // Filter before rendering so dismissing a task removes the row and updates
  // the dock count in one state transition.
  const providerTaskDismissals = useProviderTaskDismissalStore((state) => state.dismissals);
  const dismissProviderTasks = useProviderTaskDismissalStore((state) => state.dismissTasks);
  // A stopped session has no process left to run anything, so its tasks are
  // not "running" no matter what the last activity said. Only `stopped` counts
  // here: an interrupted or idle session still has a live runtime, and real
  // background work does survive a turn interrupt.
  const providerSessionEnded = activeThread?.session?.status === "stopped";
  const providerSessionEndedAt = providerSessionEnded
    ? activeThread?.session?.updatedAt
    : undefined;
  const providerTasks = useMemo(
    () =>
      applyProviderTaskDismissals(
        deriveProviderTasks(threadActivities, {
          nowMs: providerTaskNowMs,
          providerSessionEnded,
          ...(providerSessionEndedAt ? { providerSessionEndedAt } : {}),
        }),
        providerTaskDismissals,
      ),
    [
      providerTaskDismissals,
      providerTaskNowMs,
      providerSessionEnded,
      providerSessionEndedAt,
      threadActivities,
    ],
  );
  const onStopProviderTask = useCallback(
    (taskId: string) => {
      if (!activeThreadId) return;
      void stopThreadTask({
        environmentId,
        input: { threadId: activeThreadId, taskId: RuntimeTaskId.make(taskId) },
      });
    },
    [activeThreadId, environmentId, stopThreadTask],
  );
  const providerTaskPanel =
    providerTasks.length === 0 ? null : (
      <ProviderTaskPanel
        onStopTask={onStopProviderTask}
        tasks={providerTasks}
        threadKey={
          activeThreadId === null
            ? null
            : scopedThreadKey({ environmentId, threadId: activeThreadId })
        }
      />
    );
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const activePendingDraftAnswers = useMemo(
    () =>
      activePendingUserInput
        ? (pendingUserInputAnswersByRequestId[activePendingUserInput.requestId] ??
          EMPTY_PENDING_USER_INPUT_ANSWERS)
        : EMPTY_PENDING_USER_INPUT_ANSWERS,
    [activePendingUserInput, pendingUserInputAnswersByRequestId],
  );
  const activePendingQuestionIndex = activePendingUserInput
    ? (pendingUserInputQuestionIndexByRequestId[activePendingUserInput.requestId] ?? 0)
    : 0;
  const activePendingProgress = useMemo(
    () =>
      activePendingUserInput
        ? derivePendingUserInputProgress(
            activePendingUserInput.questions,
            activePendingDraftAnswers,
            activePendingQuestionIndex,
          )
        : null,
    [activePendingDraftAnswers, activePendingQuestionIndex, activePendingUserInput],
  );
  const activePendingResolvedAnswers = useMemo(
    () =>
      activePendingUserInput
        ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingDraftAnswers)
        : null,
    [activePendingDraftAnswers, activePendingUserInput],
  );
  const activePendingIsResponding = activePendingUserInput
    ? respondingUserInputRequestIds.includes(activePendingUserInput.requestId)
    : false;
  const activeProposedPlan = useMemo(() => {
    if (!latestTurnSettled) {
      return null;
    }
    return findLatestProposedPlan(
      activeThread?.proposedPlans ?? [],
      activeLatestTurn?.turnId ?? null,
    );
  }, [activeLatestTurn?.turnId, activeThread?.proposedPlans, latestTurnSettled]);
  const sidebarProposedPlan = useMemo(
    () =>
      findSidebarProposedPlan({
        threads: threadPlanCatalog,
        latestTurn: activeLatestTurn,
        latestTurnSettled,
        threadId: activeThread?.id ?? null,
      }),
    [activeLatestTurn, activeThread?.id, latestTurnSettled, threadPlanCatalog],
  );
  const activePlan = useMemo(
    () => deriveActivePlanState(threadActivities, activeLatestTurn?.turnId ?? undefined),
    [activeLatestTurn?.turnId, threadActivities],
  );
  const planSidebarLabel = sidebarProposedPlan || interactionMode === "plan" ? "Plan" : "Tasks";
  const showPlanFollowUpPrompt =
    pendingUserInputs.length === 0 &&
    interactionMode === "plan" &&
    latestTurnSettled &&
    hasActionableProposedPlan(activeProposedPlan);
  const activePendingApproval = pendingApprovals[0] ?? null;
  const {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt,
    isPreparingWorktree,
    isSendBusy,
  } = useLocalDispatchState({
    activeThread,
    activeLatestTurn,
    phase,
    activePendingApproval: activePendingApproval?.requestId ?? null,
    activePendingUserInput: activePendingUserInput?.requestId ?? null,
    threadError,
  });
  // "connecting" covers the provider session cold-start a queued delivery
  // triggers (spawn → resume → turn/start, tens of seconds): without it the
  // thread looked completely idle while a just-sent message was being
  // delivered. It must NOT gate onSend — sends during cold-start queue
  // durably and steer in once the turn is live.
  const isWorking =
    phase === "running" ||
    phase === "connecting" ||
    isSendBusy ||
    isConnecting ||
    isRevertingCheckpoint;
  const providerFailoverNotice = useMemo(
    () => findProviderFailoverNotice(threadActivities),
    [threadActivities],
  );
  const providerFailoverActive = isProviderFailoverActive({
    notice: providerFailoverNotice,
    currentModel: activeServerThread?.modelSelection.model ?? null,
  });
  const usageGuardCurrentInstanceId =
    activeServerThread?.session?.providerInstanceId ??
    activeServerThread?.modelSelection.instanceId ??
    null;
  const usageGuardPauseNotice = useMemo(
    () => findUsageGuardPauseNotice(threadActivities, usageGuardCurrentInstanceId),
    [threadActivities, usageGuardCurrentInstanceId],
  );
  const usageGuardPaused = isUsageGuardPauseActive({
    notice: usageGuardPauseNotice,
    pendingWork: routeServerThreadShell?.pendingWork,
    isWorking,
  });
  const [usageGuardResuming, setUsageGuardResuming] = useState(false);
  const usageGuardEffortSelection =
    activeServerThread?.modelSelection ?? activeThread?.modelSelection ?? null;

  const activeWorkStartedAt = deriveActiveWorkStartedAt(
    activeLatestTurn,
    activeThread?.session ?? null,
    localDispatchStartedAt,
  );
  useEffect(() => {
    attachmentPreviewHandoffByMessageIdRef.current = attachmentPreviewHandoffByMessageId;
  }, [attachmentPreviewHandoffByMessageId]);
  const clearAttachmentPreviewHandoff = useCallback(
    (messageId: MessageId, previewUrls?: ReadonlyArray<string>) => {
      delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
      const currentPreviewUrls =
        previewUrls ?? attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
      setAttachmentPreviewHandoffByMessageId((existing) => {
        if (!(messageId in existing)) {
          return existing;
        }
        const next = { ...existing };
        delete next[messageId];
        attachmentPreviewHandoffByMessageIdRef.current = next;
        return next;
      });
      for (const previewUrl of currentPreviewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    },
    [],
  );
  const clearAttachmentPreviewHandoffs = useCallback(() => {
    attachmentPreviewPromotionInFlightByMessageIdRef.current = {};
    for (const previewUrls of Object.values(attachmentPreviewHandoffByMessageIdRef.current)) {
      for (const previewUrl of previewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    attachmentPreviewHandoffByMessageIdRef.current = {};
    setAttachmentPreviewHandoffByMessageId({});
  }, []);
  useEffect(() => {
    return () => {
      clearAttachmentPreviewHandoffs();
      for (const message of optimisticUserMessagesRef.current) {
        revokeUserMessagePreviewUrls(message);
      }
    };
  }, [clearAttachmentPreviewHandoffs]);
  const handoffAttachmentPreviews = useCallback((messageId: MessageId, previewUrls: string[]) => {
    if (previewUrls.length === 0) return;

    const previousPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
    const nextPreviewUrlSet = new Set(previewUrls);
    for (const previewUrl of previousPreviewUrls) {
      if (!nextPreviewUrlSet.has(previewUrl)) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    setAttachmentPreviewHandoffByMessageId((existing) => {
      const next = {
        ...existing,
        [messageId]: previewUrls,
      };
      attachmentPreviewHandoffByMessageIdRef.current = next;
      return next;
    });
  }, []);
  const serverMessages = activeThread?.messages;
  const serverAttachmentIds = useMemo(() => {
    const attachmentIds = new Set<string>();
    for (const message of serverMessages ?? []) {
      for (const attachment of message.attachments ?? []) {
        attachmentIds.add(attachment.id);
      }
    }
    return [...attachmentIds];
  }, [serverMessages]);
  const serverAttachmentResources = useMemo(
    () =>
      serverAttachmentIds.map((attachmentId) => ({
        _tag: "attachment" as const,
        attachmentId,
      })),
    [serverAttachmentIds],
  );
  const serverAttachmentUrls = useAssetUrls(environmentId, serverAttachmentResources);
  const serverAttachmentUrlById = useMemo(
    () =>
      new Map(
        serverAttachmentIds.flatMap((attachmentId, index) => {
          const url = serverAttachmentUrls[index];
          return url ? [[attachmentId, url] as const] : [];
        }),
      ),
    [serverAttachmentIds, serverAttachmentUrls],
  );
  const displayServerMessages = useMemo<ReadonlyArray<ChatMessage>>(() => {
    if (!serverMessages) return [];
    // A held (queued) message lives in the queue panel until its delivery is
    // receipted or promoted into a turn; rendering it in the timeline too made
    // it read as sent twice. Cancelled ones never reach the timeline at all.
    const deliveredHeld = new Set([
      ...receiptedMessageIds,
      ...derivePromotedQueuedMessageIds(threadActivities),
    ]);
    return serverMessages
      .filter(
        (message) =>
          !isHeldMessageId(message.id) ||
          // A delivered held message belongs in the timeline like any other.
          // When this only consulted the receipt sets, one whose receipt aged
          // out of the activity window was shown in neither place and simply
          // vanished from the conversation.
          wasHeldMessageDelivered({ message, deliveredMessageIds: deliveredHeld }),
      )
      .map((message) => {
        if (!message.attachments || message.attachments.length === 0) {
          return message;
        }
        return {
          ...message,
          attachments: message.attachments.map((attachment) => {
            const previewUrl = serverAttachmentUrlById.get(attachment.id);
            return previewUrl ? { ...attachment, previewUrl } : attachment;
          }),
        };
      });
  }, [serverAttachmentUrlById, serverMessages, receiptedMessageIds, threadActivities]);
  const voiceTranscriptConversationContext = useMemo(
    () => buildVoiceTranscriptConversationContext(serverMessages ?? []),
    [serverMessages],
  );
  useEffect(() => {
    if (typeof Image === "undefined" || displayServerMessages.length === 0) {
      return;
    }

    const cleanups: Array<() => void> = [];
    const userMessagesById = new Map<string, ChatMessage>(
      displayServerMessages
        .filter((message) => message.role === "user")
        .map((message) => [String(message.id), message] as const),
    );

    for (const [messageId, handoffPreviewUrls] of Object.entries(
      attachmentPreviewHandoffByMessageId,
    )) {
      if (attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId]) {
        continue;
      }

      const serverMessage = userMessagesById.get(messageId);
      if (!serverMessage?.attachments || serverMessage.attachments.length === 0) {
        continue;
      }

      const serverPreviewUrls = serverMessage.attachments.flatMap((attachment) =>
        attachment.type === "image" && attachment.previewUrl ? [attachment.previewUrl] : [],
      );
      if (
        serverPreviewUrls.length === 0 ||
        serverPreviewUrls.length !== handoffPreviewUrls.length ||
        serverPreviewUrls.some((previewUrl) => previewUrl.startsWith("blob:"))
      ) {
        continue;
      }

      attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId] = true;

      let cancelled = false;
      const imageInstances: HTMLImageElement[] = [];

      const preloadServerPreviews = Promise.all(
        serverPreviewUrls.map(
          (previewUrl) =>
            new Promise<void>((resolve, reject) => {
              const image = new Image();
              imageInstances.push(image);
              const handleLoad = () => resolve();
              const handleError = () =>
                reject(new Error(`Failed to load server preview for ${messageId}.`));
              image.addEventListener("load", handleLoad, { once: true });
              image.addEventListener("error", handleError, { once: true });
              image.src = previewUrl;
            }),
        ),
      );

      void preloadServerPreviews
        .then(() => {
          if (cancelled) {
            return;
          }
          clearAttachmentPreviewHandoff(messageId as MessageId, handoffPreviewUrls);
        })
        .catch(() => {
          if (!cancelled) {
            delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
          }
        });

      cleanups.push(() => {
        cancelled = true;
        delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
        for (const image of imageInstances) {
          image.src = "";
        }
      });
    }

    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [attachmentPreviewHandoffByMessageId, clearAttachmentPreviewHandoff, displayServerMessages]);
  useEffect(() => {
    const serverIds = new Set(displayServerMessages.map((message) => message.id));
    for (const entry of pendingSends) {
      if (
        entry.accepted &&
        entry.command.type === "thread.turn.start" &&
        serverIds.has(entry.command.message.messageId)
      ) {
        void updateOutboxMessage({
          environmentId,
          input: { threadId, commandId: entry.command.commandId, action: "acknowledge" },
        });
      }
    }
  }, [pendingSends, displayServerMessages, environmentId, threadId, updateOutboxMessage]);
  const timelineMessages = useMemo(() => {
    const messages = displayServerMessages;
    const serverMessagesWithPreviewHandoff =
      Object.keys(attachmentPreviewHandoffByMessageId).length === 0
        ? messages
        : // Spread only fires for the few messages that actually changed;
          // unchanged ones early-return their original reference.
          // In-place mutation would break React's immutable state contract.
          messages.map((message) => {
            if (
              message.role !== "user" ||
              !message.attachments ||
              message.attachments.length === 0
            ) {
              return message;
            }
            const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id];
            if (!handoffPreviewUrls || handoffPreviewUrls.length === 0) {
              return message;
            }

            let changed = false;
            let imageIndex = 0;
            const attachments = message.attachments.map((attachment) => {
              if (attachment.type !== "image") {
                return attachment;
              }
              const handoffPreviewUrl = handoffPreviewUrls[imageIndex];
              imageIndex += 1;
              if (!handoffPreviewUrl || attachment.previewUrl === handoffPreviewUrl) {
                return attachment;
              }
              changed = true;
              return {
                ...attachment,
                previewUrl: handoffPreviewUrl,
              };
            });

            return changed ? { ...message, attachments } : message;
          });

    const localMessages = [
      ...recoveredSendMessages,
      ...optimisticUserMessages.filter(
        (message) =>
          !pendingSends.some(
            (entry) =>
              entry.command.type === "thread.turn.start" &&
              entry.command.message.messageId === message.id,
          ),
      ),
    ];
    if (localMessages.length === 0) return serverMessagesWithPreviewHandoff;
    const serverIds = new Set(serverMessagesWithPreviewHandoff.map((message) => message.id));
    const pendingMessages = localMessages.filter((message) => !serverIds.has(message.id));
    if (pendingMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    return [...serverMessagesWithPreviewHandoff, ...pendingMessages];
  }, [
    attachmentPreviewHandoffByMessageId,
    displayServerMessages,
    optimisticUserMessages,
    recoveredSendMessages,
    pendingSends,
  ]);
  // The server exposes its own decision now: `pendingWork` on the thread shell
  // is projected straight from thread_work_obligations, so the agent chip and
  // the startup spinner assert queued work exactly while the scheduler holds
  // it. The old text heuristic (shouldShowAgentAutoResumePending) that guessed
  // the projector's continuation gate from the final reply is gone with it.
  const serverPendingWork = routeServerThreadShell?.pendingWork;
  const agentAutoResumePending =
    !activeProviderAuthenticationPaused &&
    isAutoResumePendingWork(serverPendingWork, "agent-continuation");
  const startupAutoResumeStartedAt =
    activeThreadKey === null ? null : (startupResumePendingByThreadKey[activeThreadKey] ?? null);
  // The local marker bridges this client's own resume dispatch until the
  // server echoes the obligation — and is the only signal at all against
  // servers that predate `pendingWork`. It stays bounded by the 90s stall
  // deadline: on an old server nothing else ever clears it when the dispatch
  // is swallowed, and an indefinite spinner reads as progress. Past the
  // deadline we stop claiming it, which reveals the Resume control the user
  // can actually act on.
  const [autoResumeNowMs, setAutoResumeNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (startupAutoResumeStartedAt === null) return;
    setAutoResumeNowMs(Date.now());
    const timer = setInterval(() => setAutoResumeNowMs(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [startupAutoResumeStartedAt]);
  const serverStartupAutoResumePending = isAutoResumePendingWork(
    serverPendingWork,
    "startup-resume",
  );
  const startupAutoResumePending =
    serverStartupAutoResumePending ||
    (startupAutoResumeStartedAt !== null &&
      !isStartupAutoResumeStalled({
        startedAt: startupAutoResumeStartedAt,
        nowMs: autoResumeNowMs,
      }));
  // A turn that is actually running outranks any queued work. The scheduler
  // surfaces a queued successor over the executing obligation, so a startup
  // resume parked behind a live turn stays pending for that turn's whole
  // duration — claiming "Auto-resuming thread" over it describes work that is
  // waiting, not the work on screen, and backdates the elapsed clock to when
  // the resume was queued rather than when this turn began.
  const visibleStartupAutoResumePending =
    startupAutoResumePending &&
    !activeProviderAuthenticationPaused &&
    !usageGuardPaused &&
    !isWorking;
  // A backgrounded task keeps running after the turn that launched it ends —
  // that is the point of backgrounding one — and the harness re-invokes the
  // agent when it exits. The server knows this and parks the continuation
  // (`agentContinuationShouldAwaitBackgroundTask`), but it parks it in
  // `sleeping`, and the projected pendingWork carries only kind/state/since
  // with no reason, so the client cannot tell "waiting on a task" from "about
  // to resume" and announced an imminent resume for as long as the task ran.
  // The task list is right here, so read it rather than guess.
  const runningBackgroundTasks = useMemo(
    () => providerTasks.filter((task) => isProviderTaskActive(task)),
    [providerTasks],
  );
  const hasRunningBackgroundTask = runningBackgroundTasks.length > 0;
  const sendWouldStopBackgroundTasks = sendWouldStopBackgroundWork({
    hasRunningBackgroundTask,
    turnRunning: phase === "running",
    providerDriver: activeSessionProviderDriver,
  });
  const heldMessages = heldMessageQueue.store((state) => state.messages);
  const removedQueueIds = removedHeldMessageIds(threadActivities);
  const sentQueueIds = new Set([
    ...receiptedMessageIds,
    ...derivePromotedQueuedMessageIds(threadActivities),
  ]);
  const serverHeldMessages = (serverMessages ?? []).filter(
    (message) =>
      isHeldMessageId(message.id) &&
      isHeldMessageStillQueued({
        message,
        removedMessageIds: removedQueueIds,
        settledMessageIds: sentQueueIds,
      }),
  );
  const threadHeldMessages = [
    ...heldMessages.filter((message) => message.threadKey === activeThreadKey),
    ...serverHeldMessages.map((message) => ({
      id: message.id,
      text: message.text,
      attachmentCount: message.attachments?.length ?? 0,
      status: "queued" as const,
      error: undefined,
    })),
  ];
  const removeHeldMessage = async (id: string, edit = false) => {
    const message = serverHeldMessages.find((entry) => entry.id === id);
    if (!message) return edit ? heldMessageQueue.edit(id) : heldMessageQueue.remove(id);
    try {
      if (edit && activeThreadRef) {
        const images = await Promise.all(
          (message.attachments ?? []).map(async (attachment) => {
            const url = serverAttachmentUrlById.get(attachment.id);
            if (!url) throw new Error("Attachment is still loading. Please try again.");
            const response = await fetch(url);
            if (!response.ok)
              throw new Error("Could not restore attachment. The queued message is still saved.");
            const blob = await response.blob();
            return {
              ...attachment,
              previewUrl: URL.createObjectURL(blob),
              file: new File([blob], attachment.name, { type: attachment.mimeType }),
            };
          }),
        );
        const current = useComposerDraftStore.getState().getComposerDraft(activeThreadRef);
        setComposerDraftPrompt(
          activeThreadRef,
          [current?.prompt, message.text].filter(Boolean).join("\n\n"),
        );
        addComposerDraftImages(activeThreadRef, images);
      }
      const result = await removeQueuedMessage({
        environmentId,
        input: { threadId, messageId: message.id },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      // A cancel that worked retires whatever the last one said, so a failure
      // from before this one succeeded stops sitting on the thread.
      setThreadError(threadId, null);
    } catch (error) {
      setThreadError(
        threadId,
        error instanceof Error ? error.message : "Could not update queued message.",
      );
    }
  };
  // Ids whose force-send has been dispatched and whose row is still on screen.
  // Only guards the button's own affordance: the command is idempotent and the
  // server serialises concurrent force-sends per thread, so a double press
  // cannot corrupt anything — it would just look like nothing happened.
  const [sendingNowIds, setSendingNowIds] = useState<readonly string[]>([]);
  const sendHeldMessageNow = async (
    id: string,
    failureMessage = "Could not send the queued message now.",
  ) => {
    if (!activeThread) return;
    setSendingNowIds((current) => (current.includes(id) ? current : [...current, id]));
    try {
      const result = await sendQueuedMessageNow({
        environmentId,
        input: { threadId, messageId: MessageId.make(id) },
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        throw squashAtomCommandFailure(result);
      }
      setThreadError(threadId, null);
    } catch (error) {
      setThreadError(threadId, error instanceof Error ? error.message : failureMessage);
    } finally {
      // Release on settle rather than on delivery. The row itself disappears
      // when the message goes, so holding the button disabled past the command
      // only buys a latch: a send that is accepted but then stalls would leave
      // "Sending…" on screen with no way to press it again. Re-pressing while
      // the message is still queued is a no-op server-side (it joins the burst
      // instead of stopping the turn a second time), so re-enabling is safe.
      setSendingNowIds((current) => current.filter((entry) => entry !== id));
    }
  };
  const heldSendPanel =
    activeThreadKey === null || threadHeldMessages.length === 0 ? null : (
      <QueuedMessagesPanel
        key={activeThreadKey}
        threadKey={activeThreadKey}
        count={threadHeldMessages.length}
        failedCount={threadHeldMessages.filter((message) => message.status === "failed").length}
        status={
          usageGuardPaused
            ? "Waiting for usage budget"
            : phase === "running"
              ? "Joining the running turn"
              : "Sends when the current work finishes"
        }
      >
        {usageGuardPaused && usageGuardPauseNotice && (
          <QueuedMessageCountdown notice={usageGuardPauseNotice} />
        )}
        {threadHeldMessages.map((message, index) => (
          <div
            key={message.id}
            className="group flex items-start gap-2 rounded-lg border border-border/60 bg-card/60 p-2"
            role="status"
          >
            <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md bg-muted text-[10px] tabular-nums text-muted-foreground">
              {index + 1}
            </span>
            <span className="sr-only">
              {message.status === "sending"
                ? "Sending"
                : message.status === "failed"
                  ? "Send failed"
                  : usageGuardPaused
                    ? "Queued · waiting for credits"
                    : "Queued"}
            </span>
            <span
              className="min-w-0 flex-1 whitespace-pre-wrap break-words text-xs leading-relaxed line-clamp-3"
              title={message.error ?? message.text}
            >
              {message.error ?? (message.text || "Attachment")}
            </span>
            {message.attachmentCount > 0 && (
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {message.attachmentCount} attachment{message.attachmentCount === 1 ? "" : "s"}
              </span>
            )}
            {message.status === "failed" && (
              <Button
                variant="ghost"
                size="xs"
                className={isPhonePortraitViewport ? "px-1.5" : undefined}
                onClick={() => heldMessageQueue.retry(message.id)}
                title="Retry"
              >
                {isPhonePortraitViewport ? (
                  <RotateCcwIcon className="size-3.5" aria-hidden="true" />
                ) : null}
                <span className={isPhonePortraitViewport ? "sr-only" : undefined}>Retry</span>
              </Button>
            )}
            <Button
              variant="ghost"
              size="xs"
              className={isPhonePortraitViewport ? "px-1.5" : undefined}
              disabled={message.status === "sending" || sendingNowIds.includes(message.id)}
              onClick={() => void sendHeldMessageNow(message.id)}
              title="Stop what the thread is doing and send this message now"
            >
              {isPhonePortraitViewport ? (
                sendingNowIds.includes(message.id) ? (
                  <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <SendHorizontalIcon className="size-3.5" aria-hidden="true" />
                )
              ) : null}
              <span className={isPhonePortraitViewport ? "sr-only" : undefined}>
                {sendingNowIds.includes(message.id) ? "Sending…" : "Send now"}
              </span>
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className={isPhonePortraitViewport ? "px-1.5" : undefined}
              disabled={message.status === "sending"}
              onClick={() => void removeHeldMessage(message.id, true)}
              title="Edit"
            >
              {isPhonePortraitViewport ? (
                <PencilIcon className="size-3.5" aria-hidden="true" />
              ) : null}
              <span className={isPhonePortraitViewport ? "sr-only" : undefined}>Edit</span>
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className={isPhonePortraitViewport ? "px-1.5" : undefined}
              disabled={message.status === "sending"}
              onClick={() => void removeHeldMessage(message.id)}
              title="Cancel"
            >
              {isPhonePortraitViewport ? <XIcon className="size-3.5" aria-hidden="true" /> : null}
              <span className={isPhonePortraitViewport ? "sr-only" : undefined}>Cancel</span>
            </Button>
          </div>
        ))}
      </QueuedMessagesPanel>
    );
  const visibleAgentAutoResumePending = shouldAnnounceAgentAutoResume({
    pending: agentAutoResumePending && !usageGuardPaused,
    isWorking,
    hasRunningBackgroundTask,
  });
  const timelineIsWorking = isWorking || agentAutoResumePending || visibleStartupAutoResumePending;
  const timelineWorkStartedAt = isWorking
    ? activeWorkStartedAt
    : visibleStartupAutoResumePending
      ? (startupAutoResumeStartedAt ??
        (serverStartupAutoResumePending ? (serverPendingWork?.since ?? null) : null))
      : agentAutoResumePending
        ? (serverPendingWork?.since ?? activeLatestTurn?.completedAt ?? activeWorkStartedAt)
        : activeWorkStartedAt;
  const timelineEntries = useMemo(
    () =>
      deriveTimelineEntries(timelineMessages, activeThread?.proposedPlans ?? [], workLogEntries),
    [activeThread?.proposedPlans, timelineMessages, workLogEntries],
  );
  const resumableRuntimeErrorActivityId = useMemo(
    () =>
      deriveResumableRuntimeErrorActivityId({
        timelineEntries,
        latestTurn: activeLatestTurn,
        session: activeThread?.session ?? null,
      }),
    [activeLatestTurn, activeThread?.session, timelineEntries],
  );
  // Rows the server has not echoed back yet, so the delivery indicator can say
  // "sending" rather than claiming a message it has not stored was sent.
  const pendingMessageIds = useMemo(() => {
    const serverIds = new Set(displayServerMessages.map((message) => message.id));
    return new Set(
      [...recoveredSendMessages, ...optimisticUserMessages]
        .filter((message) => !serverIds.has(message.id))
        .map((message) => message.id),
    );
  }, [displayServerMessages, optimisticUserMessages, recoveredSendMessages]);
  // Coalesced sends only receipt the newest message of the batch, so widen the
  // set by send order before anything reads it. See expandDeliveredMessageIds.
  const deliveredMessageIds = useMemo(
    () =>
      expandDeliveredMessageIds(
        timelineMessages
          .filter((message) => message.role === "user" && message.voiceTranscript !== true)
          .map((message) => message.id),
        receiptedMessageIds,
      ),
    [receiptedMessageIds, timelineMessages],
  );
  // A steer OpenCode/Claude accepted but cannot read until the running
  // subagent returns. Transient upstream retries no longer relabel the row:
  // they stay "Working" and only surface once the retry budget is spent.
  const steerWaitingBehindSubagent = isSteerWaitingBehindSubagent({
    activities: threadActivities,
    messages: timelineMessages,
    latestTurn: activeLatestTurn,
    isWorking,
    deliveredMessageIds,
  });
  const promotedQueuedGrokMessageIds = useMemo(
    () => derivePromotedQueuedMessageIds(threadActivities),
    [threadActivities],
  );
  const queuedGrokMessageIds = useMemo(
    () =>
      deriveQueuedGrokMessageIds({
        activeSessionProviderDriver,
        phase,
        messages: timelineMessages,
        activeWorkStartedAt,
        promotedMessageIds: promotedQueuedGrokMessageIds,
        pendingMessageIds,
        deliveredMessageIds,
      }),
    [
      activeSessionProviderDriver,
      activeWorkStartedAt,
      deliveredMessageIds,
      pendingMessageIds,
      phase,
      promotedQueuedGrokMessageIds,
      timelineMessages,
    ],
  );
  const hasQueuedGrokMessages = queuedGrokMessageIds.length > 0;
  const queuedGrokMessageIdsRef = useRef(queuedGrokMessageIds);
  queuedGrokMessageIdsRef.current = queuedGrokMessageIds;
  const deliveredMessageIdsRef = useRef(deliveredMessageIds);
  deliveredMessageIdsRef.current = deliveredMessageIds;
  const awaitingQueuedDeliveryIdsRef = useRef<string[]>([]);
  const [queuedGrokDrainActive, setQueuedGrokDrainActive] = useState(false);
  const isPromotingQueuedMessages =
    queuedMessagePromotionInFlight || (queuedGrokDrainActive && hasQueuedGrokMessages);
  useEffect(() => {
    awaitingQueuedDeliveryIdsRef.current = [];
    setQueuedGrokDrainActive(false);
  }, [activeThreadKey]);
  const newestUserMessageId = useMemo(() => {
    for (let index = timelineMessages.length - 1; index >= 0; index -= 1) {
      const message = timelineMessages[index];
      // Voice-transcript rows never reach a provider; skipping them keeps the
      // delivery indicator on the newest genuinely dispatched message instead
      // of letting a spoken row suppress it.
      if (message?.role === "user" && message.voiceTranscript !== true) return message.id;
    }
    return null;
  }, [timelineMessages]);
  // A turn-start that failed for good leaves the newest message persisted but
  // never sent; the row says so and offers Send again instead of "Queued".
  const unsentMessage = useMemo(() => {
    const index = timelineMessages.findLastIndex((message) => message.id === newestUserMessageId);
    const message = timelineMessages[index];
    return deriveUnsentMessage({
      activities: threadActivities,
      newestUserMessage: message,
      delivered: deliveredMessageIds,
      deliveryInFlight:
        isWorking ||
        (serverPendingWork ?? null) !== null ||
        (message !== undefined && pendingMessageIds.has(message.id)),
      answeredAfter: timelineMessages.slice(index + 1).some((entry) => entry.role === "assistant"),
    });
  }, [
    deliveredMessageIds,
    isWorking,
    newestUserMessageId,
    pendingMessageIds,
    serverPendingWork,
    threadActivities,
    timelineMessages,
  ]);
  // The timeline's row context is memoized; a fresh callback every render
  // would re-render every row.
  const sendHeldMessageNowRef = useRef(sendHeldMessageNow);
  sendHeldMessageNowRef.current = sendHeldMessageNow;
  const sendUnsentMessageAgain = useCallback(
    (messageId: MessageId) =>
      void sendHeldMessageNowRef.current(messageId, "Could not send the message again."),
    [],
  );
  const sendingNowIdSet = useMemo(() => new Set(sendingNowIds), [sendingNowIds]);
  const [dockedDraftHeroThreadKey, setDockedDraftHeroThreadKey] = useState<string | null>(null);
  const draftHeroDockRequested =
    activeThreadKey !== null && dockedDraftHeroThreadKey === activeThreadKey;
  const isDraftHeroState =
    isLocalDraftThread && timelineEntries.length === 0 && !isWorking && !draftHeroDockRequested;
  // Terminal mode hides the composer footer, so the usage pill moves to the
  // same top-center row the New Thread view uses.
  const providerUsagePlacement =
    showProviderUsageBar && !activeProviderAuthenticationPaused
      ? resolveProviderUsagePlacement(isDraftHeroState || terminalMainSurfaceActive)
      : null;
  const dockPhoneDraftComposer = shouldDockPhoneDraftComposer({
    isDraftHeroState,
    isPhonePortrait: isPhonePortraitViewport,
    isComposerFocused: phoneComposerFocused,
  });
  const chatFooterLayout = resolveChatFooterLayout({
    isDraftHeroState,
    dockPhoneDraftComposer,
    keyboardInset: phoneVisualViewportBottomInset,
  });
  const [
    attachDraftHeroTransitionGroupRef,
    attachDraftHeroComposerAnchorRef,
    captureDraftHeroComposerRect,
  ] = useDraftHeroLayoutTransition(isDraftHeroState);
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const turnDiffSummaryByAssistantMessageId = useMemo(() => {
    const byMessageId = new Map<MessageId, TurnDiffSummary>();
    const lastAssistantByTurn = new Map<string, MessageId>();
    for (const message of activeThread?.messages ?? []) {
      if (message.role === "assistant" && message.turnId) {
        lastAssistantByTurn.set(message.turnId, message.id);
      }
    }
    for (const summary of turnDiffSummaries) {
      const messageId = lastAssistantByTurn.get(summary.turnId) ?? summary.assistantMessageId;
      if (messageId) byMessageId.set(messageId, summary);
    }
    return byMessageId;
  }, [turnDiffSummaries, activeThread?.messages]);
  const revertTurnCountByUserMessageId = useMemo(() => {
    const byUserMessageId = new Map<MessageId, number>();
    for (let index = 0; index < timelineEntries.length; index += 1) {
      const entry = timelineEntries[index];
      if (!entry || entry.kind !== "message" || entry.message.role !== "user") {
        continue;
      }

      for (let nextIndex = index + 1; nextIndex < timelineEntries.length; nextIndex += 1) {
        const nextEntry = timelineEntries[nextIndex];
        if (!nextEntry || nextEntry.kind !== "message") {
          continue;
        }
        if (nextEntry.message.role === "user") {
          break;
        }
        const summary = turnDiffSummaryByAssistantMessageId.get(nextEntry.message.id);
        if (!summary) {
          continue;
        }
        const turnCount =
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
        if (typeof turnCount !== "number") {
          break;
        }
        byUserMessageId.set(entry.message.id, Math.max(0, turnCount - 1));
        break;
      }
    }

    return byUserMessageId;
  }, [inferredCheckpointTurnCountByTurnId, timelineEntries, turnDiffSummaryByAssistantMessageId]);

  const gitCwd = activeProject
    ? projectScriptCwd({
        project: { cwd: activeProject.workspaceRoot },
        worktreePath: activeThread?.worktreePath ?? null,
      })
    : null;
  const gitStatusCwd = activeThread?.worktreePath ?? gitCwd;
  const gitStatusQuery = useEnvironmentQuery(
    gitStatusCwd === null
      ? null
      : vcsEnvironment.status({
          environmentId,
          input: { cwd: gitStatusCwd },
        }),
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  const activeProviderStatus = useMemo(() => {
    if (activeProviderInstanceId) {
      return (
        providerStatuses.find((status) => status.instanceId === activeProviderInstanceId) ?? null
      );
    }
    const defaultInstanceId = defaultInstanceIdForDriver(selectedProvider);
    return providerStatuses.find((status) => status.instanceId === defaultInstanceId) ?? null;
  }, [activeProviderInstanceId, providerStatuses, selectedProvider]);
  useEffect(() => {
    if (providerAccountSwitch || !activeProviderInstanceId) return;
    let disposed = false;
    let polling = false;
    const discoverHostAccountSwitch = async () => {
      if (disposed || polling) return;
      polling = true;
      const result = await getProviderAccountSwitch({
        environmentId,
        input: { instanceId: activeProviderInstanceId },
      });
      polling = false;
      if (disposed || result._tag === "Failure" || result.value === null) return;
      if (result.value.id === dismissedProviderAccountSwitchIdRef.current) return;
      setProviderAccountSwitch(result.value);
    };
    void discoverHostAccountSwitch();
    const discoverWhenVisible = () => {
      if (document.visibilityState === "visible") void discoverHostAccountSwitch();
    };
    window.addEventListener("focus", discoverWhenVisible);
    document.addEventListener("visibilitychange", discoverWhenVisible);
    return () => {
      disposed = true;
      window.removeEventListener("focus", discoverWhenVisible);
      document.removeEventListener("visibilitychange", discoverWhenVisible);
    };
  }, [activeProviderInstanceId, environmentId, getProviderAccountSwitch, providerAccountSwitch]);
  const providerStatusBannerKey = getProviderStatusBannerKey(activeProviderStatus);
  const [dismissedProviderStatusBannerKey, setDismissedProviderStatusBannerKey] = useState<
    string | null
  >(null);
  useEffect(() => {
    if (providerStatusBannerKey === null && dismissedProviderStatusBannerKey !== null) {
      setDismissedProviderStatusBannerKey(null);
    }
  }, [dismissedProviderStatusBannerKey, providerStatusBannerKey]);
  const visibleProviderStatus = shouldShowProviderStatusBanner(
    activeProviderStatus,
    dismissedProviderStatusBannerKey,
  )
    ? activeProviderStatus
    : null;
  const hasTimelineTopBanner = Boolean(threadError) || visibleProviderStatus !== null;
  const activeProjectCwd = activeProject?.workspaceRoot ?? null;
  const activeThreadWorktreePath = activeThread?.worktreePath ?? null;
  const activeWorkspaceRoot = activeThreadWorktreePath ?? activeProjectCwd ?? undefined;
  const turnFileReferences = useMemo(
    () =>
      collectThreadFileReferencesByTurnId({
        messages: activeThread?.messages ?? [],
        activities: activeThread?.activities ?? [],
        ...(activeWorkspaceRoot ? { cwd: activeWorkspaceRoot } : {}),
      }),
    [activeThread?.messages, activeThread?.activities, activeWorkspaceRoot],
  );
  const activeTerminalLaunchContext =
    terminalUiLaunchContext?.threadId === activeThreadId ? terminalUiLaunchContext : null;
  // Default true while loading to avoid toolbar flicker.
  const isGitRepo = gitStatusQuery.data?.isRepo ?? true;
  const showComposerContextStrip = isGitRepo && activeProject !== null;
  const initialDiffPanelGitScope =
    gitStatusQuery.data?.hasWorkingTreeChanges === true ? "unstaged" : "branch";
  const diffPanelGitStatusResolutionKey = gitStatusQuery.data ? "resolved" : "pending";
  const terminalShortcutLabelOptions = useMemo(
    () => ({
      context: {
        terminalFocus: true,
        terminalOpen: terminalMainSurfaceActive,
      },
    }),
    [terminalMainSurfaceActive],
  );
  const splitTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.split", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const splitTerminalVerticalShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(keybindings, "terminal.splitVertical", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const newTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.new", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const closeTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.close", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const onToggleDiff = useCallback(() => {
    if (!isServerThread) {
      return;
    }
    if (!diffOpen) {
      onDiffPanelOpen?.();
    }
    if (activeThreadRef) {
      useRightPanelStore.getState().toggle(activeThreadRef, "diff");
    }
  }, [activeThreadRef, diffOpen, isServerThread, onDiffPanelOpen]);

  const envLocked = Boolean(
    activeThread &&
    (activeThread.messages.length > 0 ||
      (activeThread.session !== null && activeThread.session.status !== "stopped")),
  );

  // Handle environment change for draft threads.  When the user picks a
  // different environment we update the draft context to point at the physical
  // project in that environment while keeping the same logical project.
  const onEnvironmentChange = useCallback(
    (nextEnvironmentId: EnvironmentId) => {
      if (envLocked || !draftId) return;
      const target = logicalProjectEnvironments.find(
        (env) => env.environmentId === nextEnvironmentId,
      );
      if (!target) return;
      setDraftThreadContext(draftId, {
        projectRef: scopeProjectRef(target.environmentId, target.projectId),
      });
    },
    [draftId, envLocked, logicalProjectEnvironments, setDraftThreadContext],
  );

  const activeTerminalGroup =
    terminalUiState.terminalGroups.find(
      (group) => group.id === terminalUiState.activeTerminalGroupId,
    ) ??
    terminalUiState.terminalGroups.find((group) =>
      group.terminalIds.includes(terminalUiState.activeTerminalId),
    ) ??
    null;
  const setThreadError = useCallback(
    (targetThreadId: ThreadId | null, error: string | null) => {
      if (!targetThreadId) return;
      const nextError = sanitizeThreadErrorMessage(error);
      const nextEntry: LocalThreadErrorEntry = { message: nextError, at: Date.now() };
      if (
        shouldWriteThreadErrorToCurrentServerThread({
          activeServerThread,
          routeThreadRef,
          targetThreadId,
        })
      ) {
        setLocalServerErrorsByThreadKey((existing) => {
          if (nextError === null) {
            if (existing[routeThreadKey] === undefined) return existing;
            const next = { ...existing };
            delete next[routeThreadKey];
            return next;
          }
          if ((existing[routeThreadKey]?.message ?? null) === nextError) {
            return existing;
          }
          return {
            ...existing,
            [routeThreadKey]: nextEntry,
          };
        });
        return;
      }
      const localDraftErrorKey = draftId ?? targetThreadId;
      setLocalDraftErrorsByDraftId((existing) => {
        if (nextError === null) {
          if (existing[localDraftErrorKey] === undefined) return existing;
          const next = { ...existing };
          delete next[localDraftErrorKey];
          return next;
        }
        if ((existing[localDraftErrorKey]?.message ?? null) === nextError) {
          return existing;
        }
        return {
          ...existing,
          [localDraftErrorKey]: nextEntry,
        };
      });
    },
    [activeServerThread, draftId, routeThreadKey, routeThreadRef],
  );
  const onResumeUsageGuard = useCallback(
    async (selection?: ModelSelection) => {
      const threadId = activeServerThread?.id;
      if (threadId === undefined || usageGuardResuming) return;
      setUsageGuardResuming(true);
      try {
        const result = await resumeUsageGuard({
          environmentId,
          input: { threadId, ...(selection ? { modelSelection: selection } : {}) },
        });
        if (result._tag === "Failure") {
          setThreadError(threadId, "Could not resume queued work. Please try again.");
          return;
        }
        if (!result.value.resumed && result.value.reason) {
          setThreadError(threadId, result.value.reason);
          return;
        }
        if (selection)
          setComposerDraftModelSelection(composerDraftTarget, selection, { replaceOptions: true });
      } catch {
        setThreadError(threadId, "Could not resume queued work. Please try again.");
      } finally {
        setUsageGuardResuming(false);
      }
    },
    [
      activeServerThread?.id,
      usageGuardResuming,
      environmentId,
      resumeUsageGuard,
      setThreadError,
      setComposerDraftModelSelection,
      composerDraftTarget,
    ],
  );

  const [usageGuardRefreshing, setUsageGuardRefreshing] = useState(false);
  const onRefreshUsageGuardReading = useCallback(async () => {
    const provider = providerStatuses.find(
      (entry) => entry.instanceId === usageGuardEffortSelection?.instanceId,
    );
    if (!provider || usageGuardRefreshing) return;
    setUsageGuardRefreshing(true);
    try {
      await refreshProviderUsage(provider);
    } finally {
      setUsageGuardRefreshing(false);
    }
  }, [
    providerStatuses,
    usageGuardEffortSelection?.instanceId,
    usageGuardRefreshing,
    refreshProviderUsage,
  ]);

  const onApplyUsageGuardEffort = useCallback(
    async (selection: ModelSelection) => {
      if (!activeServerThread || usageGuardResuming) return;
      setUsageGuardResuming(true);
      try {
        const result = await resumeUsageGuard({
          environmentId,
          input: { threadId: activeServerThread.id, recheckOnly: true, modelSelection: selection },
        });
        if (result._tag === "Failure") {
          setThreadError(
            activeServerThread.id,
            "Could not apply the thinking effort. Please try again.",
          );
          return;
        }
        setComposerDraftModelSelection(composerDraftTarget, selection, { replaceOptions: true });
      } catch {
        setThreadError(
          activeServerThread.id,
          "Could not apply the thinking effort. Please try again.",
        );
      } finally {
        setUsageGuardResuming(false);
      }
    },
    [
      activeServerThread,
      usageGuardResuming,
      resumeUsageGuard,
      environmentId,
      composerDraftTarget,
      setComposerDraftModelSelection,
      setThreadError,
    ],
  );

  useEffect(() => {
    if (
      !activeThread ||
      !activeThreadKey ||
      activeQueuedMessagePromotionState?.phase !== "awaiting-projection"
    ) {
      return;
    }
    const outcome = settleQueuedMessagePromotion({
      phasesRef: queuedMessagePromotionPhasesRef,
      setPhases: setQueuedMessagePromotionPhases,
      threadKey: activeThreadKey,
      activities: threadActivities,
    });
    if (outcome?.status === "failed") {
      setQueuedGrokDrainActive(false);
      awaitingQueuedDeliveryIdsRef.current = [];
      setThreadError(activeThread.id, outcome.detail);
    }
  }, [
    activeQueuedMessagePromotionState?.phase,
    activeThread,
    activeThreadKey,
    setThreadError,
    threadActivities,
  ]);
  useEffect(() => {
    if (!activeThread || !activeThreadKey || activeQueuedMessagePromotionState === undefined) {
      return;
    }
    const remainingMs =
      QUEUED_MESSAGE_PROMOTION_STALE_MS -
      (Date.now() - activeQueuedMessagePromotionState.startedAtMs);
    const timer = window.setTimeout(
      () => {
        const outcome = expireStaleQueuedMessagePromotion({
          phasesRef: queuedMessagePromotionPhasesRef,
          setPhases: setQueuedMessagePromotionPhases,
          threadKey: activeThreadKey,
          nowMs: Date.now(),
        });
        if (outcome?.status === "failed") {
          setQueuedGrokDrainActive(false);
          awaitingQueuedDeliveryIdsRef.current = [];
          setThreadError(activeThread.id, outcome.detail);
        }
      },
      Math.max(0, remainingMs),
    );
    return () => window.clearTimeout(timer);
  }, [activeQueuedMessagePromotionState, activeThread, activeThreadKey, setThreadError]);
  const dismissThreadError = useCallback(() => {
    if (!activeThread) return;
    setThreadError(activeThread.id, null);
    const persistedError = activeServerThread?.session?.lastError;
    if (persistedError) {
      setDismissedServerErrorsByThreadKey((existing) =>
        existing[routeThreadKey] === persistedError
          ? existing
          : { ...existing, [routeThreadKey]: persistedError },
      );
    }
    // lastError lives on the session row, so a local hide comes back on the
    // next projection. Stopping the session clears it and replaces a tripped
    // provider process (the banner's own "restart the session" instruction).
    if (isServerThread && activeThreadId && persistedError) {
      void stopThreadSession({
        environmentId,
        input: { threadId: activeThreadId },
      });
    }
  }, [
    activeServerThread?.session?.lastError,
    activeThread,
    activeThreadId,
    environmentId,
    isServerThread,
    routeThreadKey,
    setThreadError,
    stopThreadSession,
  ]);
  const startHostRepairForThreadError = useCallback(async () => {
    if (!activeServerThread || !hostRepairErrorKey) return;
    setHostRepairStartingErrorKey(hostRepairErrorKey);
    try {
      const result = await startHostRepair({
        environmentId: activeServerThread.environmentId,
        input: { sourceThreadId: activeServerThread.id },
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start computer repair",
            description: chatActionErrorMessage(error),
          }),
        );
        return;
      }
      setHostRepairStartedErrorKey(hostRepairErrorKey);
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Repair agent started",
          description: `Working in ${result.value.workspaceRoot} under approval-required access.`,
        }),
      );
    } finally {
      setHostRepairStartingErrorKey((current) => (current === hostRepairErrorKey ? null : current));
    }
  }, [activeServerThread, hostRepairErrorKey, startHostRepair]);

  /**
   * Put the caret back in the composer after something settles.
   *
   * Every caller is an action finishing rather than the user asking to type:
   * a thread opening, a mode or model change, a branch picked, files dropped,
   * the terminal surface closing. On a device with a soft keyboard each of
   * those would slide a keyboard up over the conversation, so the whole family
   * is suppressed at once here rather than at each call site — which is what
   * left some of them still doing it.
   *
   * Focus the user asked for outright does not come through here: tapping the
   * composer, quoting a message, and typing a character to start a draft all
   * go straight to the editor handle.
   */
  const focusComposer = useCallback(() => {
    if (!shouldRestoreComposerFocus({ previewFocused: isPreviewFocused(), usesOnScreenKeyboard }))
      return;
    composerRef.current?.focusAtEnd();
  }, [composerRef, usesOnScreenKeyboard]);
  const scheduleComposerFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      focusComposer();
    });
  }, [focusComposer]);
  const onTimelineFileDragEnter = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setIsFileDragOverTimeline(true);
  }, []);
  const onTimelineFileDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsFileDragOverTimeline(true);
  }, []);
  const onTimelineFileDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setIsFileDragOverTimeline(false);
  }, []);
  const onTimelineFileDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.stopPropagation();
      setIsFileDragOverTimeline(false);
      composerRef.current?.addFiles(Array.from(event.dataTransfer.files));
    },
    [composerRef],
  );
  const addTerminalContextToDraft = useCallback(
    (selection: TerminalContextSelection) => {
      composerRef.current?.addTerminalContext(selection);
    },
    [composerRef],
  );
  /**
   * Bring the terminal into view.
   *
   * This used to open a drawer split under the chat. There is no drawer any
   * more — the terminal is a main surface — so the actions that used to need
   * a terminal on screen (split, new, focus) switch to it instead. Callers
   * that already are in terminal mode get a no-op.
   */
  const showTerminalSurface = useCallback(() => {
    // Through handleMainSurfaceChange rather than the store directly: it also
    // launches the first terminal when the thread has none, without which
    // "split" or "new" would switch to an empty workspace.
    handleMainSurfaceChange("terminal");
  }, [handleMainSurfaceChange]);
  const splitTerminal = useCallback(
    (direction: "horizontal" | "vertical" = "horizontal", sourceTerminalId?: string) => {
      if (!activeThreadRef || !activeThreadId || !activeProject) {
        return;
      }
      const sourceId = sourceTerminalId ?? terminalUiState.activeTerminalId;
      const sourceGroup =
        terminalUiState.terminalGroups.find((group) => group.terminalIds.includes(sourceId)) ??
        activeTerminalGroup;
      if ((sourceGroup?.terminalIds.length ?? 0) >= MAX_TERMINALS_PER_GROUP) {
        return;
      }
      const cwdForOpen = gitCwd ?? activeProject.workspaceRoot;
      if (!cwdForOpen) {
        return;
      }
      if (sourceTerminalId && sourceTerminalId !== terminalUiState.activeTerminalId) {
        storeSetActiveTerminal(activeThreadRef, sourceTerminalId);
      }
      const terminalId = nextTerminalId([...activeKnownTerminalIds, ...panelTerminalIds]);
      if (direction === "vertical") {
        storeSplitTerminalVertical(activeThreadRef, terminalId);
      } else {
        storeSplitTerminal(activeThreadRef, terminalId);
      }
      setTerminalFocusRequestId((value) => value + 1);
      void persistLocalDraftThread();
      void openTerminalWithRollback(activeThreadRef, terminalId, {
        threadId: activeThreadId,
        terminalId,
        cwd: cwdForOpen,
        ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
        env: projectScriptRuntimeEnv({
          project: { cwd: activeProject.workspaceRoot },
          worktreePath: activeThreadWorktreePath,
        }),
      });
    },
    [
      activeProject,
      activeKnownTerminalIds,
      activeTerminalGroup,
      activeThreadId,
      activeThreadRef,
      openTerminalWithRollback,
      panelTerminalIds,
      persistLocalDraftThread,
      activeThreadWorktreePath,
      gitCwd,
      storeSetActiveTerminal,
      storeSplitTerminal,
      storeSplitTerminalVertical,
      terminalUiState.activeTerminalId,
      terminalUiState.terminalGroups,
    ],
  );
  const createNewTerminal = useCallback(() => {
    if (!activeThreadRef || !activeThreadId || !activeProject) {
      return;
    }
    const cwdForOpen = gitCwd ?? activeProject.workspaceRoot;
    if (!cwdForOpen) {
      return;
    }
    const terminalId = nextTerminalId([...activeKnownTerminalIds, ...panelTerminalIds]);
    if (terminalUiState.terminalIds.length === 0) {
      storeNewTerminal(activeThreadRef, terminalId);
    } else {
      // Same rule as the drawer's plus: one layout per thread, never a new group.
      if ((activeTerminalGroup?.terminalIds.length ?? 0) >= MAX_TERMINALS_PER_GROUP) {
        return;
      }
      storeSplitTerminal(activeThreadRef, terminalId);
    }
    setTerminalFocusRequestId((value) => value + 1);
    void persistLocalDraftThread();
    void openTerminalWithRollback(activeThreadRef, terminalId, {
      threadId: activeThreadId,
      terminalId,
      cwd: cwdForOpen,
      ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
      env: projectScriptRuntimeEnv({
        project: { cwd: activeProject.workspaceRoot },
        worktreePath: activeThreadWorktreePath,
      }),
    });
  }, [
    activeProject,
    activeKnownTerminalIds,
    activeThreadId,
    activeThreadRef,
    openTerminalWithRollback,
    panelTerminalIds,
    persistLocalDraftThread,
    activeThreadWorktreePath,
    activeTerminalGroup,
    gitCwd,
    storeNewTerminal,
    storeSplitTerminal,
    terminalUiState.terminalIds.length,
  ]);
  const closeTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadId || !activeThreadRef) return;
      const fallbackExitWrite = () =>
        writeTerminal({
          environmentId,
          input: { threadId: activeThreadId, terminalId, data: "exit\n" },
        });
      void (async () => {
        const closeResult = await closeTerminalMutation({
          environmentId,
          input: {
            threadId: activeThreadId,
            terminalId,
            deleteHistory: true,
          },
        });
        if (closeResult._tag === "Failure" && !isAtomCommandInterrupted(closeResult)) {
          await fallbackExitWrite();
        }
      })();
      storeCloseTerminal(activeThreadRef, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [
      activeThreadId,
      activeThreadRef,
      closeTerminalMutation,
      environmentId,
      storeCloseTerminal,
      writeTerminal,
    ],
  );
  const runProjectScript = useCallback(
    async (
      script: ProjectScript,
      options?: {
        cwd?: string;
        env?: Record<string, string>;
        worktreePath?: string | null;
        preferNewTerminal?: boolean;
        rememberAsLastInvoked?: boolean;
      },
    ) => {
      if (!activeThreadId || !activeProject || !activeThread) return;
      if (!scriptsForThread([script], activeProject.id, activeThreadId).length) return;
      if (options?.rememberAsLastInvoked !== false) {
        setLastInvokedScriptByProjectId((current) => {
          if (current[activeProject.id] === script.id) return current;
          return { ...current, [activeProject.id]: script.id };
        });
      }
      const targetCwd = options?.cwd ?? gitCwd ?? activeProject.workspaceRoot;
      const baseTerminalId =
        terminalUiState.activeTerminalId || activeKnownTerminalIds[0] || DEFAULT_THREAD_TERMINAL_ID;
      const isBaseTerminalBusy = runningTerminalIds.includes(baseTerminalId);
      const wantsNewTerminal = Boolean(options?.preferNewTerminal) || isBaseTerminalBusy;
      const shouldCreateNewTerminal = wantsNewTerminal;
      const targetWorktreePath = options?.worktreePath ?? activeThread.worktreePath ?? null;

      setTerminalUiLaunchContext({
        threadId: activeThreadId,
        cwd: targetCwd,
        worktreePath: targetWorktreePath,
      });
      showTerminalSurface();
      if (!activeThreadRef) {
        return;
      }
      setTerminalFocusRequestId((value) => value + 1);

      const runtimeEnv = projectScriptRuntimeEnv({
        project: {
          cwd: activeProject.workspaceRoot,
        },
        worktreePath: targetWorktreePath,
        ...(options?.env ? { extraEnv: options.env } : {}),
      });
      const targetTerminalId = shouldCreateNewTerminal
        ? nextTerminalId([...activeKnownTerminalIds, ...panelTerminalIds])
        : baseTerminalId;
      const openTerminalInput: TerminalOpenInput = shouldCreateNewTerminal
        ? {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            ...(targetWorktreePath !== null ? { worktreePath: targetWorktreePath } : {}),
            env: runtimeEnv,
            cols: SCRIPT_TERMINAL_COLS,
            rows: SCRIPT_TERMINAL_ROWS,
          }
        : {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            ...(targetWorktreePath !== null ? { worktreePath: targetWorktreePath } : {}),
            env: runtimeEnv,
          };

      if (agentSurfaces) {
        useRightPanelStore.getState().openTerminal(activeThreadRef, targetTerminalId);
      } else if (shouldCreateNewTerminal) {
        storeNewTerminal(activeThreadRef, targetTerminalId);
      } else {
        storeSetActiveTerminal(activeThreadRef, targetTerminalId);
      }

      const openResult = await openTerminalWithRollback(
        activeThreadRef,
        targetTerminalId,
        openTerminalInput,
      );
      if (openResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(openResult)) {
          const error = squashAtomCommandFailure(openResult);
          setThreadError(
            activeThreadId,
            error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
          );
        }
        return;
      }

      const writeResult = await writeTerminal({
        environmentId,
        input: {
          threadId: activeThreadId,
          terminalId: targetTerminalId,
          data: `${script.command}\r`,
        },
      });
      if (writeResult._tag === "Failure" && !isAtomCommandInterrupted(writeResult)) {
        const error = squashAtomCommandFailure(writeResult);
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
        );
      }
    },
    [
      activeProject,
      activeThread,
      activeThreadId,
      activeThreadRef,
      gitCwd,
      showTerminalSurface,
      setThreadError,
      storeNewTerminal,
      storeSetActiveTerminal,
      setLastInvokedScriptByProjectId,
      environmentId,
      openTerminalWithRollback,
      activeKnownTerminalIds,
      panelTerminalIds,
      runningTerminalIds,
      agentSurfaces,
      terminalUiState.activeTerminalId,
      writeTerminal,
    ],
  );

  const persistProjectScripts = useCallback(
    async (input: {
      projectId: ProjectId;
      projectCwd: string;
      previousScripts: ReadonlyArray<ProjectScript>;
      nextScripts: ReadonlyArray<ProjectScript>;
      keybinding?: string | null;
      keybindingCommand: KeybindingCommand;
    }): Promise<AtomCommandResult<void, unknown>> => {
      const updateResult = mapAtomCommandResult(
        await updateProject({
          environmentId,
          input: {
            projectId: input.projectId,
            scripts: input.nextScripts,
          },
        }),
        () => undefined,
      );
      if (updateResult._tag === "Failure") {
        return updateResult;
      }

      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding: input.keybinding,
        command: input.keybindingCommand,
      });

      if (isElectron && keybindingRule) {
        return mapAtomCommandResult(
          await upsertKeybinding({
            environmentId,
            input: keybindingRule,
          }),
          () => undefined,
        );
      }
      return updateResult;
    },
    [environmentId, updateProject, upsertKeybinding],
  );
  const saveProjectScript = useCallback(
    async (input: NewProjectScriptInput): Promise<AtomCommandResult<void, unknown>> => {
      if (!activeProject) {
        return AsyncResult.success(undefined);
      }
      const nextId = nextProjectScriptId(
        input.name,
        activeProject.scripts.map((script) => script.id),
      );
      const nextScript = {
        ...buildProjectScript(nextId, input),
        ...(isAgentsProjectId(activeProject.id) && activeThreadId
          ? { ownerThreadId: activeThreadId }
          : {}),
      };
      const nextScripts = input.runOnWorktreeCreate
        ? [
            ...activeProject.scripts.map((script) =>
              script.runOnWorktreeCreate && script.ownerThreadId === nextScript.ownerThreadId
                ? { ...script, runOnWorktreeCreate: false }
                : script,
            ),
            nextScript,
          ]
        : [...activeProject.scripts, nextScript];

      return persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.workspaceRoot,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(nextId),
      });
    },
    [activeProject, activeThreadId, agentSurfaces, persistProjectScripts],
  );
  const updateProjectScript = useCallback(
    async (
      scriptId: string,
      input: NewProjectScriptInput,
    ): Promise<AtomCommandResult<void, unknown>> => {
      if (!activeProject) {
        return AsyncResult.success(undefined);
      }
      const existingScript = scriptsForThread(
        activeProject.scripts,
        activeProject.id,
        activeThreadId,
      ).find((script) => script.id === scriptId);
      if (!existingScript) {
        return AsyncResult.failure(Cause.fail(new Error("Script not found.")));
      }

      const updatedScript = {
        ...buildProjectScript(existingScript.id, input),
        ...(existingScript.ownerThreadId ? { ownerThreadId: existingScript.ownerThreadId } : {}),
      };
      const nextScripts = activeProject.scripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : input.runOnWorktreeCreate && script.ownerThreadId === existingScript.ownerThreadId
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      );

      return persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.workspaceRoot,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(scriptId),
      });
    },
    [activeProject, activeThreadId, persistProjectScripts],
  );
  const deleteProjectScript = useCallback(
    async (scriptId: string): Promise<AtomCommandResult<void, unknown>> => {
      if (!activeProject) {
        return AsyncResult.success(undefined);
      }
      if (
        !scriptsForThread(activeProject.scripts, activeProject.id, activeThreadId).some(
          (script) => script.id === scriptId,
        )
      )
        return AsyncResult.success(undefined);
      const nextScripts = activeProject.scripts.filter((script) => script.id !== scriptId);

      const deletedName = activeProject.scripts.find((s) => s.id === scriptId)?.name;

      const result = await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.workspaceRoot,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: null,
        keybindingCommand: commandForProjectScript(scriptId),
      });
      if (result._tag === "Success") {
        toastManager.add({
          type: "success",
          title: `Deleted action "${deletedName ?? "Unknown"}"`,
        });
      } else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not delete action",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          }),
        );
      }
      return result;
    },
    [activeProject, activeThreadId, persistProjectScripts],
  );

  const handleRuntimeModeChange = useCallback(
    (mode: RuntimeMode) => {
      if (mode === runtimeMode) return;
      setComposerDraftRuntimeMode(composerDraftTarget, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(composerDraftTarget, { runtimeMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      isLocalDraftThread,
      runtimeMode,
      scheduleComposerFocus,
      composerDraftTarget,
      setComposerDraftRuntimeMode,
      setDraftThreadContext,
    ],
  );

  const handleInteractionModeChange = useCallback(
    (mode: ProviderInteractionMode) => {
      if (mode === interactionMode) return;
      setComposerDraftInteractionMode(composerDraftTarget, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(composerDraftTarget, { interactionMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      interactionMode,
      isLocalDraftThread,
      scheduleComposerFocus,
      composerDraftTarget,
      setComposerDraftInteractionMode,
      setDraftThreadContext,
    ],
  );
  const toggleInteractionMode = useCallback(() => {
    handleInteractionModeChange(interactionMode === "plan" ? "default" : "plan");
  }, [handleInteractionModeChange, interactionMode]);
  const dismissPlanSidebarForCurrentTurn = useCallback(() => {
    planSidebarDismissedForTurnRef.current =
      activePlan?.turnId ?? sidebarProposedPlan?.turnId ?? "__dismissed__";
  }, [activePlan?.turnId, sidebarProposedPlan?.turnId]);
  const togglePlanSidebar = useCallback(() => {
    if (!activeThreadRef) return;
    if (planSidebarOpen) {
      dismissPlanSidebarForCurrentTurn();
    } else {
      planSidebarDismissedForTurnRef.current = null;
    }
    useRightPanelStore.getState().toggle(activeThreadRef, "plan");
  }, [activeThreadRef, dismissPlanSidebarForCurrentTurn, planSidebarOpen]);
  const closePlanSidebar = useCallback(() => {
    if (!activeThreadRef) return;
    setMaximizedRightPanelThreadKey(null);
    useRightPanelStore.getState().close(activeThreadRef);
    dismissPlanSidebarForCurrentTurn();
  }, [activeThreadRef, dismissPlanSidebarForCurrentTurn]);
  const createBrowserSurface = useCallback(() => {
    if (!activeThreadRef) return;
    void addBrowserSurface({ threadRef: activeThreadRef, openPreview });
  }, [activeThreadRef, openPreview]);
  const addDiffSurface = useCallback(() => {
    if (!activeThreadRef || !isServerThread || !isGitRepo) return;
    if (planSidebarOpen) {
      dismissPlanSidebarForCurrentTurn();
    }
    useRightPanelStore.getState().open(activeThreadRef, "diff");
    onDiffPanelOpen?.();
  }, [
    activeThreadRef,
    dismissPlanSidebarForCurrentTurn,
    isGitRepo,
    isServerThread,
    onDiffPanelOpen,
    planSidebarOpen,
  ]);
  const addFilesSurface = useCallback(() => {
    if (!activeThreadRef || !activeProject) return;
    useRightPanelStore.getState().open(activeThreadRef, "files");
  }, [activeProject, activeThreadRef]);
  const syncArtifactRoute = useCallback(
    (surface: RightPanelSurface | null) => {
      if (routeKind !== "server" || embeddedSideChat || routeThreadRef === null) return;
      const artifactId = surface?.kind === "artifact" ? surface.resourceId : null;
      if (artifactId === requestedArtifactId) return;
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(routeThreadRef),
        search: artifactId ? { artifact: artifactId } : {},
        replace: true,
      });
    },
    [embeddedSideChat, navigate, requestedArtifactId, routeKind, routeThreadRef],
  );
  const openArtifactSurface = useCallback(
    (target: { readonly summary: ThreadArtifactSummary }) => {
      if (!activeThreadRef || target.summary.artifact.threadId !== activeThreadRef.threadId) return;
      useRightPanelStore
        .getState()
        .openArtifact(
          activeThreadRef,
          target.summary.artifact.artifactId,
          target.summary.artifact.currentRevision,
          target.summary.artifact.title,
        );
      syncArtifactRoute({
        id: `artifact:${target.summary.artifact.artifactId}`,
        kind: "artifact",
        resourceId: target.summary.artifact.artifactId,
        revision: target.summary.artifact.currentRevision,
        title: target.summary.artifact.title,
      });
    },
    [activeThreadRef, syncArtifactRoute],
  );
  const addSideChatSurface = useCallback(() => {
    if (!activeThreadRef || !sideChatAvailable) return;
    void forkThreadAction(activeThreadRef, { asSideChat: true, navigate: !agentSurfaces }).then(
      (result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to open side chat",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      },
    );
  }, [activeThreadRef, agentSurfaces, forkThreadAction, sideChatAvailable]);
  const openFileSurface = useCallback(
    (relativePath: string) => {
      if (!activeThreadRef || !activeProject) return;
      useRightPanelStore.getState().openFile(activeThreadRef, relativePath);
    },
    [activeProject, activeThreadRef],
  );
  const togglePreviewPanel = useCallback(() => {
    if (!activeThreadRef || !isPreviewSupportedInRuntime()) return;
    if (previewPanelOpen) {
      useRightPanelStore.getState().close(activeThreadRef);
      return;
    }
    const activeTabId = activePreviewState.activeTabId;
    if (activeTabId) {
      useRightPanelStore.getState().openBrowser(activeThreadRef, activeTabId);
    } else {
      createBrowserSurface();
    }
  }, [activePreviewState.activeTabId, activeThreadRef, createBrowserSurface, previewPanelOpen]);
  const closePreviewPanel = useCallback(() => {
    if (activeThreadRef) {
      setMaximizedRightPanelThreadKey(null);
      useRightPanelStore.getState().close(activeThreadRef);
    }
  }, [activeThreadRef]);
  const addTerminalSurface = useCallback(() => {
    if (!activeThreadRef || !activeThreadId || !activeProject) return;
    const cwd = gitCwd ?? activeProject.workspaceRoot;
    const terminalId = nextTerminalId([...activeKnownTerminalIds, ...panelTerminalIds]);
    // Every terminal shares one surface, so the rollback has to target that id.
    // Building `terminal:${terminalId}` here matched nothing, which left a dead
    // tab behind whenever opening the terminal failed.
    const surfaceId = THREAD_TERMINAL_SURFACE_ID;
    useRightPanelStore.getState().openTerminal(activeThreadRef, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
    void openTerminalWithRollback(
      activeThreadRef,
      terminalId,
      {
        threadId: activeThreadId,
        terminalId,
        cwd,
        ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
        env: projectScriptRuntimeEnv({
          project: { cwd: activeProject.workspaceRoot },
          worktreePath: activeThreadWorktreePath,
        }),
      },
      () => useRightPanelStore.getState().closeTerminal(activeThreadRef, surfaceId, terminalId),
    );
  }, [
    activeKnownTerminalIds,
    activeProject,
    activeThreadId,
    activeThreadRef,
    activeThreadWorktreePath,
    gitCwd,
    openTerminalWithRollback,
    panelTerminalIds,
  ]);
  const activatePanelTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadRef || activeRightPanelSurface?.kind !== "terminal") return;
      useRightPanelStore
        .getState()
        .activateTerminal(activeThreadRef, activeRightPanelSurface.id, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeRightPanelSurface, activeThreadRef],
  );
  const closePanelTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadRef || activeRightPanelSurface?.kind !== "terminal") return;
      void closeTerminalMutation({
        environmentId: activeThreadRef.environmentId,
        input: { threadId: activeThreadRef.threadId, terminalId, deleteHistory: true },
      });
      storeCloseTerminal(activeThreadRef, terminalId);
      useRightPanelStore
        .getState()
        .closeTerminal(activeThreadRef, activeRightPanelSurface.id, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeRightPanelSurface, activeThreadRef, closeTerminalMutation, storeCloseTerminal],
  );
  const activateRightPanelSurface = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      if (surface.kind === "plan") {
        planSidebarDismissedForTurnRef.current = null;
      } else if (planSidebarOpen) {
        dismissPlanSidebarForCurrentTurn();
      }
      useRightPanelStore.getState().activateSurface(activeThreadRef, surface.id);
      if (surface.kind === "preview" && surface.resourceId) {
        setActivePreviewTab(activeThreadRef, surface.resourceId);
      }
      if (surface.kind === "terminal") {
        setTerminalFocusRequestId((value) => value + 1);
      }
      if (surface.kind === "diff" && !diffOpen) {
        onDiffPanelOpen?.();
      }
      syncArtifactRoute(surface);
    },
    [
      activeThreadRef,
      diffOpen,
      dismissPlanSidebarForCurrentTurn,
      onDiffPanelOpen,
      planSidebarOpen,
      syncArtifactRoute,
    ],
  );
  const openWorkingSideChat = useCallback(() => {
    if (!activeThreadRef) return;
    const threadId = activeSideChatActivity?.threadIds[0];
    if (!threadId) return;
    const thread = sideChatChildShells.find((entry) => entry.id === threadId);
    if (!thread) return;
    useRightPanelStore
      .getState()
      .openSideChat(activeThreadRef, thread.id, sideChatDisplayTitle(thread.title));
  }, [activeSideChatActivity?.threadIds, activeThreadRef, sideChatChildShells]);
  const openWorkingTerminal = useCallback(() => {
    if (!routeThreadRef) return;
    const terminalId = activeTerminalActivity?.terminalIds[0];
    if (agentSurfaces) {
      if (terminalId) {
        const panel = useRightPanelStore.getState();
        const surface = rightPanelState.surfaces.find(
          (entry) => entry.kind === "terminal" && entry.terminalIds.includes(terminalId),
        );
        if (surface?.kind === "terminal") {
          panel.activateTerminal(routeThreadRef, surface.id, terminalId);
          panel.activateSurface(routeThreadRef, surface.id);
        } else {
          panel.openTerminal(routeThreadRef, terminalId);
        }
        setTerminalFocusRequestId((value) => value + 1);
      }
      return;
    }
    storeSetMainSurface(routeThreadRef, "terminal");
    if (terminalId) {
      storeSetActiveTerminal(routeThreadRef, terminalId);
    }
  }, [
    activeTerminalActivity?.terminalIds,
    agentSurfaces,
    rightPanelState.surfaces,
    routeThreadRef,
    storeSetActiveTerminal,
    storeSetMainSurface,
  ]);
  const toggleRightPanel = useCallback(() => {
    if (!activeThreadRef) return;
    if (rightPanelOpen) {
      if (planSidebarOpen) {
        closePlanSidebar();
      } else {
        closePreviewPanel();
      }
      return;
    }
    useRightPanelStore.getState().toggleVisibility(activeThreadRef);
  }, [activeThreadRef, closePlanSidebar, closePreviewPanel, planSidebarOpen, rightPanelOpen]);
  const toggleRightPanelMaximized = useCallback(() => {
    if (!canMaximizeRightPanel) return;
    setMaximizedRightPanelThreadKey((threadKey) =>
      threadKey === routeThreadKey ? null : routeThreadKey,
    );
  }, [canMaximizeRightPanel, routeThreadKey]);
  const requestSideChatArchive = useCallback(
    (surfaces: readonly SideChatSurface[]) => {
      if (!activeThreadRef) return;
      setPendingSideChatArchives((current) => {
        const next = [...current];
        const queuedIds = new Set(
          next.map(
            (entry) => `${scopedThreadKey(entry.parentThreadRef)}:${entry.surface.resourceId}`,
          ),
        );
        for (const surface of surfaces) {
          const queueId = `${scopedThreadKey(activeThreadRef)}:${surface.resourceId}`;
          if (queuedIds.has(queueId)) continue;
          queuedIds.add(queueId);
          next.push({ parentThreadRef: activeThreadRef, surface });
        }
        return next;
      });
    },
    [activeThreadRef],
  );
  const promoteSideChatSurface = useCallback(
    (surface: Extract<RightPanelSurface, { kind: "side-chat" }>) => {
      if (
        !activeThreadRef ||
        !activeProject ||
        isAgentsProjectId(activeProject.id) ||
        promotingSideChatThreadId !== null
      )
        return;
      const sideChatThreadRef = scopeThreadRef(
        activeThreadRef.environmentId,
        ThreadId.make(surface.resourceId),
      );
      setPromotingSideChatThreadId(surface.resourceId);
      void promoteSideChatAction(sideChatThreadRef).then((result) => {
        setPromotingSideChatThreadId(null);
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to promote side chat",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }
        useRightPanelStore.getState().closeSurface(activeThreadRef, surface.id);
        toastManager.add({ type: "success", title: "Side chat promoted to a thread" });
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(sideChatThreadRef),
        });
      });
    },
    [activeThreadRef, activeProject, navigate, promoteSideChatAction, promotingSideChatThreadId],
  );
  const cleanupRightPanelSurfaces = useCallback(
    (surfaces: readonly RightPanelSurface[]) => {
      if (!activeThreadRef) return;
      if (surfaces.some((surface) => surface.kind === "plan")) {
        dismissPlanSidebarForCurrentTurn();
      }

      for (const surface of surfaces) {
        if (surface.kind === "preview" && surface.resourceId) {
          void closePreviewSession({
            closePreview,
            snapshot: activePreviewState.sessions[surface.resourceId] ?? null,
            tabId: surface.resourceId,
            threadRef: activeThreadRef,
          });
        }
        if (surface.kind === "terminal") {
          for (const terminalId of surface.terminalIds) {
            storeCloseTerminal(activeThreadRef, terminalId);
            void closeTerminalMutation({
              environmentId: activeThreadRef.environmentId,
              input: { threadId: activeThreadRef.threadId, terminalId, deleteHistory: true },
            });
          }
        }
        if (surface.kind === "side-chat") {
          requestSideChatArchive([surface]);
          continue;
        }
        useRightPanelStore.getState().closeSurface(activeThreadRef, surface.id);
      }
    },
    [
      activeThreadRef,
      activePreviewState.sessions,
      closePreview,
      closeTerminalMutation,
      dismissPlanSidebarForCurrentTurn,
      requestSideChatArchive,
      storeCloseTerminal,
    ],
  );
  const syncActivePreviewSurface = useCallback(() => {
    if (!activeThreadRef) return;
    const nextActiveSurface = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      activeThreadRef,
    );
    if (nextActiveSurface?.kind === "preview" && nextActiveSurface.resourceId) {
      setActivePreviewTab(activeThreadRef, nextActiveSurface.resourceId);
    }
  }, [activeThreadRef]);
  const syncActiveArtifactRoute = useCallback(() => {
    if (!activeThreadRef) return;
    syncArtifactRoute(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, activeThreadRef),
    );
  }, [activeThreadRef, syncArtifactRoute]);
  const pendingSideChatArchive = pendingSideChatArchives[0] ?? null;
  const confirmSideChatArchive = useCallback(() => {
    if (!pendingSideChatArchive || archivingSideChatThreadId !== null) return;
    const { parentThreadRef, surface } = pendingSideChatArchive;
    const sideChatThreadRef = scopeThreadRef(
      parentThreadRef.environmentId,
      ThreadId.make(surface.resourceId),
    );
    const pendingKey = `${scopedThreadKey(parentThreadRef)}:${surface.resourceId}`;
    setArchivingSideChatThreadId(surface.resourceId);
    setClosingSideChatThreadIds((current) => new Set(current).add(surface.resourceId));
    void archiveThreadAction(sideChatThreadRef).then((result) => {
      setArchivingSideChatThreadId(null);
      if (result._tag === "Success") {
        const rightPanelStore = useRightPanelStore.getState();
        rightPanelStore.closeSurface(parentThreadRef, surface.id);
        const nextSurface = selectActiveRightPanelSurface(
          useRightPanelStore.getState().byThreadKey,
          parentThreadRef,
        );
        if (nextSurface?.kind === "preview" && nextSurface.resourceId) {
          setActivePreviewTab(parentThreadRef, nextSurface.resourceId);
        }
        setPendingSideChatArchives((current) =>
          current.filter(
            (entry) =>
              `${scopedThreadKey(entry.parentThreadRef)}:${entry.surface.resourceId}` !==
              pendingKey,
          ),
        );
        toastManager.add({ type: "success", title: "Side chat archived" });
        return;
      }

      setClosingSideChatThreadIds((current) => {
        if (!current.has(surface.resourceId)) return current;
        const next = new Set(current);
        next.delete(surface.resourceId);
        return next;
      });
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to archive side chat",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    });
  }, [archiveThreadAction, archivingSideChatThreadId, pendingSideChatArchive]);
  const closeRightPanelSurface = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      cleanupRightPanelSurfaces([surface]);
      syncActivePreviewSurface();
      syncActiveArtifactRoute();
    },
    [activeThreadRef, cleanupRightPanelSurfaces, syncActiveArtifactRoute, syncActivePreviewSurface],
  );
  const closeOtherRightPanelSurfaces = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      const surfaces = rightPanelState.surfaces.filter((entry) => entry.id !== surface.id);
      cleanupRightPanelSurfaces(surfaces);
      useRightPanelStore.getState().activateSurface(activeThreadRef, surface.id);
      syncActivePreviewSurface();
      syncArtifactRoute(surface);
    },
    [
      activeThreadRef,
      cleanupRightPanelSurfaces,
      rightPanelState.surfaces,
      syncArtifactRoute,
      syncActivePreviewSurface,
    ],
  );
  const closeRightPanelSurfacesToRight = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      const surfaceIndex = rightPanelState.surfaces.findIndex((entry) => entry.id === surface.id);
      if (surfaceIndex < 0) return;
      const surfaces = rightPanelState.surfaces.slice(surfaceIndex + 1);
      cleanupRightPanelSurfaces(surfaces);
      useRightPanelStore.getState().activateSurface(activeThreadRef, surface.id);
      syncActivePreviewSurface();
      syncArtifactRoute(surface);
    },
    [
      activeThreadRef,
      cleanupRightPanelSurfaces,
      rightPanelState.surfaces,
      syncArtifactRoute,
      syncActivePreviewSurface,
    ],
  );
  const closeAllRightPanelSurfaces = useCallback(() => {
    if (!activeThreadRef) return;
    cleanupRightPanelSurfaces(rightPanelState.surfaces);
    syncActiveArtifactRoute();
  }, [
    activeThreadRef,
    cleanupRightPanelSurfaces,
    rightPanelState.surfaces,
    syncActiveArtifactRoute,
  ]);
  const reorderRightPanelSurface = useCallback(
    (surface: RightPanelSurface, overSurfaceId: string) => {
      if (!activeThreadRef) return;
      useRightPanelStore.getState().reorderSurface(activeThreadRef, surface.id, overSurfaceId);
    },
    [activeThreadRef],
  );
  const renameRightPanelSurface = useCallback(
    (surface: RightPanelSurface, title: string) => {
      if (!activeThreadRef) return;
      useRightPanelStore.getState().renameSurface(activeThreadRef, surface.id, title);
    },
    [activeThreadRef],
  );
  const copyRightPanelFilePath = useCallback((relativePath: string) => {
    if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: "Clipboard API unavailable.",
        }),
      );
      return;
    }

    void navigator.clipboard.writeText(relativePath).then(
      () => {
        toastManager.add({
          type: "success",
          title: "Path copied",
          description: relativePath,
        });
      },
      (error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to copy path",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      },
    );
  }, []);
  const copySideChatId = useCallback((threadId: string) => {
    if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy chat ID",
          description: "Clipboard API unavailable.",
        }),
      );
      return;
    }

    void navigator.clipboard.writeText(threadId).then(
      () => {
        toastManager.add({
          type: "success",
          title: "Chat ID copied",
          description: threadId,
        });
      },
      (error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to copy chat ID",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      },
    );
  }, []);
  useEffect(
    () =>
      subscribePreviewAction((action) => {
        if (action === "toggle-panel") togglePreviewPanel();
      }),
    [togglePreviewPanel],
  );
  // Debounce *showing* the scroll-to-bottom pill so it doesn't flash during
  // thread switches. LegendList fires scroll events with isAtEnd=false while
  // initialScrollAtEnd is settling; hiding is always immediate.
  const showScrollDebouncer = useRef(
    new Debouncer(() => setShowScrollToBottom(true), { wait: 150 }),
  );
  const restoredTimelineScroll = timelineThreadScrollMemory.get(routeThreadKey) ?? null;
  const [timelineLiveFollowByThreadKey, setTimelineLiveFollowByThreadKey] = useState<
    Record<string, boolean>
  >({});
  const timelineLiveFollowEnabled =
    timelineLiveFollowByThreadKey[routeThreadKey] ?? restoredTimelineScroll?.followEnd ?? true;
  const setTimelineLiveFollowEnabled = useCallback(
    (enabled: boolean) => {
      setTimelineLiveFollowByThreadKey((existing) =>
        existing[routeThreadKey] === enabled
          ? existing
          : { ...existing, [routeThreadKey]: enabled },
      );
    },
    [routeThreadKey],
  );
  const timelineScrollModeRef = useRef<TimelineScrollMode>("following-end");
  const anchorUserScrollGenerationRef = useRef(0);
  const liveFollowUserScrollGenerationRef = useRef<number | null>(0);
  const timelineManualNavigationActiveRef = useRef(false);
  const timelineManualNavigationTowardEndRef = useRef(false);
  const cancelTimelineLiveFollowForUserNavigation = useCallback(
    (towardEnd = false) => {
      const alreadyOwnsViewport =
        timelineManualNavigationActiveRef.current &&
        timelineManualNavigationTowardEndRef.current === towardEnd;
      // Persist ownership only when the navigation direction changes.
      if (alreadyOwnsViewport) return;
      if (!timelineManualNavigationActiveRef.current) {
        anchorUserScrollGenerationRef.current += 1;
      }
      timelineManualNavigationActiveRef.current = true;
      timelineManualNavigationTowardEndRef.current = towardEnd;
      setTimelineLiveFollowEnabled(false);
      timelineScrollModeRef.current = "free-scrolling";
      liveFollowUserScrollGenerationRef.current = null;
      showScrollDebouncer.current.maybeExecute();
      const scrollOffset = legendListRef.current?.getState?.().scroll;
      if (typeof scrollOffset === "number" && Number.isFinite(scrollOffset)) {
        rememberTimelineThreadScroll(timelineThreadScrollMemory, routeThreadKey, {
          scrollOffset,
          followEnd: false,
        });
      }
    },
    [routeThreadKey, setTimelineLiveFollowEnabled],
  );
  // Live-follow stays active after send/thread-open until an actual list scroll
  // gesture opts out.
  const scrollToEnd = useCallback(
    (animated = false) => {
      isAtEndRef.current = true;
      timelineManualNavigationActiveRef.current = false;
      timelineManualNavigationTowardEndRef.current = false;
      setTimelineLiveFollowEnabled(true);
      timelineScrollModeRef.current = "following-end";
      liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
      rememberTimelineThreadScroll(timelineThreadScrollMemory, routeThreadKey, {
        scrollOffset: 0,
        followEnd: true,
      });
      void legendListRef.current?.scrollToEnd?.({ animated });
    },
    [routeThreadKey, setTimelineLiveFollowEnabled],
  );
  const prepareTimelineForSend = useCallback(
    (messageId: MessageId) => {
      const plan = resolveTimelineSendScrollPlan({
        messageId,
      });
      timelineManualNavigationActiveRef.current = false;
      timelineManualNavigationTowardEndRef.current = false;
      timelineScrollModeRef.current = plan.mode;
      scrollToEnd(false);
    },
    [scrollToEnd],
  );

  const onIsAtEndChange = useCallback(
    (isAtEnd: boolean) => {
      const manualNavigationActive = timelineManualNavigationActiveRef.current;
      const shouldResumeLiveFollow = shouldResumeTimelineLiveFollow({
        isAtEnd,
        manualNavigationActive,
        manualNavigationTowardEnd: timelineManualNavigationTowardEndRef.current,
      });
      if (isAtEnd && !shouldResumeLiveFollow) {
        return;
      }
      if (
        !isAtEnd &&
        liveFollowUserScrollGenerationRef.current === anchorUserScrollGenerationRef.current
      ) {
        showScrollDebouncer.current.cancel();
        setShowScrollToBottom(false);
        return;
      }
      const isExplicitManualReturn = isAtEnd && manualNavigationActive && shouldResumeLiveFollow;
      if (isAtEndRef.current === isAtEnd && !isExplicitManualReturn) return;
      isAtEndRef.current = isAtEnd;
      if (isAtEnd) {
        timelineManualNavigationActiveRef.current = false;
        timelineManualNavigationTowardEndRef.current = false;
        setTimelineLiveFollowEnabled(true);
        timelineScrollModeRef.current = "following-end";
        liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
        showScrollDebouncer.current.cancel();
        setShowScrollToBottom(false);
        rememberTimelineThreadScroll(timelineThreadScrollMemory, routeThreadKey, {
          scrollOffset: 0,
          followEnd: true,
        });
      } else {
        setTimelineLiveFollowEnabled(false);
        timelineScrollModeRef.current = "free-scrolling";
        liveFollowUserScrollGenerationRef.current = null;
        const scrollOffset = legendListRef.current?.getState?.().scroll;
        if (typeof scrollOffset === "number" && Number.isFinite(scrollOffset)) {
          rememberTimelineThreadScroll(timelineThreadScrollMemory, routeThreadKey, {
            scrollOffset,
            followEnd: false,
          });
        }
        showScrollDebouncer.current.maybeExecute();
      }
    },
    [routeThreadKey, setTimelineLiveFollowEnabled],
  );
  const onTimelineScrollStateChange = useCallback(
    ({
      scrollOffset,
      isAtEnd,
    }: {
      readonly scrollOffset: number;
      readonly isAtEnd: boolean | undefined;
    }) => {
      rememberTimelineThreadScroll(timelineThreadScrollMemory, routeThreadKey, {
        scrollOffset,
        followEnd: resolveTimelineScrollSnapshotFollowEnd({
          isAtEnd,
          scrollMode: timelineScrollModeRef.current,
        }),
      });
    },
    [routeThreadKey],
  );

  useLayoutEffect(() => {
    const threadKey = routeThreadKey;
    const restored = timelineThreadScrollMemory.get(threadKey) ?? null;
    const shouldFollowEnd = restored?.followEnd ?? true;
    isAtEndRef.current = shouldFollowEnd;
    setTimelineLiveFollowEnabled(shouldFollowEnd);
    timelineScrollModeRef.current = shouldFollowEnd ? "following-end" : "free-scrolling";
    liveFollowUserScrollGenerationRef.current = shouldFollowEnd
      ? anchorUserScrollGenerationRef.current
      : null;
    timelineManualNavigationActiveRef.current = !shouldFollowEnd;
    timelineManualNavigationTowardEndRef.current = false;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(!shouldFollowEnd);

    return () => {
      showScrollDebouncer.current.cancel();
    };
  }, [routeThreadKey, setTimelineLiveFollowEnabled]);

  useEffect(() => {
    setPullRequestDialogState(null);
    if (planSidebarOpenOnNextThreadRef.current) {
      planSidebarOpenOnNextThreadRef.current = false;
      if (activeThreadRef) {
        useRightPanelStore.getState().open(activeThreadRef, "plan");
      }
    }
    planSidebarDismissedForTurnRef.current = null;
    // activeThreadRef resets transitively with the active thread.
  }, [activeThread?.id]);

  // Auto-open the plan sidebar when plan/todo steps arrive for the current turn.
  // Don't auto-open for plans carried over from a previous turn (the user can open manually).
  useEffect(() => {
    if (!autoOpenPlanSidebar) return;
    if (!activePlan) return;
    if (planSidebarOpen) return;
    const latestTurnId = activeLatestTurn?.turnId ?? null;
    if (latestTurnId && activePlan.turnId !== latestTurnId) return;
    const turnKey = activePlan.turnId ?? sidebarProposedPlan?.turnId ?? "__dismissed__";
    if (planSidebarDismissedForTurnRef.current === turnKey) return;
    if (activeThreadRef) {
      useRightPanelStore.getState().open(activeThreadRef, "plan");
    }
  }, [
    activePlan,
    activeLatestTurn?.turnId,
    activeThreadRef,
    autoOpenPlanSidebar,
    planSidebarOpen,
    sidebarProposedPlan?.turnId,
  ]);

  useEffect(() => {
    setIsRevertingCheckpoint(false);
  }, [activeThread?.id]);

  useEffect(() => {
    if (
      !shouldAutoFocusComposerOnThreadOpen({
        hasThread: Boolean(activeThread?.id),
        terminalSurfaceActive: terminalMainSurfaceActive,
        previewFocused: isPreviewFocused(),
        usesOnScreenKeyboard,
      })
    ) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, focusComposer, terminalMainSurfaceActive, usesOnScreenKeyboard]);

  useEffect(() => {
    if (!activeThread?.id) return;
    if (activeThread.messages.length === 0) {
      return;
    }
    const serverIds = new Set(activeThread.messages.map((message) => message.id));
    const removedMessages = optimisticUserMessages.filter((message) => serverIds.has(message.id));
    if (removedMessages.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      setOptimisticUserMessages((existing) =>
        existing.filter((message) => !serverIds.has(message.id)),
      );
    }, 0);
    for (const removedMessage of removedMessages) {
      const previewUrls = collectUserMessageBlobPreviewUrls(removedMessage);
      if (previewUrls.length > 0) {
        handoffAttachmentPreviews(removedMessage.id, previewUrls);
        continue;
      }
      revokeUserMessagePreviewUrls(removedMessage);
    }
    return () => {
      window.clearTimeout(timer);
    };
  }, [activeThread?.id, activeThread?.messages, handoffAttachmentPreviews, optimisticUserMessages]);

  useEffect(() => {
    composerSendScopeRef.current += 1;
    sendInFlightRef.current = false;
    setOptimisticUserMessages((existing) => {
      for (const message of existing) {
        revokeUserMessagePreviewUrls(message);
      }
      return [];
    });
    resetLocalDispatch();
    setExpandedImage(null);
  }, [activeThreadKey, draftId, resetLocalDispatch, threadId]);

  const closeExpandedImage = useCallback(() => {
    setExpandedImage(null);
  }, []);

  const activeWorktreePath = activeThread?.worktreePath ?? null;
  const derivedEnvMode: DraftThreadEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath,
    hasServerThread: isServerThread,
    draftThreadEnvMode: isLocalDraftThread ? draftThread?.envMode : undefined,
  });
  const canOverrideServerThreadEnvMode = Boolean(
    isServerThread &&
    activeThread &&
    activeThread.messages.length === 0 &&
    activeThread.worktreePath === null &&
    !envLocked,
  );
  const envMode: DraftThreadEnvMode = canOverrideServerThreadEnvMode
    ? (pendingServerThreadEnvMode ?? draftThread?.envMode ?? derivedEnvMode)
    : derivedEnvMode;
  const activeThreadBranch =
    canOverrideServerThreadEnvMode && pendingServerThreadBranch !== undefined
      ? pendingServerThreadBranch
      : (activeThread?.branch ?? null);
  const startFromOrigin = isLocalDraftThread
    ? (draftThread?.startFromOrigin ?? false)
    : canOverrideServerThreadEnvMode
      ? (pendingServerThreadStartFromOriginByThreadId[activeThread?.id ?? ""] ??
        primaryServerSettings.newWorktreesStartFromOrigin)
      : false;
  const sendEnvMode = resolveSendEnvMode({
    requestedEnvMode: envMode,
    isGitRepo,
  });
  const localCheckoutBranchMismatch = useMemo(
    () =>
      isServerThread
        ? resolveLocalCheckoutBranchMismatch({
            effectiveEnvMode: envMode,
            activeWorktreePath,
            activeThreadBranch,
            currentGitBranch: gitStatusQuery.data?.refName ?? null,
          })
        : null,
    [activeThreadBranch, activeWorktreePath, envMode, gitStatusQuery.data?.refName, isServerThread],
  );
  // Settled state of the open thread, resolved exactly like the sidebar
  // partition (same shell, same capability gate, same PR auto-settle input)
  // so the banner and the sidebar row never disagree.
  const activeThreadShell = useThreadShell(isServerThread ? activeThreadRef : null);
  const autoSettleAfterDays = useClientSettings((settings) => settings.sidebarAutoSettleAfterDays);
  const activeThreadPr = resolveThreadPr({
    threadBranch: activeThread?.branch ?? null,
    gitStatus: gitStatusQuery.data ?? null,
  });
  const supportsSettlement = serverConfig?.environment.capabilities.threadSettlement === true;
  const supportsSnooze = serverConfig?.environment.capabilities.threadSnooze === true;
  const nowMinute = useNowMinute();
  const activeThreadSnoozed =
    activeThreadShell !== null &&
    supportsSnooze &&
    effectiveSnoozed(activeThreadShell, { now: new Date().toISOString() });
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);
  useEffect(() => {
    void snoozeWakeTick;
    if (!activeThreadSnoozed) return;
    const wakeAtMs = Date.parse(activeThreadShell?.snoozedUntil ?? "");
    if (!Number.isFinite(wakeAtMs)) return;
    const id = window.setTimeout(
      () => bumpSnoozeWakeTick((tick) => tick + 1),
      Math.min(Math.max(0, wakeAtMs - Date.now()) + 50, 2_147_483_647),
    );
    return () => window.clearTimeout(id);
  }, [activeThreadShell?.snoozedUntil, activeThreadSnoozed, snoozeWakeTick]);
  const activeThreadSettled = useMemo(() => {
    if (activeThreadShell === null || !supportsSettlement) return false;
    return effectiveSettled(activeThreadShell, {
      now: `${nowMinute}:00.000Z`,
      autoSettleAfterDays,
      changeRequestState: activeThreadPr?.state ?? null,
    });
  }, [
    activeThreadPr?.state,
    activeThreadShell,
    autoSettleAfterDays,
    nowMinute,
    supportsSettlement,
  ]);
  const unsettleThreadMutation = useAtomCommand(threadEnvironment.unsettle, {
    reportFailure: false,
  });
  // Keyed by thread, not a boolean: the pending state must follow the thread
  // it belongs to across navigation, and a request resolving for thread A
  // must never clear (or re-enable) thread B's button.
  const [unsettlingThreadKey, setUnsettlingThreadKey] = useState<string | null>(null);
  const isUnsettling = unsettlingThreadKey !== null && unsettlingThreadKey === activeThreadKey;
  const handleUnsettleActiveThread = useCallback(async () => {
    if (!activeThreadRef) return;
    const threadKey = scopedThreadKey(activeThreadRef);
    setUnsettlingThreadKey(threadKey);
    try {
      const result = await unsettleThreadMutation({
        environmentId: activeThreadRef.environmentId,
        input: { threadId: activeThreadRef.threadId, reason: "user" },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to un-settle thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    } finally {
      setUnsettlingThreadKey((current) => (current === threadKey ? null : current));
    }
  }, [activeThreadRef, unsettleThreadMutation]);
  const unsnoozeThreadMutation = useAtomCommand(threadEnvironment.unsnooze, {
    reportFailure: false,
  });
  const [unsnoozingThreadKey, setUnsnoozingThreadKey] = useState<string | null>(null);
  const isUnsnoozing = unsnoozingThreadKey !== null && unsnoozingThreadKey === activeThreadKey;
  const handleUnsnoozeActiveThread = useCallback(async () => {
    if (!activeThreadRef) return;
    const threadKey = scopedThreadKey(activeThreadRef);
    setUnsnoozingThreadKey(threadKey);
    try {
      const result = await unsnoozeThreadMutation({
        environmentId: activeThreadRef.environmentId,
        input: { threadId: activeThreadRef.threadId, reason: "user" },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to wake thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    } finally {
      setUnsnoozingThreadKey((current) => (current === threadKey ? null : current));
    }
  }, [activeThreadRef, unsnoozeThreadMutation]);
  const [isRestoringThreadBranch, setIsRestoringThreadBranch] = useState(false);
  const [branchRestoreConfirmOpen, setBranchRestoreConfirmOpen] = useState(false);
  // Once revealed for a given mismatch, the banner stays mounted until the
  // mismatch changes or resolves, so clearing the draft doesn't flicker it.
  const [revealedBranchMismatchKey, setRevealedBranchMismatchKey] = useState<string | null>(null);
  // Dismissal lives in a module-level set (survives remounts); this tick just
  // forces a re-render so the banner leaves immediately.
  const [, setBranchMismatchDismissTick] = useState(0);
  const composerHasDraftContent = useComposerDraftStore((store) => {
    const draft = store.getComposerDraft(composerDraftTarget);
    return Boolean(
      draft &&
      (draft.prompt.trim().length > 0 ||
        draft.images.length > 0 ||
        draft.terminalContexts.length > 0 ||
        draft.elementContexts.length > 0 ||
        draft.previewAnnotations.length > 0 ||
        draft.reviewComments.length > 0),
    );
  });
  const activeBranchMismatchKey = branchMismatchKey(
    activeThread?.id ?? null,
    localCheckoutBranchMismatch,
  );
  const showBranchMismatchBanner = shouldShowBranchMismatchBanner({
    hasMismatch: localCheckoutBranchMismatch !== null,
    isDismissed: isBranchMismatchDismissedForSession(activeBranchMismatchKey),
    composerHasContent: composerHasDraftContent,
    wasShownForCurrentMismatch:
      revealedBranchMismatchKey !== null && revealedBranchMismatchKey === activeBranchMismatchKey,
  });
  useEffect(() => {
    setRevealedBranchMismatchKey((revealed) => {
      if (showBranchMismatchBanner) {
        return activeBranchMismatchKey;
      }
      // Hysteresis is scoped to an uninterrupted mismatch: reset when the
      // mismatch resolves or changes so a recurrence re-gates on intent.
      return revealed !== null && revealed !== activeBranchMismatchKey ? null : revealed;
    });
  }, [activeBranchMismatchKey, showBranchMismatchBanner]);
  const handleSwitchCheckoutToThread = useCallback(async () => {
    if (
      !activeProjectCwd ||
      !activeThread ||
      !localCheckoutBranchMismatch ||
      isRestoringThreadBranch
    ) {
      return;
    }
    setIsRestoringThreadBranch(true);
    const checkoutResult = await switchGitRef({
      environmentId,
      input: {
        cwd: activeProjectCwd,
        refName: localCheckoutBranchMismatch.threadBranch,
      },
    });
    if (checkoutResult._tag === "Failure") {
      setIsRestoringThreadBranch(false);
      if (!isAtomCommandInterrupted(checkoutResult)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to switch checkout",
            description: chatActionErrorMessage(squashAtomCommandFailure(checkoutResult)),
          }),
        );
      }
      return;
    }

    const nextBranch = checkoutResult.value.refName ?? localCheckoutBranchMismatch.threadBranch;
    if (nextBranch !== activeThread.branch) {
      const updateResult = await updateThreadMetadata({
        environmentId,
        input: { threadId: activeThread.id, branch: nextBranch, worktreePath: null },
      });
      if (updateResult._tag === "Failure") {
        setIsRestoringThreadBranch(false);
        if (!isAtomCommandInterrupted(updateResult)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Checkout switched, but the thread could not be updated",
              description: chatActionErrorMessage(squashAtomCommandFailure(updateResult)),
            }),
          );
        }
        gitStatusQuery.refresh();
        return;
      }
    }
    gitStatusQuery.refresh();
    setIsRestoringThreadBranch(false);
    scheduleComposerFocus();
  }, [
    activeProjectCwd,
    activeThread,
    environmentId,
    gitStatusQuery,
    isRestoringThreadBranch,
    localCheckoutBranchMismatch,
    scheduleComposerFocus,
    switchGitRef,
    updateThreadMetadata,
  ]);
  // The stack renders items[0] front-most and tucks the rest behind hover, so
  // ordering is priority: system banners, then the branch-mismatch notice,
  // and the informational parked-thread banner last — it must never cover another.
  const parkedThreadBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    if (!activeThreadSnoozed && !activeThreadSettled) {
      return null;
    }
    const isSnoozed = activeThreadSnoozed;
    return {
      id: `thread-${isSnoozed ? "snoozed" : "settled"}:${activeThread?.id ?? "unknown"}`,
      variant: "info",
      icon: isSnoozed ? <AlarmClockIcon /> : <CheckCircle2Icon />,
      title: `This thread is ${isSnoozed ? "snoozed" : "settled"}`,
      description: isSnoozed
        ? "Sending a message wakes it and moves it back to Active in the sidebar."
        : "Sending a message moves it back to Active in the sidebar.",
      actions: (
        <Button
          size="xs"
          variant="outline"
          disabled={isSnoozed ? isUnsnoozing : isUnsettling}
          onClick={() =>
            void (isSnoozed ? handleUnsnoozeActiveThread() : handleUnsettleActiveThread())
          }
        >
          {isSnoozed
            ? isUnsnoozing
              ? "Waking..."
              : "Wake now"
            : isUnsettling
              ? "Un-settling..."
              : "Un-settle"}
        </Button>
      ),
    };
  }, [
    activeThread?.id,
    activeThreadSettled,
    activeThreadSnoozed,
    handleUnsnoozeActiveThread,
    handleUnsettleActiveThread,
    isUnsnoozing,
    isUnsettling,
  ]);
  const handleRestoreThreadBranch = useCallback(() => {
    if (gitStatusQuery.data?.hasWorkingTreeChanges) {
      setBranchRestoreConfirmOpen(true);
      return;
    }
    void handleSwitchCheckoutToThread();
  }, [gitStatusQuery.data?.hasWorkingTreeChanges, handleSwitchCheckoutToThread]);
  const composerBannerItems = useMemo<ComposerBannerStackItem[]>(() => {
    const parkedThreadItems = parkedThreadBannerItem === null ? [] : [parkedThreadBannerItem];
    if (!localCheckoutBranchMismatch || !showBranchMismatchBanner || !activeBranchMismatchKey) {
      return [...systemComposerBannerItems, ...parkedThreadItems];
    }
    return [
      ...systemComposerBannerItems,
      {
        id: `branch-mismatch:${activeBranchMismatchKey}`,
        variant: "info",
        icon: <GitBranchIcon />,
        title: (
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0 font-normal text-muted-foreground">Branch changed — was</span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <code className="min-w-0 truncate font-medium text-foreground">
                    {localCheckoutBranchMismatch.threadBranch}
                  </code>
                }
              />
              <TooltipPopup side="top" className="max-w-80">
                This thread last ran on {localCheckoutBranchMismatch.threadBranch}. Sending will
                continue on {localCheckoutBranchMismatch.currentBranch}.
              </TooltipPopup>
            </Tooltip>
          </span>
        ),
        className: "dark:shadow-none",
        actions: (
          <Button
            size="xs"
            variant="ghost"
            disabled={isRestoringThreadBranch}
            onClick={handleRestoreThreadBranch}
          >
            {isRestoringThreadBranch ? "Restoring..." : "Restore branch"}
          </Button>
        ),
        dismissLabel: "Dismiss branch change notice",
        onDismiss: () => {
          dismissBranchMismatchForSession(activeBranchMismatchKey);
          setBranchMismatchDismissTick((tick) => tick + 1);
        },
      },
      ...parkedThreadItems,
    ];
  }, [
    activeBranchMismatchKey,
    handleRestoreThreadBranch,
    isRestoringThreadBranch,
    localCheckoutBranchMismatch,
    parkedThreadBannerItem,
    showBranchMismatchBanner,
    systemComposerBannerItems,
  ]);

  useEffect(() => {
    setPendingServerThreadEnvMode(null);
    setPendingServerThreadBranch(undefined);
  }, [activeThread?.id]);

  useEffect(() => {
    if (canOverrideServerThreadEnvMode) {
      return;
    }
    setPendingServerThreadEnvMode(null);
    setPendingServerThreadBranch(undefined);
  }, [canOverrideServerThreadEnvMode]);

  useEffect(() => {
    if (!activeThreadId) {
      setTerminalUiLaunchContext(null);
      return;
    }
    setTerminalUiLaunchContext((current) => {
      if (!current) return current;
      if (current.threadId === activeThreadId) return current;
      return null;
    });
  }, [activeThreadId]);

  useEffect(() => {
    if (!activeThreadId || !activeProjectCwd) {
      return;
    }
    setTerminalUiLaunchContext((current) => {
      if (!current || current.threadId !== activeThreadId) {
        return current;
      }
      const settledCwd = projectScriptCwd({
        project: { cwd: activeProjectCwd },
        worktreePath: activeThreadWorktreePath,
      });
      if (
        settledCwd === current.cwd &&
        (activeThreadWorktreePath ?? null) === current.worktreePath
      ) {
        return null;
      }
      return current;
    });
  }, [activeProjectCwd, activeThreadId, activeThreadWorktreePath]);

  useEffect(() => {
    if (terminalMainSurfaceActive) {
      return;
    }
    setTerminalUiLaunchContext((current) =>
      current?.threadId === activeThreadId ? null : current,
    );
  }, [activeThreadId, terminalMainSurfaceActive]);

  useEffect(() => {
    if (!activeThreadKey) return;
    const previous = terminalUiOpenByThreadRef.current[activeThreadKey] ?? false;
    const current = terminalMainSurfaceActive;

    if (!previous && current) {
      terminalUiOpenByThreadRef.current[activeThreadKey] = current;
      setTerminalFocusRequestId((value) => value + 1);
      return;
    } else if (previous && !current) {
      terminalUiOpenByThreadRef.current[activeThreadKey] = current;
      const frame = window.requestAnimationFrame(() => {
        focusComposer();
      });
      return () => {
        window.cancelAnimationFrame(frame);
      };
    }

    terminalUiOpenByThreadRef.current[activeThreadKey] = current;
  }, [activeThreadKey, focusComposer, terminalMainSurfaceActive]);

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (
        embeddedSideChat &&
        (!document.activeElement || !chatViewRootRef.current?.contains(document.activeElement))
      ) {
        return;
      }
      if (!activeThreadId || isCommandPaletteOpen()) {
        return;
      }
      const terminalFocusOwner = getTerminalFocusOwner();
      if (event.defaultPrevented && terminalFocusOwner === null) {
        return;
      }
      const shortcutContext = {
        terminalFocus: terminalFocusOwner !== null,
        terminalOpen: terminalMainSurfaceActive,
        modelPickerOpen: composerRef.current?.isModelPickerOpen() ?? false,
      };

      if (
        !shortcutContext.terminalFocus &&
        !shortcutContext.modelPickerOpen &&
        shouldTypeToFocusComposer(event)
      ) {
        if (composerRef.current?.insertTextAtEnd(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }

      const command = resolveShortcutCommand(event, keybindings, {
        context: shortcutContext,
      });
      if (!command) return;

      if (command === "terminal.toggle") {
        event.preventDefault();
        event.stopPropagation();
        if (agentSurfaces) {
          if (rightPanelOpen && activeRightPanelSurface?.kind === "terminal") {
            closePreviewPanel();
          } else {
            const terminal = rightPanelState.surfaces.find(
              (surface) => surface.kind === "terminal",
            );
            if (terminal) activateRightPanelSurface(terminal);
            else addTerminalSurface();
          }
          return;
        }
        handleMainSurfaceChange(terminalMainSurfaceActive ? "chat" : "terminal");
        return;
      }

      if (command === "rightPanel.toggle") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalMainSurfaceActive) {
          toggleRightPanel();
        }
        return;
      }

      if (command === "terminal.split") {
        event.preventDefault();
        event.stopPropagation();
        if (terminalFocusOwner === "right-panel" || agentSurfaces) {
          // The panel is one terminal per tab, so there is nothing to split
          // into: the shortcut opens another terminal instead of dying quietly.
          // The terminals view below still splits.
          addTerminalSurface();
          return;
        }
        showTerminalSurface();
        splitTerminal();
        return;
      }

      if (command === "terminal.splitVertical") {
        event.preventDefault();
        event.stopPropagation();
        if (terminalFocusOwner === "right-panel" || agentSurfaces) {
          addTerminalSurface();
          return;
        }
        showTerminalSurface();
        splitTerminal("vertical");
        return;
      }

      if (command === "terminal.close") {
        event.preventDefault();
        event.stopPropagation();
        if (terminalFocusOwner === "right-panel" && activeRightPanelSurface?.kind === "terminal") {
          closePanelTerminal(activeRightPanelSurface.activeTerminalId);
          return;
        }
        if (!terminalMainSurfaceActive) return;
        closeTerminal(terminalUiState.activeTerminalId);
        return;
      }

      if (command === "terminal.new") {
        event.preventDefault();
        event.stopPropagation();
        if (terminalFocusOwner === "right-panel" || agentSurfaces) {
          addTerminalSurface();
          return;
        }
        showTerminalSurface();
        createNewTerminal();
        return;
      }

      if (command === "diff.toggle") {
        event.preventDefault();
        event.stopPropagation();
        onToggleDiff();
        return;
      }

      if (command === "modelPicker.toggle") {
        event.preventDefault();
        event.stopPropagation();
        composerRef.current?.toggleModelPicker();
        return;
      }

      const scriptId = projectScriptIdFromCommand(command);
      if (!scriptId || !activeProject) return;
      const script = visibleProjectScripts.find((entry) => entry.id === scriptId);
      if (!script) return;
      event.preventDefault();
      event.stopPropagation();
      void runProjectScript(script);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [
    activeProject,
    visibleProjectScripts,
    activeRightPanelSurface,
    activateRightPanelSurface,
    agentSurfaces,
    rightPanelOpen,
    rightPanelState.surfaces,
    closePreviewPanel,
    addTerminalSurface,
    terminalUiState.activeTerminalId,
    activeThreadId,
    closeTerminal,
    closePanelTerminal,
    createNewTerminal,
    handleMainSurfaceChange,
    showTerminalSurface,
    runProjectScript,
    splitTerminal,
    keybindings,
    onToggleDiff,
    toggleRightPanel,
    terminalMainSurfaceActive,
    composerRef,
    embeddedSideChat,
  ]);

  const onRevertToTurnCount = useCallback(
    async (turnCount: number) => {
      const localApi = readLocalApi();
      if (!localApi || !activeThread || isRevertingCheckpoint) return;

      if (activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel) {
        setThreadError(
          activeThread.id,
          `Reconnect ${activeEnvironmentUnavailableLabel} before reverting checkpoints.`,
        );
        return;
      }
      if (phase === "running" || isSendBusy || isConnecting) {
        setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
        return;
      }
      const confirmed = await localApi.dialogs.confirm(
        [
          `Revert this thread to checkpoint ${turnCount}?`,
          "This will discard newer messages and turn diffs in this thread.",
          "This action cannot be undone.",
        ].join("\n"),
      );
      if (!confirmed) {
        return;
      }

      setIsRevertingCheckpoint(true);
      setThreadError(activeThread.id, null);
      const result = await revertThreadCheckpoint({
        environmentId,
        input: {
          threadId: activeThread.id,
          turnCount,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThread.id,
          error instanceof Error ? error.message : "Failed to revert thread state.",
        );
      }
      setIsRevertingCheckpoint(false);
    },
    [
      activeThread,
      activeEnvironmentUnavailable,
      activeEnvironmentUnavailableLabel,
      environmentId,
      isConnecting,
      isRevertingCheckpoint,
      isSendBusy,
      phase,
      revertThreadCheckpoint,
      setThreadError,
    ],
  );

  const promoteNextQueuedGrokMessage = useCallback(async () => {
    if (!activeThread || !activeThreadKey) return false;
    const nextMessageId = nextQueuedMessageToPromote({
      queuedMessageIds: queuedGrokMessageIdsRef.current,
      deliveredMessageIds: deliveredMessageIdsRef.current,
      promotionInFlight: queuedMessagePromotionPhasesRef.current[activeThreadKey] !== undefined,
      awaitingDeliveryMessageIds: awaitingQueuedDeliveryIdsRef.current,
    });
    if (nextMessageId === null) return false;

    awaitingQueuedDeliveryIdsRef.current = [nextMessageId];
    setQueuedGrokDrainActive(true);
    const threadIdForPromotion = activeThread.id;
    const requestId = newCommandId();

    return runQueuedMessagePromotion({
      phasesRef: queuedMessagePromotionPhasesRef,
      setPhases: setQueuedMessagePromotionPhases,
      threadKey: activeThreadKey,
      messageIds: [nextMessageId],
      requestId,
      promote: async () => {
        const result = await promoteQueuedThreadTurns({
          environmentId,
          input: {
            commandId: requestId,
            threadId: threadIdForPromotion,
            messageIds: [MessageId.make(nextMessageId)],
          },
        });
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) return false;
          throw squashAtomCommandFailure(result);
        }
        return true;
      },
      onStart: () => setThreadError(threadIdForPromotion, null),
      onSuccess: () => setThreadError(threadIdForPromotion, null),
      onError: (error) => {
        setQueuedGrokDrainActive(false);
        awaitingQueuedDeliveryIdsRef.current = [];
        setThreadError(
          threadIdForPromotion,
          error instanceof Error ? error.message : "Failed to send the queued Grok messages now.",
        );
      },
    });
  }, [activeThread, activeThreadKey, environmentId, promoteQueuedThreadTurns, setThreadError]);

  const promoteQueuedMessagesNow = useCallback(async () => {
    if (!activeThread || !activeThreadKey || !hasQueuedGrokMessages) return false;
    setQueuedGrokDrainActive(true);
    return promoteNextQueuedGrokMessage();
  }, [activeThread, activeThreadKey, hasQueuedGrokMessages, promoteNextQueuedGrokMessage]);

  useEffect(() => {
    awaitingQueuedDeliveryIdsRef.current = awaitingQueuedDeliveryIdsRef.current.filter(
      (messageId) => !deliveredMessageIds.has(messageId),
    );
    if (!hasQueuedGrokMessages && awaitingQueuedDeliveryIdsRef.current.length === 0) {
      if (queuedGrokDrainActive) setQueuedGrokDrainActive(false);
      return;
    }
    if (!activeThreadKey) return;

    const nextMessageId = nextQueuedMessageToPromote({
      queuedMessageIds: queuedGrokMessageIds,
      deliveredMessageIds,
      promotionInFlight: queuedMessagePromotionInFlight,
      awaitingDeliveryMessageIds: awaitingQueuedDeliveryIdsRef.current,
    });
    if (nextMessageId === null) return;

    const delayMs = queuedMessageAutoPromoteDelayMs(queuedGrokDrainActive);
    const timer = window.setTimeout(() => {
      void promoteNextQueuedGrokMessage();
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [
    activeThreadKey,
    deliveredMessageIds,
    hasQueuedGrokMessages,
    promoteNextQueuedGrokMessage,
    queuedGrokDrainActive,
    queuedGrokMessageIds,
    queuedMessagePromotionInFlight,
  ]);

  const onSend = async (
    e?: { preventDefault: () => void },
    inputOrigin?: OrchestrationMessageInputOrigin,
    sendOptions?: { readonly sendNow?: boolean },
  ) => {
    e?.preventDefault();
    if (
      !activeThread ||
      activeProviderAuthenticationPaused ||
      isSendBusy ||
      isConnecting ||
      (activeEnvironmentUnavailable && !canQueueLocalMessage) ||
      sendInFlightRef.current
    ) {
      // Never a dead button: if the send cannot go, either hold it until the
      // blocker clears or say why. Reported from mobile Safari as pressing
      // send and nothing happening at all, which took force-quitting the
      // browser to escape.
      const blocked = resolveBlockedSend({
        hasThread: activeThread !== null && activeThread !== undefined,
        sendInFlight: isSendBusy || sendInFlightRef.current,
        providerAuthenticationPaused: activeProviderAuthenticationPaused,
        connecting: isConnecting,
        threadCatchingUp,
        environmentUnavailable: activeEnvironmentUnavailable,
        canQueueLocalMessage,
        environmentLabel: activeEnvironmentUnavailableLabel,
      });
      if (blocked.kind === "queue") {
        // Keep what they typed exactly where it is; the flush effect resends
        // this very call once the wait ends.
        deferredSendOriginRef.current = { origin: inputOrigin, threadKey: activeThreadKey };
        toastManager.add(
          stackedThreadToast({
            type: "info",
            title: "Message queued",
            description: blocked.message,
            priority: "high",
          }),
        );
      } else if (blocked.kind === "explain") {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Message not sent",
            description: blocked.message,
            priority: "high",
          }),
        );
      }
      return;
    }
    if (activePendingProgress) {
      if (readyVoiceTranscriptionTask) {
        dismissVoiceTranscriptionResult(readyVoiceTranscriptionTask.id);
      }
      onAdvanceActivePendingUserInput();
      return;
    }
    const sendCtx = composerRef.current?.getSendContext();
    if (!sendCtx?.providerAvailable) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Message not sent",
          description: "No model is available for this conversation right now.",
          priority: "high",
        }),
      );
      return;
    }
    if (readyVoiceTranscriptionTask) {
      dismissVoiceTranscriptionResult(readyVoiceTranscriptionTask.id);
    }
    const composerIsEmpty =
      promptRef.current.trim().length === 0 &&
      sendCtx.images.length === 0 &&
      sendCtx.terminalContexts.length === 0 &&
      sendCtx.elementContexts.length === 0 &&
      sendCtx.previewAnnotations.length === 0 &&
      sendCtx.reviewComments.length === 0;
    if (composerIsEmpty && hasQueuedGrokMessages) {
      await promoteQueuedMessagesNow();
      return;
    }
    const {
      images: composerImages,
      terminalContexts: composerTerminalContexts,
      elementContexts: composerElementContexts,
      previewAnnotations: composerPreviewAnnotations,
      reviewComments: composerReviewComments,
      selectedProvider: ctxSelectedProvider,
      selectedModel: ctxSelectedModel,
      selectedProviderModels: ctxSelectedProviderModels,
      selectedPromptEffort: ctxSelectedPromptEffort,
      selectedModelSelection: ctxSelectedModelSelection,
    } = sendCtx;
    const promptForSend = promptRef.current;
    const sendScope = composerSendScopeRef.current;
    const ownsComposer = () =>
      chatViewMountedRef.current &&
      activeThreadKeyRef.current === activeThreadKey &&
      composerSendScopeRef.current === sendScope;
    const sentContent = {
      prompt: promptForSend,
      images: composerImages,
      terminalContexts: composerTerminalContexts,
      elementContexts: composerElementContexts,
      previewAnnotations: composerPreviewAnnotations,
      reviewComments: composerReviewComments,
    };
    const releaseSavedDraft = () => {
      const currentDraft = useComposerDraftStore.getState().getComposerDraft(composerDraftTarget);
      if (!composerDraftMatchesSend(currentDraft, sentContent)) return;
      clearComposerDraftContent(composerDraftTarget);
      if (ownsComposer() && promptRef.current === promptForSend) {
        promptRef.current = "";
        composerRef.current?.resetCursorState();
      }
    };
    const {
      trimmedPrompt: trimmed,
      sendableTerminalContexts: sendableComposerTerminalContexts,
      expiredTerminalContextCount,
      hasSendableContent,
    } = deriveComposerSendState({
      prompt: promptForSend,
      imageCount: composerImages.length,
      terminalContexts: composerTerminalContexts,
      elementContextCount:
        composerElementContexts.length +
        composerPreviewAnnotations.length +
        composerReviewComments.length,
    });
    if (showPlanFollowUpPrompt && activeProposedPlan) {
      const followUp = resolvePlanFollowUpSubmission({
        draftText: trimmed,
        planMarkdown: activeProposedPlan.planMarkdown,
      });
      const saved = await onSubmitPlanFollowUp({
        text: followUp.text,
        interactionMode: followUp.interactionMode,
      });
      if (saved) releaseSavedDraft();
      return;
    }
    const standaloneSlashCommand =
      composerImages.length === 0 &&
      sendableComposerTerminalContexts.length === 0 &&
      composerElementContexts.length === 0 &&
      composerPreviewAnnotations.length === 0 &&
      composerReviewComments.length === 0
        ? parseStandaloneComposerSlashCommand(trimmed)
        : null;
    if (standaloneSlashCommand) {
      if (standaloneSlashCommand === "refresh-plan") {
        // Acts exactly like pressing the refresh button: no message is sent and
        // the turn is untouched. Must be handled before the mode change below,
        // which would otherwise be given a value that is not an interaction
        // mode at all.
        const threadId = activeThread?.id;
        if (threadId) {
          void refreshThreadPlanCommand({ environmentId, input: { threadId } });
        }
      } else {
        handleInteractionModeChange(standaloneSlashCommand);
      }
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      return;
    }
    if (!hasSendableContent) {
      if (expiredTerminalContextCount > 0) {
        const toastCopy = buildExpiredTerminalContextToastCopy(
          expiredTerminalContextCount,
          "empty",
        );
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: toastCopy.title,
            description: toastCopy.description,
          }),
        );
      }
      return;
    }
    if (!activeProject) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Choose a project first",
          description: "This draft no longer points to an available project.",
        }),
      );
      return;
    }
    const threadIdForSend = activeThread.id;
    const isFirstMessage = !isServerThread || activeThread.messages.length === 0;
    const baseBranchForWorktree =
      isFirstMessage && sendEnvMode === "worktree" && !activeThread.worktreePath
        ? activeThreadBranch
        : null;

    // In worktree mode, require an explicit base branch so we don't silently
    // fall back to local execution when branch selection is missing.
    const shouldCreateWorktree =
      isFirstMessage && sendEnvMode === "worktree" && !activeThread.worktreePath;
    if (shouldCreateWorktree && !activeThreadBranch) {
      setThreadError(threadIdForSend, "Select a base branch before sending in New worktree mode.");
      return;
    }

    if (
      activeThreadKey !== null &&
      isServerThread &&
      shouldHoldComposerSend({
        backgroundTasksRunning:
          usageGuardPaused || hasRunningBackgroundTask || threadHeldMessages.length > 0,
        hasSendableContent,
        sendNow: sendOptions?.sendNow === true,
      })
    ) {
      const images = composerImages.map(cloneComposerImageForRetry);
      const terminals = [...sendableComposerTerminalContexts];
      const elements = [...composerElementContexts];
      const annotations = [...composerPreviewAnnotations];
      const reviews = [...composerReviewComments];
      const answeredRequest = getWaitingOnYouAttachment(activeThreadKey);
      const contextText = appendReviewCommentsToPrompt(
        annotations.reduce(
          (text, annotation) => appendPreviewAnnotationPrompt(text, annotation),
          appendElementContextsToPrompt(
            appendTerminalContextsToPrompt(promptForSend, terminals),
            elements,
          ),
        ),
        reviews,
      );
      const outgoingText = formatOutgoingPrompt({
        provider: ctxSelectedProvider,
        model: ctxSelectedModel,
        models: ctxSelectedProviderModels,
        effort: ctxSelectedPromptEffort,
        text:
          (answeredRequest
            ? prependWaitingOnYouReply(contextText, answeredRequest.title)
            : contextText) ||
          (images.some((attachment) => attachment.type === "audio")
            ? "[Voice note attached]"
            : IMAGE_ONLY_BOOTSTRAP_PROMPT),
      });
      const messageId = MessageId.make(`${HELD_MESSAGE_PREFIX}${newMessageId()}`);
      sendInFlightRef.current = true;
      beginLocalDispatch({ preparingWorktree: false });
      try {
        const attachments = await prepareComposerAttachmentsForSend(images);
        const result = await startThreadTurn({
          environmentId,
          input: {
            commandId: CommandId.make(`queue:${messageId}`),
            threadId: threadIdForSend,
            ...(answeredRequest
              ? {
                  afterReply: {
                    vmAgentId: answeredRequest.vmAgentId,
                    blockerId: answeredRequest.blockerId,
                    answeredInChat: true,
                  },
                }
              : {}),
            message: {
              messageId,
              role: "user",
              text: outgoingText,
              ...(inputOrigin !== undefined ? { inputOrigin } : {}),
              attachments,
            },
            modelSelection: ctxSelectedModelSelection,
            runtimeMode,
            interactionMode,
            createdAt: new Date().toISOString(),
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      } catch (error) {
        setThreadError(
          threadIdForSend,
          error instanceof Error
            ? error.message
            : "Could not save queued message. Your draft is unchanged.",
        );
        return;
      } finally {
        if (ownsComposer()) {
          sendInFlightRef.current = false;
          resetLocalDispatch();
        }
        for (const image of images) revokeBlobPreviewUrl(image.previewUrl);
      }
      if (answeredRequest) detachWaitingOnYou(activeThreadKey);
      releaseSavedDraft();
      return;
    }
    let interruptedTaskTitles: ReadonlyArray<string> = [];
    if (sendWouldStopBackgroundTasks) {
      if (!confirmDestructiveSend(describeSendOverRunningTasks(runningBackgroundTasks.length)))
        return;
      interruptedTaskTitles = runningBackgroundTasks.map(
        (task) => task.title || task.taskType || "Background task",
      );
      for (const task of runningBackgroundTasks) onStopProviderTask(task.taskId);
    }

    sendInFlightRef.current = true;
    const shouldBootstrapCreateThread = isLocalDraftThread && !isServerThread;
    if (isDraftHeroState && activeThreadKey) {
      let resolveDockStarted: (() => void) | undefined;
      const dockStarted = new Promise<void>((resolve) => {
        resolveDockStarted = resolve;
      });
      const dockTransition = runMobileComposerTransition(() => {
        flushSync(() => {
          captureDraftHeroComposerRect();
          setDockedDraftHeroThreadKey(activeThreadKey);
        });
        resolveDockStarted?.();
      });
      void dockTransition.catch(() => resolveDockStarted?.());
      await dockStarted;
    }
    if (ownsComposer()) beginLocalDispatch({ preparingWorktree: Boolean(baseBranchForWorktree) });

    const composerImagesSnapshot = [...composerImages];
    const composerTerminalContextsSnapshot = [...sendableComposerTerminalContexts];
    const composerElementContextsSnapshot = [...composerElementContexts];
    const composerPreviewAnnotationsSnapshot = [...composerPreviewAnnotations];
    const composerReviewCommentsSnapshot: ReviewCommentContext[] = [...composerReviewComments];
    const messageTextWithContexts = appendElementContextsToPrompt(
      appendTerminalContextsToPrompt(promptForSend, composerTerminalContextsSnapshot),
      composerElementContextsSnapshot,
    );
    const messageTextWithPreviewAnnotations = composerPreviewAnnotationsSnapshot.reduce(
      (text, annotation) => appendPreviewAnnotationPrompt(text, annotation),
      messageTextWithContexts,
    );
    const messageTextWithReviewComments = appendReviewCommentsToPrompt(
      messageTextWithPreviewAnnotations,
      composerReviewCommentsSnapshot,
    );
    // Appended last, so the render path can strip it before the blocks that
    // must be trailing to parse — see deriveDisplayedUserMessageState.
    const messageTextWithInterruptedTasks = appendInterruptedTasksNotice(
      messageTextWithReviewComments,
      interruptedTaskTitles,
    );
    // Captured here rather than re-read once the turn starts: this message
    // quotes the request, so it answers it even if the user takes the tag off
    // while the send is still in flight.
    const answeredRequest =
      activeThreadKey === null ? null : getWaitingOnYouAttachment(activeThreadKey);
    const messageTextForSend =
      answeredRequest === null
        ? messageTextWithInterruptedTasks
        : prependWaitingOnYouReply(messageTextWithInterruptedTasks, answeredRequest.title);
    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    const outgoingMessageText = formatOutgoingPrompt({
      provider: ctxSelectedProvider,
      model: ctxSelectedModel,
      models: ctxSelectedProviderModels,
      effort: ctxSelectedPromptEffort,
      text:
        messageTextForSend ||
        (composerImagesSnapshot.some((attachment) => attachment.type === "audio")
          ? "[Voice note attached]"
          : IMAGE_ONLY_BOOTSTRAP_PROMPT),
    });
    const turnAttachmentsPromise = prepareComposerAttachmentsForSend(composerImagesSnapshot);
    prepareTimelineForSend(messageIdForSend);
    setThreadError(threadIdForSend, null);
    // Keep the draft (including its files) until the outbox transaction commits.

    let firstComposerImageName: string | null = null;
    if (composerImagesSnapshot.length > 0) {
      const firstComposerImage = composerImagesSnapshot[0];
      if (firstComposerImage) {
        firstComposerImageName = firstComposerImage.name;
      }
    }
    let titleSeed = trimmed;
    if (!titleSeed) {
      if (firstComposerImageName) {
        titleSeed = `Image: ${firstComposerImageName}`;
      } else if (composerTerminalContextsSnapshot.length > 0) {
        titleSeed = formatTerminalContextLabel(composerTerminalContextsSnapshot[0]!);
      } else if (composerElementContextsSnapshot.length > 0) {
        titleSeed = formatElementContextLabel(composerElementContextsSnapshot[0]!);
      } else {
        titleSeed = "New thread";
      }
    }
    const title = truncate(titleSeed);
    const threadCreateModelSelection = createModelSelection(
      ctxSelectedModelSelection.instanceId,
      ctxSelectedModel || activeProject.defaultModelSelection?.model || DEFAULT_MODEL,
      ctxSelectedModelSelection.options,
    );

    let failure: AtomCommandResult<unknown, unknown> | null = null;
    const turnAttachmentsResult = await settlePromise(() => turnAttachmentsPromise);
    if (failure === null && turnAttachmentsResult._tag === "Failure") {
      failure = turnAttachmentsResult;
    }

    let turnStartSucceeded = false;
    if (failure === null && turnAttachmentsResult._tag === "Success") {
      const bootstrap =
        shouldBootstrapCreateThread || baseBranchForWorktree
          ? {
              ...(shouldBootstrapCreateThread
                ? {
                    createThread: {
                      projectId: activeProject.id,
                      title,
                      modelSelection: threadCreateModelSelection,
                      runtimeMode,
                      interactionMode,
                      branch: activeThreadBranch,
                      worktreePath: activeThread.worktreePath,
                      createdAt: activeThread.createdAt,
                    },
                  }
                : {}),
              ...(baseBranchForWorktree
                ? {
                    prepareWorktree: {
                      projectCwd: activeProject.workspaceRoot,
                      baseBranch: baseBranchForWorktree,
                      branch: buildTemporaryWorktreeBranchName(randomHex),
                      ...(startFromOrigin ? { startFromOrigin: true } : {}),
                    },
                    runSetupScript: true,
                  }
                : {}),
            }
          : undefined;
      if (ownsComposer()) beginLocalDispatch({ preparingWorktree: false });
      const startResult = await startThreadTurn({
        environmentId,
        input: {
          threadId: threadIdForSend,
          ...(answeredRequest
            ? {
                afterReply: {
                  vmAgentId: answeredRequest.vmAgentId,
                  blockerId: answeredRequest.blockerId,
                  answeredInChat: true,
                },
              }
            : {}),
          message: {
            messageId: messageIdForSend,
            role: "user",
            text: outgoingMessageText,
            ...(inputOrigin !== undefined ? { inputOrigin } : {}),
            attachments: turnAttachmentsResult.value,
          },
          modelSelection: ctxSelectedModelSelection,
          titleSeed: title,
          ...(isServerThread
            ? {
                metadata: {
                  ...(isFirstMessage ? { title } : {}),
                  ...(localCheckoutBranchMismatch
                    ? { branch: localCheckoutBranchMismatch.currentBranch, worktreePath: null }
                    : {}),
                },
              }
            : {}),
          runtimeMode,
          interactionMode,
          ...(bootstrap ? { bootstrap } : {}),
          createdAt: messageCreatedAt,
        },
      });
      if (startResult._tag === "Failure") {
        failure = startResult;
      } else {
        turnStartSucceeded = true;
      }
    }

    if (failure !== null) {
      const error = squashAtomCommandFailure(failure);
      setThreadError(
        threadIdForSend,
        error instanceof Error
          ? error.message
          : "Could not save message. Your draft is still here.",
      );
    } else if (turnStartSucceeded) {
      releaseSavedDraft();
      if (answeredRequest && activeThreadKey) detachWaitingOnYou(activeThreadKey);
    }
    if (ownsComposer()) {
      sendInFlightRef.current = false;
      resetLocalDispatch();
      if (!turnStartSucceeded) {
        setDockedDraftHeroThreadKey((currentThreadKey) =>
          currentThreadKey === activeThreadKey ? null : currentThreadKey,
        );
      }
    }
  };

  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  // Reports whether the send actually started. The caller closes the
  // "Transcription ready" card on the strength of that: closing over a send
  // that silently returned early would drop the user's words with no trace.
  const sendAwayVoiceTranscriptRef = useRef<
    (transcript: string, target?: ScopedThreadRef | DraftId) => boolean
  >(() => false);
  // `target` pins the send to the conversation the recording belongs to.
  // This ref is reassigned on every render, so a transcript offered for a
  // thread the user has since navigated away from would otherwise resolve
  // `activeThread` at CLICK time and post into whatever chat is focused now.
  sendAwayVoiceTranscriptRef.current = (transcript, target) => {
    if (!activeThread || !isServerThread) return false;
    const draftTarget = target ?? composerDraftTarget;
    const draftStore = useComposerDraftStore.getState();
    const draft = draftStore.getComposerDraft(draftTarget);
    const prompt = draft?.prompt?.trim() || transcript.trim();
    if (prompt.length === 0) return false;
    // Screenshots the user dropped in the composer belong to this message. The
    // away-send used to post the transcript with `attachments: []`, silently
    // leaving them behind in the draft.
    const draftImages = [...(draft?.images ?? [])];
    const threadIdForSend =
      typeof draftTarget === "string" ? activeThread.id : draftTarget.threadId;
    const createdAt = new Date().toISOString();
    const modelSelection = activeThread.modelSelection;
    const runtimeModeForSend = activeThread.runtimeMode;
    const interactionModeForSend = activeThread.interactionMode;
    if (readyVoiceTranscriptionTask) {
      dismissVoiceTranscriptionResult(readyVoiceTranscriptionTask.id);
    }
    void prepareComposerAttachmentsForSend(draftImages)
      // A screenshot that will not encode must not cost the user their words.
      .catch(() => [] as ReadonlyArray<never>)
      .then((attachments) =>
        startThreadTurn({
          environmentId,
          input: {
            threadId: threadIdForSend,
            message: {
              messageId: newMessageId(),
              role: "user",
              text: prompt,
              inputOrigin: "transcription",
              attachments,
            },
            modelSelection,
            runtimeMode: runtimeModeForSend,
            interactionMode: interactionModeForSend,
            createdAt,
          },
        }),
      )
      .then((result) => {
        if (result._tag === "Success") {
          const current = useComposerDraftStore.getState().getComposerDraft(draftTarget);
          if (draft && composerDraftMatchesSend(current, draft))
            clearComposerDraftContent(draftTarget);
          return;
        }
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not send transcription",
            description: error instanceof Error ? error.message : "Failed to send the transcript.",
          }),
        );
      });
    return true;
  };
  // Walking back into the conversation retires its "Transcription ready" card.
  // The transcript is already restored into the composer in front of them, so
  // leaving a live Send button up is just a second way to post the same words.
  useEffect(() => {
    if (activeThreadKey === null) return;
    const toastId = takePendingTranscriptionToast(activeThreadKey);
    if (toastId !== null) toastManager.close(toastId);
  }, [activeThreadKey]);

  // Flushes a send the user made while the conversation was still catching up.
  // Their text never left the composer, so replaying the call sends exactly
  // what they wrote — and if they kept editing in the meantime, it sends the
  // edited version, which is what someone who kept typing would expect.
  useEffect(() => {
    if (deferredSendOriginRef.current === null) return;
    if (threadCatchingUp || isConnecting || isSendBusy || sendInFlightRef.current) return;
    const deferred = deferredSendOriginRef.current;
    // Navigating away while the wait was still running means the text they
    // queued belongs to a conversation they left. Drop it rather than post it
    // into whatever thread happens to be open now.
    if (deferred.threadKey !== activeThreadKey) {
      deferredSendOriginRef.current = null;
      return;
    }
    deferredSendOriginRef.current = null;
    void onSendRef.current(undefined, deferred.origin);
  }, [activeThreadKey, threadCatchingUp, isConnecting, isSendBusy]);

  const sendAutomatedConversationTurn = useCallback(
    async (
      text: string,
      options?: { rawProviderCommand?: boolean; preserveExactText?: boolean },
    ) => {
      if (!activeThread || !isServerThread || sendInFlightRef.current) {
        throw new Error("This thread is not ready to send another turn.");
      }
      const sendCtx = composerRef.current?.getSendContext();
      if (!sendCtx?.providerAvailable) {
        throw new Error("The active provider is unavailable.");
      }

      const messageId = newMessageId();
      const createdAt = new Date().toISOString();
      const messageText =
        options?.rawProviderCommand || options?.preserveExactText
          ? text
          : formatOutgoingPrompt({
              provider: sendCtx.selectedProvider,
              model: sendCtx.selectedModel,
              models: sendCtx.selectedProviderModels,
              effort: sendCtx.selectedPromptEffort,
              text,
            });

      const sendScope = composerSendScopeRef.current;
      const ownsComposer = () =>
        chatViewMountedRef.current &&
        activeThreadKeyRef.current === activeThreadKey &&
        composerSendScopeRef.current === sendScope;
      sendInFlightRef.current = true;
      beginLocalDispatch({ preparingWorktree: false });
      setThreadError(activeThread.id, null);
      prepareTimelineForSend(messageId);
      setOptimisticUserMessages((existing) => [
        ...existing,
        {
          id: messageId,
          role: "user",
          text: messageText,
          turnId: null,
          createdAt,
          updatedAt: createdAt,
          streaming: false,
        },
      ]);

      const startResult = await startThreadTurn({
        environmentId,
        input: {
          commandId: CommandId.make(`automated-chat-turn:${messageId}`),
          threadId: activeThread.id,
          message: {
            messageId,
            role: "user",
            text: messageText,
            attachments: [],
          },
          modelSelection: sendCtx.selectedModelSelection,
          titleSeed: activeThread.title,
          runtimeMode,
          interactionMode,
          createdAt,
        },
      });
      if (ownsComposer()) {
        sendInFlightRef.current = false;
        resetLocalDispatch();
      }
      if (startResult._tag === "Success") {
        return;
      }

      setOptimisticUserMessages((existing) =>
        existing.filter((message) => message.id !== messageId),
      );
      if (isAtomCommandInterrupted(startResult)) {
        throw new Error("The chat command was interrupted.");
      }
      const cause = squashAtomCommandFailure(startResult);
      throw cause instanceof Error ? cause : new Error("Failed to start the provider turn.");
    },
    [
      activeThread,
      activeThreadKey,
      appliedInteractionMode,
      beginLocalDispatch,
      environmentId,
      interactionMode,
      isServerThread,
      prepareTimelineForSend,
      resetLocalDispatch,
      runtimeMode,
      setThreadError,
      startThreadTurn,
    ],
  );

  const onApplyComposerSettings = useCallback(
    (description: string) => {
      if (isApplyingComposerSettings) return;
      setIsApplyingComposerSettings(true);
      void sendAutomatedConversationTurn(buildSettingsUpdatePrompt(description), {
        preserveExactText: true,
      })
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : "Failed to apply conversation settings.";
          if (activeThread) setThreadError(activeThread.id, message);
        })
        .finally(() => setIsApplyingComposerSettings(false));
    },
    [activeThread, isApplyingComposerSettings, sendAutomatedConversationTurn, setThreadError],
  );

  const resumableSessionFailure = canResumeFailedThreadSession(activeThread);
  const onResumeIncompleteTurn = useCallback(() => {
    if (
      !activeThread ||
      (resumableAssistantMessageId === null &&
        resumableRuntimeErrorActivityId === null &&
        !resumableSessionFailure) ||
      isWorking ||
      activeEnvironmentUnavailable ||
      resumeIncompleteTurnInFlightRef.current ||
      sendInFlightRef.current
    ) {
      return;
    }

    setIsResumeIncompleteTurnBusy(true);
    void runResumeIncompleteTurn({
      inFlightRef: resumeIncompleteTurnInFlightRef,
      send: (message) =>
        sendAutomatedConversationTurn(message, {
          preserveExactText: true,
        }),
    })
      .catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : "Failed to resume the incomplete response.";
        setThreadError(activeThread.id, message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not resume response",
            description: message,
          }),
        );
      })
      .finally(() => {
        setIsResumeIncompleteTurnBusy(false);
      });
  }, [
    activeThread,
    activeEnvironmentUnavailable,
    isWorking,
    resumableAssistantMessageId,
    resumableRuntimeErrorActivityId,
    resumableSessionFailure,
    sendAutomatedConversationTurn,
    setThreadError,
  ]);

  useEffect(() => {
    const waiter = compactionCompletionWaiterRef.current;
    if (!waiter || waiter.settled) return;
    if (!activeThreadKey || activeThreadKey !== waiter.threadKey) {
      waiter.settled = true;
      waiter.reject(new Error("The active thread changed before compaction completed."));
      return;
    }
    if (
      contextCompactionActivityCount > waiter.baselineActivityCount &&
      latestTurnSettled &&
      phase !== "running"
    ) {
      waiter.settled = true;
      waiter.resolve();
      return;
    }
    if (
      activeLatestTurn?.turnId !== waiter.baselineTurnId &&
      latestTurnSettled &&
      phase !== "running" &&
      contextCompactionActivityCount === waiter.baselineActivityCount
    ) {
      waiter.settled = true;
      waiter.reject(
        new Error("The provider finished without confirming that context was compacted."),
      );
    }
  }, [
    activeLatestTurn?.turnId,
    activeThreadKey,
    contextCompactionActivityCount,
    latestTurnSettled,
    phase,
  ]);

  const onCompactAndContinue = useCallback(() => {
    if (
      compactAndContinueInFlightRef.current ||
      !activeThread ||
      !activeThreadKey ||
      isWorking ||
      !latestTurnSettled
    ) {
      return;
    }

    compactAndContinueInFlightRef.current = true;
    setIsCompactAndContinueBusy(true);
    const completion = new Promise<void>((resolve, reject) => {
      compactionCompletionWaiterRef.current = {
        threadKey: activeThreadKey,
        baselineActivityCount: contextCompactionActivityCount,
        baselineTurnId: activeLatestTurn?.turnId ?? null,
        settled: false,
        resolve,
        reject,
      };
    });

    void runCompactAndContinue({
      onStageChange: setCompactionOperationStage,
      startCompaction: () =>
        sendAutomatedConversationTurn("/compact", { rawProviderCommand: true }),
      awaitCompactionComplete: () => completion,
      sendContinuation: () =>
        sendAutomatedConversationTurn(
          "Continue the conversation from where you left off after compacting the context.",
        ),
    })
      .catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : "Failed to compact and continue this thread.";
        setThreadError(activeThread.id, message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not compact and continue",
            description: message,
          }),
        );
      })
      .finally(() => {
        compactionCompletionWaiterRef.current = null;
        compactAndContinueInFlightRef.current = false;
        setIsCompactAndContinueBusy(false);
        setCompactionOperationStage(null);
      });
  }, [
    activeLatestTurn?.turnId,
    activeThread,
    activeThreadKey,
    contextCompactionActivityCount,
    isWorking,
    latestTurnSettled,
    sendAutomatedConversationTurn,
    setThreadError,
  ]);

  const voiceTranscriptCorrectionConfig = {
    enabled: settings.voiceTranscriptionCorrectionEnabled,
    cwd:
      activeProject === null
        ? ""
        : projectScriptCwd({
            project: { cwd: activeProject.workspaceRoot },
            worktreePath: activeThread?.worktreePath ?? null,
          }),
    conversationContext: voiceTranscriptConversationContext,
    modelSelection:
      settings.voiceTranscriptionCorrectionModelSelection ?? settings.textGenerationModelSelection,
  };
  const voiceTranscriptCorrectionRef = useRef(voiceTranscriptCorrectionConfig);
  voiceTranscriptCorrectionRef.current = voiceTranscriptCorrectionConfig;

  pushToTalkEnabledRef.current =
    appVoiceCaptureEnabled &&
    !anyBackgroundVoiceTranscriptionActive &&
    (pushToTalkTerminalTargetRef.current !== null || pendingUserInputs.length === 0) &&
    Boolean(activeThread) &&
    !activeProviderAuthenticationPaused &&
    !isRevertingCheckpoint &&
    !isSendBusy &&
    !isConnecting &&
    !threadDetailLoading &&
    (!activeEnvironmentUnavailable || canQueueLocalMessage) &&
    !sendInFlightRef.current;
  useEffect(() => {
    if (!appVoiceCaptureEnabled) {
      pushToTalkStartRef.current = () => undefined;
      pushToTalkStopRef.current = () => undefined;
      setPushToTalkStatus(null);
      return;
    }

    let held = false;
    let disposed = false;
    let recorder: MediaRecorder | null = null;
    let stream: MediaStream | null = null;
    /** Set instead of `recorder` when the browser transcribes for us. */
    let nativeDictation: NativeSpeechDictationSession | null = null;
    let chunks: Blob[] = [];
    let recordingTimeout: number | null = null;
    let focusRestoreFrame: number | null = null;
    let focusRestoreTarget: HTMLElement | null = null;
    let focusRestoreToComposer = false;
    let recordingTimedOut = false;
    let recordingStartedAt = 0;
    let systemAudioMuteRequested = false;

    const clearRecordingTimeout = () => {
      if (recordingTimeout === null) return;
      window.clearTimeout(recordingTimeout);
      recordingTimeout = null;
    };

    const restoreHeldFocus = () => {
      const target = focusRestoreTarget;
      const shouldFallbackToComposer = focusRestoreToComposer;
      focusRestoreTarget = null;
      focusRestoreToComposer = false;
      if (focusRestoreFrame !== null) window.cancelAnimationFrame(focusRestoreFrame);
      focusRestoreFrame = window.requestAnimationFrame(() => {
        focusRestoreFrame = null;
        if (disposed) return;
        restorePushToTalkFocus(target, () => {
          if (shouldFallbackToComposer) composerRef.current?.focusAtEnd();
        });
      });
    };

    const reportError = (title: string, description: string) => {
      if (!disposed) setPushToTalkStatus(null);
      toastManager.add(stackedThreadToast({ type: "error", title, description }));
    };

    const restoreSystemAudio = () => {
      if (!systemAudioMuteRequested) return;
      systemAudioMuteRequested = false;
      void window.desktopBridge
        ?.setVoiceCaptureSystemAudioMuted({ owner: "dictation", muted: false })
        .catch(() => undefined);
    };

    const deliverVoiceTranscript = (transcript: string) => {
      const terminalTarget = pushToTalkTerminalTargetRef.current;
      pushToTalkTerminalTargetRef.current = null;
      if (!transcript) {
        reportError("No speech detected", "Hold the shortcut while speaking, then release it.");
        return;
      }
      if (terminalTarget !== null) {
        void writePushToTalkTranscriptRef.current(terminalTarget, transcript);
      }
    };

    /**
     * Dictate through the browser's own recogniser instead of recording audio.
     *
     * Only reached on a touch client with no desktop bridge, where the
     * microphone was previously hidden altogether - so this adds a path rather
     * than replacing one. The transcript arrives as a string and goes through
     * the same delivery as recorded audio.
     */
    const startNativeDictation = (): boolean => {
      const create = getSpeechRecognitionConstructor();
      if (
        create === undefined ||
        !shouldPreferNativeSpeechDictation({
          hasDesktopBridge: window.desktopBridge !== undefined,
          hasCoarsePointer: window.matchMedia?.("(pointer: coarse)").matches === true,
          hasRecognizer: true,
        })
      ) {
        return false;
      }
      try {
        nativeDictation = startNativeSpeechDictation({
          create: () => new create(),
          lang: navigator.language?.trim() || "en-US",
        });
      } catch {
        nativeDictation = null;
        return false;
      }
      if (!disposed) setPushToTalkStatus("recording");
      return true;
    };

    const startRecording = async () => {
      if (
        !pushToTalkEnabledRef.current ||
        // A terminal target types raw text into a PTY, so it does not need a
        // provider the way a composer send does.
        (pushToTalkTerminalTargetRef.current === null &&
          !composerRef.current?.getSendContext().providerAvailable) ||
        recorder ||
        pushToTalkStatusRef.current !== null ||
        typeof MediaRecorder === "undefined" ||
        !navigator.mediaDevices?.getUserMedia
      ) {
        if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
          reportError(
            "Push-to-talk is unavailable",
            "This browser does not expose microphone recording APIs.",
          );
        }
        return;
      }

      if (pushToTalkTerminalTargetRef.current !== null && startNativeDictation()) return;

      try {
        const nextStream = await navigator.mediaDevices.getUserMedia({
          // Shared with the realtime session: the two asked for the same three
          // constraints independently, which is exactly how they drift.
          audio: microphoneConstraints(),
        });
        if (disposed || !held) {
          nextStream.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = nextStream;
        chunks = [];
        recorder = new MediaRecorder(nextStream);
        recorder.addEventListener("dataavailable", (event) => {
          if (event.data.size > 0) chunks.push(event.data);
        });
        recorder.addEventListener(
          "stop",
          () => {
            clearRecordingTimeout();
            restoreSystemAudio();
            const audio = new Blob(chunks, { type: recorder?.mimeType || "audio/webm" });
            recorder = null;
            stream?.getTracks().forEach((track) => track.stop());
            stream = null;
            if (!disposed) setPushToTalkStatus(null);
            const reachedRecordingLimit = recordingTimedOut;
            recordingTimedOut = false;
            if (
              !shouldTranscribeStoppedRecording({
                audioByteLength: audio.size,
                reachedRecordingLimit,
              })
            ) {
              setPushToTalkStatus(null);
              return;
            }
            if (reachedRecordingLimit) {
              toastManager.add(
                stackedThreadToast({
                  type: "info",
                  title: "Two-minute recording limit reached",
                  description: "Your recording is ready to attach.",
                }),
              );
            }
            if (pushToTalkTerminalTargetRef.current === null) {
              const note = createVoiceNoteDraft(audio, Date.now() - recordingStartedAt);
              useComposerDraftStore.getState().addImage(composerDraftTarget, note);
              if (!disposed) composerRef.current?.focusAtEnd();
              return;
            }
            const transcriptionTaskId =
              startVoiceTranscriptionBackgroundTask(transcriptionOwnerKey);
            if (transcriptionTaskId === null) {
              reportError(
                "Voice transcription already in progress",
                "Finish or cancel the active transcription before recording in another chat.",
              );
              return;
            }
            void transcribeRecordedAudio(audio, (progress) => {
              useBackgroundTaskStore.getState().updateTask(transcriptionTaskId, {
                status: progress.status,
                progress:
                  progress.status === "loading"
                    ? Math.max(5, progress.progress ?? 5)
                    : Math.max(15, progress.progress ?? 50),
              });
            })
              .then((transcript) => {
                const correction = voiceTranscriptCorrectionRef.current;
                return correctVoiceTranscriptWithFallback({
                  ...correction,
                  transcript,
                  onRefining: () => {
                    useBackgroundTaskStore.getState().updateTask(transcriptionTaskId, {
                      status: "refining",
                      progress: 90,
                    });
                  },
                  request: async (input) => {
                    const result = await correctVoiceTranscript({ environmentId, input });
                    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                    return result.value.transcript;
                  },
                });
              })
              .then(deliverVoiceTranscript)
              .catch((cause) => {
                if (isTranscriptionCancellationError(cause)) return;
                reportError(
                  "Transcription failed",
                  cause instanceof Error
                    ? cause.message
                    : "The local Whisper model could not transcribe this recording.",
                );
              })
              .finally(() => {
                finishVoiceTranscriptionBackgroundTask(transcriptionTaskId);
              });
          },
          { once: true },
        );
        const desktopBridge = window.desktopBridge;
        if (
          !startRecorderWithCue(recorder, () => {
            const clientSettings = getClientSettings();
            return cueThenMuteSystemAudio({
              playCue: () => playRecordingStartCue(resolveVoiceCuePolicy(clientSettings)),
              muteSystemAudio:
                desktopBridge !== undefined && clientSettings.pushToTalkMutesSystemAudio
                  ? () =>
                      desktopBridge
                        .setVoiceCaptureSystemAudioMuted({ owner: "dictation", muted: true })
                        .catch(() => false)
                  : null,
              recordingActive: () => !disposed && recorder?.state === "recording",
              noteMuteRequested: () => {
                systemAudioMuteRequested = true;
              },
              restoreSystemAudio,
            });
          })
        ) {
          throw new Error("The microphone recorder did not enter the recording state.");
        }
        recordingStartedAt = Date.now();
        setPushToTalkStatus("recording");
        recordingTimeout = window.setTimeout(() => {
          if (recorder?.state !== "recording") return;
          recordingTimedOut = true;
          held = false;
          restoreHeldFocus();
          restoreSystemAudio();
          recorder.stop();
        }, PUSH_TO_TALK_MAX_RECORDING_MS);
      } catch (cause) {
        clearRecordingTimeout();
        restoreSystemAudio();
        if (recorder?.state !== "recording") {
          recorder = null;
          stream?.getTracks().forEach((track) => track.stop());
          stream = null;
        }
        reportError(
          "Microphone access failed",
          cause instanceof Error ? cause.message : "Solla Code could not access the microphone.",
        );
      }
    };

    const beginHolding = (terminalTarget: PushToTalkTerminalTarget | null = null) => {
      if (held) return;
      if (focusRestoreFrame !== null) {
        window.cancelAnimationFrame(focusRestoreFrame);
        focusRestoreFrame = null;
      }
      focusRestoreTarget =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      focusRestoreToComposer = terminalTarget === null;
      pushToTalkTerminalTargetRef.current = terminalTarget;
      held = true;
      void startRecording();
    };
    const endHolding = () => {
      const wasHeld = held;
      held = false;
      if (wasHeld) restoreHeldFocus();
      restoreSystemAudio();
      if (pushToTalkStatusRef.current === "recording" && !disposed) {
        setPushToTalkStatus(null);
      }
      const dictation = nativeDictation;
      if (dictation !== null) {
        nativeDictation = null;
        void dictation
          .stop()
          .then((transcript) => {
            if (transcript.trim().length === 0) {
              reportError(
                "No speech detected",
                "Hold the microphone while speaking, then release it to send.",
              );
              return;
            }
            deliverVoiceTranscript(transcript);
          })
          .catch((cause: unknown) => {
            reportError(
              "Dictation failed",
              cause instanceof Error ? cause.message : "The browser could not transcribe speech.",
            );
          });
        return;
      }
      if (recorder?.state === "recording") recorder.stop();
    };
    pushToTalkStartRef.current = () => beginHolding();
    pushToTalkStopRef.current = endHolding;

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof Node ? event.target : document.activeElement;
      const targetElement = target instanceof Element ? target : document.activeElement;
      if (
        !shouldHandlePushToTalkForSurface({
          embeddedSideChat,
          targetWithinOwnSurface: Boolean(target && chatViewRootRef.current?.contains(target)),
          targetWithinEmbeddedSideChat: Boolean(
            targetElement?.closest('[data-embedded-side-chat="true"]'),
          ),
        })
      ) {
        return;
      }
      if (!isPushToTalkShortcut(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat) return;
      beginHolding(resolvePushToTalkTerminalTargetRef.current(event.target));
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!held || !isPushToTalkReleaseEvent(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      endHolding();
    };
    const stopForPageDeparture = () => {
      endHolding();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") stopForPageDeparture();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    // A held recording belongs to the physical chord, not DOM focus. React
    // replacing the focused composer or a new message taking focus must not
    // end it, so there is deliberately no `focusout` listener. A true window
    // blur is different: Chromium may never deliver keyup after the app loses
    // focus, so it is a deterministic stop boundary alongside page departure.
    window.addEventListener("blur", stopForPageDeparture);
    window.addEventListener("pagehide", stopForPageDeparture);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      setPushToTalkStatus(null);
      pushToTalkStartRef.current = () => undefined;
      pushToTalkStopRef.current = () => undefined;
      const recordingWasActive = recorder?.state === "recording";
      endHolding();
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", stopForPageDeparture);
      window.removeEventListener("pagehide", stopForPageDeparture);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearRecordingTimeout();
      if (focusRestoreFrame !== null) window.cancelAnimationFrame(focusRestoreFrame);
      if (!recordingWasActive) stream?.getTracks().forEach((track) => track.stop());
      restoreSystemAudio();
    };
  }, [
    appVoiceCaptureEnabled,
    composerDraftTarget,
    composerRef,
    correctVoiceTranscript,
    embeddedSideChat,
    environmentId,
    setComposerDraftPrompt,
    transcriptionOwnerKey,
  ]);

  const onInterrupt = async () => {
    if (!activeThread || !activeThreadKey || isInterrupting) return;
    setInterruptRequestedThreadKey(activeThreadKey);
    // Stop is a hard cancel of this turn — clear a sticky provider error so a
    // fallback/unavailable banner cannot keep the thread looking broken while
    // the harness is being killed.
    setThreadError(activeThread.id, null);
    const result = await interruptThreadTurn({
      environmentId,
      input: buildThreadTurnInterruptInput(activeThread),
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setInterruptRequestedThreadKey(null);
      const error = squashAtomCommandFailure(result);
      setThreadError(
        activeThread.id,
        error instanceof Error ? error.message : "Failed to interrupt the current turn.",
      );
    }
  };

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      if (!activeThreadId) return;

      setRespondingRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      const result = await respondToThreadApproval({
        environmentId,
        input: {
          threadId: activeThreadId,
          requestId,
          decision,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : "Failed to submit approval decision.",
        );
      }
      if (result._tag === "Failure") {
        setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
      }
      return result;
    },
    [activeThreadId, environmentId, respondToThreadApproval, setThreadError],
  );

  const onRespondToUserInput = useCallback(
    async (requestId: ApprovalRequestId, answers: Record<string, unknown>) => {
      if (!activeThreadId) return;

      setRespondingUserInputRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      const result = await respondToThreadUserInput({
        environmentId,
        input: {
          threadId: activeThreadId,
          requestId,
          answers,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : "Failed to submit user input.",
        );
      }
      if (result._tag === "Failure") {
        setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId));
      }
      return result;
    },
    [activeThreadId, environmentId, respondToThreadUserInput, setThreadError],
  );

  const setActivePendingUserInputQuestionIndex = useCallback(
    (nextQuestionIndex: number) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputQuestionIndexByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: nextQuestionIndex,
      }));
    },
    [activePendingUserInput],
  );

  const onSelectActivePendingUserInputOption = useCallback(
    (questionId: string, optionLabel: string) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputAnswersByRequestId((existing) => {
        const question =
          (activePendingProgress?.activeQuestion?.id === questionId
            ? activePendingProgress.activeQuestion
            : undefined) ??
          activePendingUserInput.questions.find((entry) => entry.id === questionId);
        if (!question) {
          return existing;
        }

        return {
          ...existing,
          [activePendingUserInput.requestId]: {
            ...existing[activePendingUserInput.requestId],
            [questionId]: togglePendingUserInputOptionSelection(
              question,
              existing[activePendingUserInput.requestId]?.[questionId],
              optionLabel,
            ),
          },
        };
      });
      promptRef.current = "";
      composerRef.current?.resetCursorState({ cursor: 0 });
    },
    [activePendingProgress?.activeQuestion, activePendingUserInput, composerRef],
  );

  const onChangeActivePendingUserInputCustomAnswer = useCallback(
    (
      questionId: string,
      value: string,
      nextCursor: number,
      expandedCursor: number,
      _cursorAdjacentToMention: boolean,
    ) => {
      if (!activePendingUserInput) {
        return;
      }
      promptRef.current = value;
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: {
          ...existing[activePendingUserInput.requestId],
          [questionId]: setPendingUserInputCustomAnswer(
            existing[activePendingUserInput.requestId]?.[questionId],
            value,
          ),
        },
      }));
      const snapshot = composerRef.current?.readSnapshot();
      if (
        snapshot?.value !== value ||
        snapshot.cursor !== nextCursor ||
        snapshot.expandedCursor !== expandedCursor
      ) {
        composerRef.current?.focusAt(nextCursor);
      }
    },
    [activePendingUserInput, composerRef],
  );

  const onAdvanceActivePendingUserInput = useCallback(() => {
    if (!activePendingUserInput || !activePendingProgress) {
      return;
    }
    if (activePendingProgress.isLastQuestion) {
      if (activePendingResolvedAnswers) {
        void onRespondToUserInput(activePendingUserInput.requestId, activePendingResolvedAnswers);
      }
      return;
    }
    setActivePendingUserInputQuestionIndex(activePendingProgress.questionIndex + 1);
  }, [
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingUserInput,
    onRespondToUserInput,
    setActivePendingUserInputQuestionIndex,
  ]);

  const onPreviousActivePendingUserInputQuestion = useCallback(() => {
    if (!activePendingProgress) {
      return;
    }
    setActivePendingUserInputQuestionIndex(Math.max(activePendingProgress.questionIndex - 1, 0));
  }, [activePendingProgress, setActivePendingUserInputQuestionIndex]);

  // Agent mode answers questions on the user's behalf — an unanswered prompt
  // would otherwise park the loop indefinitely, which is the one thing the mode
  // exists to avoid. Keyed by requestId so a request is only ever answered once,
  // and skipped while offline because the response cannot be delivered.
  const agentAnsweredRequestIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isAgentMode(interactionMode)) return;
    if (!activePendingUserInput) {
      agentAnsweredRequestIdRef.current = null;
      return;
    }
    if (activeEnvironmentConnectionPhase !== "connected") return;
    const requestId = String(activePendingUserInput.requestId);
    if (agentAnsweredRequestIdRef.current === requestId) return;
    if (respondingUserInputRequestIds.includes(activePendingUserInput.requestId)) return;

    agentAnsweredRequestIdRef.current = requestId;
    void onRespondToUserInput(
      activePendingUserInput.requestId,
      buildAgentAnswers(activePendingUserInput.questions),
    ).catch(() => {
      // A failed submit is retried once the link is back, same as the nudge.
      agentAnsweredRequestIdRef.current = null;
    });
  }, [
    activeEnvironmentConnectionPhase,
    activePendingUserInput,
    interactionMode,
    onRespondToUserInput,
    respondingUserInputRequestIds,
  ]);

  const onSubmitPlanFollowUp = useCallback(
    async ({
      text,
      interactionMode: nextInteractionMode,
    }: {
      text: string;
      interactionMode: "default" | "plan";
    }) => {
      if (
        !activeThread ||
        !isServerThread ||
        isSendBusy ||
        isConnecting ||
        sendInFlightRef.current
      ) {
        return false;
      }

      const trimmed = text.trim();
      if (!trimmed) {
        return false;
      }

      const sendCtx = composerRef.current?.getSendContext();
      if (!sendCtx?.providerAvailable) {
        return false;
      }
      const {
        selectedProvider: ctxSelectedProvider,
        selectedModel: ctxSelectedModel,
        selectedProviderModels: ctxSelectedProviderModels,
        selectedPromptEffort: ctxSelectedPromptEffort,
        selectedModelSelection: ctxSelectedModelSelection,
      } = sendCtx;

      const threadIdForSend = activeThread.id;
      const messageIdForSend = newMessageId();
      const messageCreatedAt = new Date().toISOString();
      const outgoingMessageText = formatOutgoingPrompt({
        provider: ctxSelectedProvider,
        model: ctxSelectedModel,
        models: ctxSelectedProviderModels,
        effort: ctxSelectedPromptEffort,
        text: trimmed,
      });

      const sendScope = composerSendScopeRef.current;
      const ownsComposer = () =>
        chatViewMountedRef.current &&
        activeThreadKeyRef.current === activeThreadKey &&
        composerSendScopeRef.current === sendScope;
      sendInFlightRef.current = true;
      beginLocalDispatch({ preparingWorktree: false });
      setThreadError(threadIdForSend, null);

      prepareTimelineForSend(messageIdForSend);

      setOptimisticUserMessages((existing) => [
        ...existing,
        {
          id: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          turnId: null,
          createdAt: messageCreatedAt,
          updatedAt: messageCreatedAt,
          streaming: false,
        },
      ]);

      let failure: AtomCommandResult<unknown, unknown> | null = null;

      if (failure === null) {
        // Keep the mode toggle and plan-follow-up banner in sync immediately
        // while the same-thread implementation turn is starting.
        setComposerDraftInteractionMode(
          scopeThreadRef(activeThread.environmentId, threadIdForSend),
          nextInteractionMode,
        );

        const startResult = await startThreadTurn({
          environmentId,
          input: {
            threadId: threadIdForSend,
            message: {
              messageId: messageIdForSend,
              role: "user",
              text: outgoingMessageText,
              attachments: [],
            },
            modelSelection: ctxSelectedModelSelection,
            titleSeed: activeThread.title,
            runtimeMode,
            interactionMode: nextInteractionMode,
            ...(nextInteractionMode === "default" && activeProposedPlan
              ? {
                  sourceProposedPlan: {
                    threadId: activeThread.id,
                    planId: activeProposedPlan.id,
                  },
                }
              : {}),
            createdAt: messageCreatedAt,
          },
        });
        failure = startResult._tag === "Failure" ? startResult : null;
      }

      if (failure === null) {
        // Optimistically open the plan sidebar when implementing (not refining).
        // "default" mode here means the agent is executing the plan, which produces
        // step-tracking activities that the sidebar will display.
        if (nextInteractionMode === "default" && autoOpenPlanSidebar) {
          planSidebarDismissedForTurnRef.current = null;
          if (activeThreadRef) {
            useRightPanelStore.getState().open(activeThreadRef, "plan");
          }
        }
        if (ownsComposer()) {
          sendInFlightRef.current = false;
          resetLocalDispatch();
        }
        return true;
      }

      setOptimisticUserMessages((existing) =>
        existing.filter((message) => message.id !== messageIdForSend),
      );
      if (!isAtomCommandInterrupted(failure)) {
        const error = squashAtomCommandFailure(failure);
        setThreadError(
          threadIdForSend,
          error instanceof Error ? error.message : "Failed to send plan follow-up.",
        );
      }
      if (ownsComposer()) {
        sendInFlightRef.current = false;
        resetLocalDispatch();
      }
      return false;
    },
    [
      activeThread,
      activeThreadKey,
      activeProposedPlan,
      beginLocalDispatch,
      isConnecting,
      isSendBusy,
      isServerThread,
      localCheckoutBranchMismatch,
      resetLocalDispatch,
      runtimeMode,
      setComposerDraftInteractionMode,
      setThreadError,
      startThreadTurn,
      autoOpenPlanSidebar,
      environmentId,
      composerRef,
    ],
  );

  const onImplementPlanInNewThread = useCallback(async () => {
    if (
      !activeThread ||
      !activeProject ||
      !activeProposedPlan ||
      !isServerThread ||
      isSendBusy ||
      isConnecting ||
      activeEnvironmentUnavailable ||
      sendInFlightRef.current
    ) {
      return;
    }

    const sendCtx = composerRef.current?.getSendContext();
    if (!sendCtx?.providerAvailable) {
      return;
    }
    const {
      selectedProvider: ctxSelectedProvider,
      selectedModel: ctxSelectedModel,
      selectedProviderModels: ctxSelectedProviderModels,
      selectedPromptEffort: ctxSelectedPromptEffort,
      selectedModelSelection: ctxSelectedModelSelection,
    } = sendCtx;

    const createdAt = new Date().toISOString();
    const nextThreadId = newThreadId();
    const planMarkdown = activeProposedPlan.planMarkdown;
    const implementationPrompt = buildPlanImplementationPrompt(planMarkdown);
    const outgoingImplementationPrompt = formatOutgoingPrompt({
      provider: ctxSelectedProvider,
      model: ctxSelectedModel,
      models: ctxSelectedProviderModels,
      effort: ctxSelectedPromptEffort,
      text: implementationPrompt,
    });
    const nextThreadTitle = truncate(buildPlanImplementationThreadTitle(planMarkdown));
    const nextThreadModelSelection: ModelSelection = ctxSelectedModelSelection;

    const sendScope = composerSendScopeRef.current;
    const ownsComposer = () =>
      chatViewMountedRef.current &&
      activeThreadKeyRef.current === activeThreadKey &&
      composerSendScopeRef.current === sendScope;
    sendInFlightRef.current = true;
    beginLocalDispatch({ preparingWorktree: false });
    const finish = () => {
      if (ownsComposer()) {
        sendInFlightRef.current = false;
        resetLocalDispatch();
      }
    };

    const createResult = await createThread({
      environmentId,
      input: {
        threadId: nextThreadId,
        projectId: activeProject.id,
        title: nextThreadTitle,
        modelSelection: nextThreadModelSelection,
        runtimeMode,
        interactionMode: "default",
        branch: activeThreadBranch,
        worktreePath: activeThread.worktreePath,
        createdAt,
      },
    });
    let failure: AtomCommandResult<unknown, unknown> | null =
      createResult._tag === "Failure" ? createResult : null;

    let saved = false;
    if (failure === null) {
      const startResult = await startThreadTurn({
        environmentId,
        input: {
          threadId: nextThreadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: outgoingImplementationPrompt,
            attachments: [],
          },
          modelSelection: ctxSelectedModelSelection,
          titleSeed: nextThreadTitle,
          runtimeMode,
          interactionMode: "default",
          sourceProposedPlan: {
            threadId: activeThread.id,
            planId: activeProposedPlan.id,
          },
          createdAt,
        },
      });
      failure = startResult._tag === "Failure" ? startResult : null;
      saved = failure === null;
    }

    if (failure === null) {
      // Signal that the plan sidebar should open on the new thread when enabled.
      planSidebarOpenOnNextThreadRef.current = autoOpenPlanSidebar;
      const navigateResult = await settlePromise(() =>
        navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: activeThread.environmentId,
            threadId: nextThreadId,
          },
        }),
      );
      failure = navigateResult._tag === "Failure" ? navigateResult : null;
    }

    if (failure !== null && !saved) {
      const cleanupResult = await deleteThread({
        environmentId,
        input: {
          threadId: nextThreadId,
        },
      });
      if (cleanupResult._tag === "Failure" && !isAtomCommandInterrupted(cleanupResult)) {
        console.warn(
          "Failed to clean up implementation thread after start failure.",
          squashAtomCommandFailure(cleanupResult),
        );
      }
      if (!isAtomCommandInterrupted(failure)) {
        const error = squashAtomCommandFailure(failure);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start implementation thread",
            description:
              error instanceof Error
                ? error.message
                : "An error occurred while creating the new thread.",
          }),
        );
      }
    }
    finish();
  }, [
    activeThreadKey,
    activeProject,
    activeProposedPlan,
    activeThreadBranch,
    activeThread,
    beginLocalDispatch,
    activeEnvironmentUnavailable,
    createThread,
    deleteThread,
    isConnecting,
    isSendBusy,
    isServerThread,
    navigate,
    resetLocalDispatch,
    runtimeMode,
    startThreadTurn,
    autoOpenPlanSidebar,
    environmentId,
    composerRef,
  ]);

  const onProviderModelSelect = useCallback(
    (instanceId: ProviderInstanceId, model: string) => {
      if (!activeThread) return;
      // Look up the configured instance so model normalization and custom
      // model lookup stay scoped to that exact instance. Unknown instance ids
      // are rejected by returning early; the server remains authoritative too.
      const entry = providerStatuses.find((snapshot) => snapshot.instanceId === instanceId);
      const resolvedDriverKind = entry?.driver ?? null;
      if (
        lockedProvider !== null &&
        resolvedDriverKind !== null &&
        resolvedDriverKind !== lockedProvider
      ) {
        scheduleComposerFocus();
        return;
      }
      if (lockedProvider !== null && activeThread.session?.providerInstanceId) {
        const currentEntry = providerStatuses.find(
          (snapshot) => snapshot.instanceId === activeThread.session?.providerInstanceId,
        );
        if (
          currentEntry?.continuation?.groupKey &&
          entry?.continuation?.groupKey &&
          currentEntry.continuation.groupKey !== entry.continuation.groupKey
        ) {
          scheduleComposerFocus();
          return;
        }
      }
      const resolvedModel = resolveAppModelSelectionForInstance(
        instanceId,
        settings,
        providerStatuses,
        model,
      );
      if (!resolvedModel) {
        scheduleComposerFocus();
        return;
      }
      const currentSelection =
        composerRef.current?.getSendContext().selectedModelSelection ?? activeThread.modelSelection;
      const savedSelection = useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)
        ?.modelSelectionByProvider[instanceId];
      const nextModelSelection = selectAppModelWithHighEffort(
        currentSelection,
        {
          instanceId,
          model: resolvedModel,
          ...(savedSelection?.options
            ? { options: savedSelection.options }
            : currentSelection.instanceId === instanceId && currentSelection.options
              ? { options: currentSelection.options }
              : {}),
        },
        providerStatuses,
      );
      const modelChanged =
        activeThread.modelSelection.instanceId !== nextModelSelection.instanceId ||
        activeThread.modelSelection.model !== nextModelSelection.model;
      if (modelChanged && providerTasks.length > 0) {
        // These rows belong to the provider state we are leaving. The task
        // dismissal store revives any genuinely live task as soon as it emits
        // an event newer than this dismissal, while a dead runtime ghost stays
        // gone instead of repopulating every time the user switches models.
        dismissProviderTasks(providerTasks.map((task) => task.taskId));
      }
      setComposerDraftModelSelection(composerDraftTarget, nextModelSelection, {
        replaceOptions: true,
      });
      // Keep the pick in the composer until Apply, Send, or Resume persists
      // it. Saving metadata here hid Apply before the running agent switched.
      if (persistComposerModelDefaults) {
        setStickyComposerModelSelection(nextModelSelection);
      }
      scheduleComposerFocus();
    },
    [
      activeThread,
      composerDraftTarget,
      dismissProviderTasks,
      persistComposerModelDefaults,
      providerTasks,
      lockedProvider,
      scheduleComposerFocus,
      setComposerDraftModelSelection,
      setStickyComposerModelSelection,
      providerStatuses,
      settings,
    ],
  );
  // Assisted "Initialize Git" is raised from the chat header, which cannot send
  // a turn itself. It queues the prompt plus the provider the user picked; this
  // applies that provider, then sends once the composer reports it as active.
  // Two passes are required — the send reads the composer's live context, which
  // still holds the previous selection during the render that changes it.
  const gitInitRequest = useGitInitRequestStore((state) => state.request);
  const clearGitInitRequest = useGitInitRequestStore((state) => state.clearRequest);
  useEffect(() => {
    if (gitInitRequest === null) return;
    if (!activeThread || !isServerThread) return;

    const sendCtx = composerRef.current?.getSendContext();
    if (
      !isGitInitRequestReady({
        request: gitInitRequest,
        activeInstanceId: sendCtx?.selectedModelSelection?.instanceId ?? null,
        activeModel: sendCtx?.selectedModelSelection?.model ?? null,
      })
    ) {
      onProviderModelSelect(gitInitRequest.instanceId, gitInitRequest.model);
      return;
    }
    if (sendInFlightRef.current || isSendBusy) return;

    const prompt = gitInitRequest.prompt;
    clearGitInitRequest();
    void sendAutomatedConversationTurn(prompt, { preserveExactText: true }).catch(
      (error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start repository setup",
            description: error instanceof Error ? error.message : "The turn could not be started.",
          }),
        );
      },
    );
  }, [
    activeThread,
    clearGitInitRequest,
    gitInitRequest,
    isSendBusy,
    isServerThread,
    onProviderModelSelect,
    sendAutomatedConversationTurn,
  ]);

  const onEnvModeChange = useCallback(
    (mode: DraftThreadEnvMode) => {
      if (canOverrideServerThreadEnvMode) {
        setPendingServerThreadEnvMode(mode);
        scheduleComposerFocus();
        return;
      }
      if (isLocalDraftThread) {
        setDraftThreadContext(composerDraftTarget, {
          envMode: mode,
          startFromOrigin: resolveNewDraftStartFromOrigin({
            envMode: mode,
            newWorktreesStartFromOrigin: primaryServerSettings.newWorktreesStartFromOrigin,
          }),
          ...(mode === "worktree" && draftThread?.worktreePath ? { worktreePath: null } : {}),
        });
      }
      scheduleComposerFocus();
    },
    [
      canOverrideServerThreadEnvMode,
      composerDraftTarget,
      draftThread?.worktreePath,
      isLocalDraftThread,
      primaryServerSettings.newWorktreesStartFromOrigin,
      setPendingServerThreadEnvMode,
      scheduleComposerFocus,
      setDraftThreadContext,
    ],
  );

  const onStartFromOriginChange = (nextStartFromOrigin: boolean) => {
    if (canOverrideServerThreadEnvMode && activeThread) {
      setPendingServerThreadStartFromOriginByThreadId((current) =>
        current[activeThread.id] === nextStartFromOrigin
          ? current
          : { ...current, [activeThread.id]: nextStartFromOrigin },
      );
      return;
    }
    if (isLocalDraftThread) {
      setDraftThreadContext(composerDraftTarget, {
        startFromOrigin: nextStartFromOrigin,
      });
    }
  };

  const onExpandTimelineImage = useCallback((preview: ExpandedImagePreview) => {
    setExpandedImage(preview);
  }, []);
  const onOpenTurnDiff = useCallback(
    (turnId: TurnId, filePath?: string) => {
      if (!isServerThread || !activeThreadRef) return;
      useDiffPanelStore.getState().selectTurn(activeThreadRef, turnId, filePath);
      useRightPanelStore.getState().open(activeThreadRef, "diff");
      onDiffPanelOpen?.();
    },
    [activeThreadRef, isServerThread, onDiffPanelOpen],
  );
  // Both the Map and the revert handler are read from refs at call-time so
  // the callback reference is fully stable and never busts context identity.
  const revertTurnCountRef = useRef(revertTurnCountByUserMessageId);
  revertTurnCountRef.current = revertTurnCountByUserMessageId;
  const onRevertToTurnCountRef = useRef(onRevertToTurnCount);
  onRevertToTurnCountRef.current = onRevertToTurnCount;
  const onRevertUserMessage = useCallback((messageId: MessageId) => {
    const targetTurnCount = revertTurnCountRef.current.get(messageId);
    if (typeof targetTurnCount !== "number") {
      return;
    }
    void onRevertToTurnCountRef.current(targetTurnCount);
  }, []);

  // Empty state: no active thread
  if (!activeThread) {
    return embeddedSideChat ? <SideChatLoadingState /> : <NoActiveThreadState />;
  }

  const panelToggleControls = terminalMainSurfaceActive ? null : (
    <PanelLayoutControls
      // Catch-up can restore the thread shell before its project detail. The
      // panel is thread-owned (Browser, Plan, Diff, side chats); only the Files
      // and Terminal actions below require a project, so disabling the whole
      // toggle here made the sidebar unreachable precisely while syncing.
      rightPanelAvailable={activeThreadRef !== null}
      rightPanelOpen={rightPanelOpen}
      rightPanelShortcutLabel={shortcutLabelForCommand(keybindings, "rightPanel.toggle")}
      onToggleRightPanel={toggleRightPanel}
    />
  );
  const panelLayoutControls = terminalMainSurfaceActive ? null : (
    <div
      className="workspace-titlebar-controls pointer-events-auto z-50 gap-1 [-webkit-app-region:no-drag]"
      data-right-panel-layout-controls
    >
      {rightPanelOpen && !shouldUsePlanSidebarSheet ? (
        <RightPanelMaximizeControl
          maximized={rightPanelMaximized}
          onToggle={toggleRightPanelMaximized}
        />
      ) : null}
      {panelToggleControls}
    </div>
  );
  const artifactShelf =
    isServerThread && activeThreadRef ? (
      <ThreadArtifactShelf
        threadRef={activeThreadRef}
        activeArtifactId={
          activeRightPanelSurface?.kind === "artifact" ? activeRightPanelSurface.resourceId : null
        }
        onOpen={openArtifactSurface}
      />
    ) : null;
  const artifactMenu =
    isServerThread && activeThreadRef ? (
      <ThreadArtifactMenu
        threadRef={activeThreadRef}
        activeArtifactId={
          activeRightPanelSurface?.kind === "artifact" ? activeRightPanelSurface.resourceId : null
        }
        onOpen={openArtifactSurface}
      />
    ) : null;
  const rightPanelContent = activeThreadRef ? (
    activeRightPanelSurface?.kind === "artifact" ? (
      <ThreadArtifactSurface threadRef={activeThreadRef} surface={activeRightPanelSurface} />
    ) : activeRightPanelSurface?.kind === "side-chat" ? (
      <div className="flex min-h-0 flex-1 flex-col" data-side-chat-surface>
        <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-border px-3">
          <span className="truncate text-xs text-muted-foreground">
            Interactive sub-agent · isolated from the main chat
          </span>
          {activeProject && !isAgentsProjectId(activeProject.id) && (
            <button
              type="button"
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:cursor-wait disabled:opacity-50"
              disabled={promotingSideChatThreadId === activeRightPanelSurface.resourceId}
              onClick={() => promoteSideChatSurface(activeRightPanelSurface)}
            >
              <ArrowUpRightIcon className="size-3.5" />
              {promotingSideChatThreadId === activeRightPanelSurface.resourceId
                ? "Promoting…"
                : "Promote to thread"}
            </button>
          )}
        </div>
        <ChatViewContent
          key={activeRightPanelSurface.resourceId}
          environmentId={activeThreadRef.environmentId}
          threadId={ThreadId.make(activeRightPanelSurface.resourceId)}
          routeKind="server"
          reserveTitleBarControlInset={false}
          embeddedSideChat
        />
      </div>
    ) : activeRightPanelSurface?.kind === "preview" ? (
      <Suspense fallback={null}>
        <PreviewPanel
          mode="embedded"
          threadRef={activeThreadRef}
          tabId={activeRightPanelSurface.resourceId}
          configuredUrls={configuredPreviewUrls}
          visible
        />
      </Suspense>
    ) : activeRightPanelSurface?.kind === "terminal" ? (
      <PersistentThreadTerminalPanel
        threadRef={activeThreadRef}
        surface={activeRightPanelSurface}
        launchContext={activeTerminalLaunchContext ?? null}
        focusRequestId={terminalFocusRequestId}
        keybindings={keybindings}
        onAddTerminalContext={addTerminalContextToDraft}
        onNewTerminal={addTerminalSurface}
        onActiveTerminalChange={activatePanelTerminal}
        onCloseTerminal={closePanelTerminal}
        newShortcutLabel={newTerminalShortcutLabel ?? undefined}
        closeShortcutLabel={closeTerminalShortcutLabel ?? undefined}
      />
    ) : activeRightPanelSurface?.kind === "diff" ? (
      <Suspense fallback={null}>
        <DiffPanel
          key={`${activeThreadKey}:${diffPanelGitStatusResolutionKey}`}
          mode="embedded"
          composerDraftTarget={composerDraftTarget}
          initialGitScope={initialDiffPanelGitScope}
        />
      </Suspense>
    ) : activeRightPanelSurface?.kind === "plan" ? (
      <PlanSidebar
        activePlan={activePlan}
        activeProposedPlan={sidebarProposedPlan}
        label={planSidebarLabel}
        environmentId={environmentId}
        threadRef={activeThreadRef}
        markdownCwd={gitCwd ?? undefined}
        workspaceRoot={activeWorkspaceRoot}
        timestampFormat={timestampFormat}
        mode="embedded"
      />
    ) : (activeRightPanelSurface?.kind === "files" || activeRightPanelSurface?.kind === "file") &&
      activeProject &&
      activeWorkspaceRoot ? (
      <Suspense fallback={null}>
        <RenderErrorBoundary
          fallback={
            <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
              Couldn’t load the file preview. Close the Files panel and open it again.
            </div>
          }
        >
          <FilePreviewPanel
            key={`${activeProject.environmentId}:${activeWorkspaceRoot}`}
            environmentId={activeProject.environmentId}
            cwd={activeWorkspaceRoot}
            projectName={activeProject.title}
            threadRef={activeThreadRef}
            composerDraftTarget={composerDraftTarget}
            keybindings={keybindings}
            availableEditors={availableEditors}
            relativePath={
              activeRightPanelSurface.kind === "file" ? activeRightPanelSurface.relativePath : null
            }
            revealLine={activeFileSurface?.revealLine ?? null}
            revealRequestId={activeFileSurface?.revealRequestId ?? 0}
            onOpenFile={openFileSurface}
            onPendingChange={handleFilePendingChange}
          />
        </RenderErrorBoundary>
      </Suspense>
    ) : null
  ) : null;

  const chatLayout = (
    <div
      ref={chatViewRootRef}
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
      data-embedded-side-chat={embeddedSideChat ? "true" : undefined}
      data-chat-quote-target={transcriptionOwnerKey}
    >
      {isServerThread && activeThreadRef ? (
        <ThreadArtifactDeepLinkOpener
          threadRef={activeThreadRef}
          requestedArtifactId={requestedArtifactId}
          onOpen={openArtifactSurface}
        />
      ) : null}
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-col overflow-x-hidden",
          rightPanelMaximized ? "w-0 flex-none" : "flex-1",
        )}
        data-chat-column-maximized-away={rightPanelMaximized ? "true" : "false"}
      >
        {projectScriptsPortalTarget && activeProject
          ? createPortal(
              <ProjectScriptsControlForProject
                key={activeThreadKey}
                environmentId={activeThread.environmentId}
                cwd={activeProject.workspaceRoot}
                scripts={visibleProjectScripts}
                keybindings={keybindings}
                preferredScriptId={lastInvokedScriptByProjectId[activeProject.id] ?? null}
                onRunScript={runProjectScript}
                onAddScript={saveProjectScript}
                onUpdateScript={updateProjectScript}
                onDeleteScript={deleteProjectScript}
              />,
              projectScriptsPortalTarget,
            )
          : null}
        {/* Top bar */}
        {showWorkspaceHeader ? (
          <header
            data-chat-header
            className={cn(
              "bg-background transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none",
              isElectron
                ? cn(
                    "workspace-topbar drag-region relative px-3 sm:px-5",
                    reserveTitleBarControlInset &&
                      !inlineRightPanelOwnsTitleBar &&
                      "wco:pr-[var(--workspace-native-controls-inset)]",
                  )
                : "workspace-topbar pl-[calc(env(safe-area-inset-left)+0.75rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] sm:pl-[calc(env(safe-area-inset-left)+1.25rem)] sm:pr-[calc(env(safe-area-inset-right)+1.25rem)]",
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            {!visibleRightPanelOpen ? panelLayoutControls : null}
            <ChatHeader
              activeThreadEnvironmentId={activeThread.environmentId}
              activeThreadId={activeThread.id}
              {...(routeKind === "draft" && draftId ? { draftId } : {})}
              activeThreadTitle={activeThread.title}
              activeProjectName={activeProject?.title}
              activeProjectCwd={activeProject?.workspaceRoot ?? null}
              openInCwd={gitCwd}
              activeProjectScripts={visibleProjectScripts}
              preferredScriptId={
                activeProject ? (lastInvokedScriptByProjectId[activeProject.id] ?? null) : null
              }
              keybindings={keybindings}
              availableEditors={availableEditors}
              rightPanelOpen={visibleRightPanelOpen}
              gitCwd={gitCwd}
              mainSurface={terminalUiState.mainSurface}
              terminalsWorking={activeTerminalActivity !== null}
              chatWorking={timelineIsWorking}
              onMainSurfaceChange={handleMainSurfaceChange}
              onNewThreadInProject={handleNewThreadInActiveProject}
              onRunProjectScript={runProjectScript}
              onAddProjectScript={saveProjectScript}
              onUpdateProjectScript={updateProjectScript}
              onDeleteProjectScript={deleteProjectScript}
            />
          </header>
        ) : null}

        <ThreadErrorBanner
          error={threadError}
          {...(resumableSessionFailure ? { onResume: onResumeIncompleteTurn } : {})}
          resuming={isResumeIncompleteTurnBusy}
          resumeDisabled={activeEnvironmentUnavailable || isWorking}
          occurredAt={activeServerThread?.session?.updatedAt ?? null}
          onDismiss={dismissThreadError}
          {...(hostRepairErrorKey && hostRepairStartedErrorKey !== hostRepairErrorKey
            ? { onFixWithAi: () => void startHostRepairForThreadError() }
            : {})}
          fixingWithAi={
            hostRepairErrorKey !== null && hostRepairStartingErrorKey === hostRepairErrorKey
          }
        />
        {/* Main content area with optional plan sidebar */}
        <div className="flex min-h-0 min-w-0 flex-1">
          {/* Chat column */}
          <div data-chat-main-pane="true" className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            {providerAccountSwitch ? (
              <ProviderAccountSwitchOverlay
                state={providerAccountSwitch}
                provider={
                  providerStatuses.find(
                    (provider) => provider.instanceId === providerAccountSwitch.instanceId,
                  ) ?? null
                }
                cancelling={providerAccountSwitchCancelling}
                submittingCode={providerAccountSwitchSubmittingCode}
                onCancel={() => void cancelActiveProviderAccountSwitch()}
                onDismiss={dismissProviderAccountSwitch}
                onOpenAuthLink={openProviderAuthenticationLink}
                onRetry={() => {
                  const instanceId = providerAccountSwitch.instanceId;
                  setProviderAccountSwitch(null);
                  requestProviderAccountSwitch(instanceId);
                }}
                onSubmitAuthCode={submitActiveProviderAuthenticationCode}
              />
            ) : null}
            {/* Provider status overlays the timeline without changing its content height. */}
            <div className="pointer-events-none absolute inset-x-0 top-0 z-20">
              <ProviderStatusBanner
                status={visibleProviderStatus}
                onDismiss={() => setDismissedProviderStatusBannerKey(providerStatusBannerKey)}
              />
            </div>
            {providerUsagePlacement === "draft-pane-top" ? (
              <ProviderUsagePlacementRow
                placement={providerUsagePlacement}
                {...(terminalMainSurfaceActive ? { className: "pb-3" } : {})}
              >
                <ProviderUsageBar
                  environmentId={environmentId}
                  providers={providerStatuses}
                  activities={activeThread.activities}
                  selectedModelSelection={providerUsageModelSelection}
                  detailsSide={providerUsageDetailsSide(true)}
                  onRefreshProvider={refreshProviderUsage}
                  onSwitchUser={requestProviderAccountSwitch}
                  onUseReset={redeemProviderUsageReset}
                />
              </ProviderUsagePlacementRow>
            ) : null}
            {terminalMainSurfaceActive && activeThreadRef ? (
              // Terminal mode: the thread's main column is the multi-pane
              // terminal workspace instead of the chat timeline + composer.
              <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                <PersistentThreadTerminalDrawer
                  key={`main:${activeThreadKey ?? ""}`}
                  threadRef={activeThreadRef}
                  threadId={activeThreadRef.threadId}
                  visible
                  paneLayout={terminalFullscreen ? "tabs" : "split"}
                  fullscreen={terminalFullscreen}
                  // A phone has nowhere to toggle to, so the control is not
                  // offered: its only possible effect is to break the layout.
                  {...(phoneTerminalLayout
                    ? {}
                    : {
                        onToggleFullscreen: () =>
                          storeSetTerminalFullscreen(activeThreadRef, !terminalFullscreen),
                      })}
                  launchContext={activeTerminalLaunchContext ?? null}
                  focusRequestId={terminalFocusRequestId}
                  splitShortcutLabel={splitTerminalShortcutLabel ?? undefined}
                  splitVerticalShortcutLabel={splitTerminalVerticalShortcutLabel ?? undefined}
                  newShortcutLabel={newTerminalShortcutLabel ?? undefined}
                  closeShortcutLabel={closeTerminalShortcutLabel ?? undefined}
                  keybindings={keybindings}
                  onAddTerminalContext={addTerminalContextToDraft}
                />
                {visiblePushToTalkStatus ? (
                  // No composer rail exists in terminal mode, so the voice
                  // status floats bottom-center above the workspace.
                  <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center">
                    <VoiceTranscriptionStatusChip
                      status={visiblePushToTalkStatus}
                      label={visiblePushToTalkLabel}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
            {/* Messages Wrapper */}
            <div
              aria-busy={showThreadSyncOverlay}
              data-chat-file-drop-active={isFileDragOverTimeline ? "true" : "false"}
              className={cn(
                "relative flex min-h-0 flex-1 flex-col",
                terminalMainSurfaceActive && "hidden",
                isFileDragOverTimeline && "ring-1 ring-inset ring-primary/70",
              )}
              onDragEnter={onTimelineFileDragEnter}
              onDragLeave={onTimelineFileDragLeave}
              onDragOver={onTimelineFileDragOver}
              onDrop={onTimelineFileDrop}
            >
              {/* Messages — LegendList handles virtualization and scrolling internally */}
              <MessagesTimeline
                key={routeThreadKey}
                environmentUnreachable={threadEnvironmentUnreachable}
                deliveredMessageIds={deliveredMessageIds}
                pendingMessageIds={pendingMessageIds}
                deliveryProviderName={deliveryProvider.name}
                deliveryReceiptsExpected={deliveryProvider.receiptsExpected}
                unsentMessage={unsentMessage}
                sendingAgainMessageIds={sendingNowIdSet}
                onSendAgain={sendUnsentMessageAgain}
                newestUserMessageId={newestUserMessageId}
                // Whenever the composer offers a stop button, the transcript has
                // to say something is running. Interruptible pending work — a
                // turn being recovered — is not `running`, so the timeline stayed
                // silent while the composer showed a red stop: a state that
                // looked active but never said "Working" (reported 2026-09-01).
                isWorking={timelineIsWorking || isThreadInterruptible}
                pendingContinuation={
                  visibleAgentAutoResumePending || visibleStartupAutoResumePending
                }
                workingStatusLabel={
                  usageGuardPaused
                    ? "Waiting for credits"
                    : steerWaitingBehindSubagent
                      ? "Finishing subagent before your message"
                      : compactionOperationStage === "compacting"
                        ? "Compacting context"
                        : compactionOperationStage === "continuing"
                          ? "Continuing conversation"
                          : visibleStartupAutoResumePending
                            ? "Auto-resuming thread"
                            : visibleAgentAutoResumePending
                              ? "Agent auto-resuming"
                              : !timelineIsWorking && isThreadInterruptible
                                ? // Reached only via the branch above: nothing is
                                  // streaming, but a queued send is being started
                                  // or an interrupted turn recovered. "Working for
                                  // X" would be wrong — no work is going out — so
                                  // say what it is.
                                  (describePendingTurnStart({
                                    pendingWork: serverPendingWork,
                                    latestTurnState: activeLatestTurn?.state ?? null,
                                    sessionProviderInstanceId:
                                      activeThread.session?.providerInstanceId ?? null,
                                    requestedProviderInstanceId:
                                      activeThread.modelSelection.instanceId,
                                    providerName: deliveryProvider.requestedName,
                                  }) ?? "Recovering the interrupted response")
                                : // A turn that happens to have compacted earlier is just a
                                  // turn; labelling the rest of it "Continuing after
                                  // compaction" pins an implementation detail to the status
                                  // line long after it stopped being what is happening. The
                                  // default elapsed "Working for X" is the honest read.
                                  null
                }
                activeTurnInProgress={timelineIsWorking || !latestTurnSettled}
                activeTurnStartedAt={timelineWorkStartedAt}
                listRef={legendListRef}
                timelineEntries={timelineEntries}
                latestTurn={activeLatestTurn}
                runningTurnId={
                  activeThread.session?.status === "running"
                    ? activeThread.session.activeTurnId
                    : null
                }
                turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
                turnFileReferences={turnFileReferences}
                activeThreadEnvironmentId={activeThread.environmentId}
                routeThreadKey={routeThreadKey}
                onOpenTurnDiff={onOpenTurnDiff}
                revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
                onRevertUserMessage={onRevertUserMessage}
                isRevertingCheckpoint={isRevertingCheckpoint}
                onImageExpand={onExpandTimelineImage}
                markdownCwd={gitCwd ?? undefined}
                resolvedTheme={resolvedTheme}
                timestampFormat={timestampFormat}
                workspaceRoot={activeWorkspaceRoot}
                skills={activeProviderStatus?.skills ?? EMPTY_PROVIDER_SKILLS}
                slashCommands={activeProviderStatus?.slashCommands ?? EMPTY_PROVIDER_SLASH_COMMANDS}
                followEnd={timelineLiveFollowEnabled}
                initialScrollAtEnd={restoredTimelineScroll?.followEnd ?? true}
                initialScrollOffset={
                  restoredTimelineScroll?.followEnd === false
                    ? restoredTimelineScroll.scrollOffset
                    : null
                }
                onIsAtEndChange={onIsAtEndChange}
                onManualNavigation={cancelTimelineLiveFollowForUserNavigation}
                onScrollStateChange={onTimelineScrollStateChange}
                hideEmptyPlaceholder={isDraftHeroState || threadDetailLoading}
                topFadeEnabled={!hasTimelineTopBanner}
                onCompactAndContinue={onCompactAndContinue}
                isCompactAndContinueBusy={isCompactAndContinueBusy}
                resumableAssistantMessageId={resumableAssistantMessageId}
                resumableRuntimeErrorActivityId={resumableRuntimeErrorActivityId}
                onResumeIncompleteTurn={onResumeIncompleteTurn}
                isResumeIncompleteTurnBusy={isResumeIncompleteTurnBusy}
                isResumeIncompleteTurnDisabled={activeEnvironmentUnavailable}
                inlineNotice={inlineTimelineNotice}
                hasOlderHistory={hasOlderThreadHistory}
                olderHistoryMessageCount={olderHistoryMessageCount}
                olderHistoryLoading={olderHistoryLoading}
                onLoadOlderHistory={loadOlderThreadHistory}
              />

              {showThreadSyncOverlay && threadSyncPhase ? (
                <ThreadSyncOverlay phase={threadSyncPhase} />
              ) : null}

              {/* scroll to end pill — shown when user has scrolled away from the live edge */}
              {showScrollToBottom && !showThreadSyncOverlay && (
                <div className="pointer-events-none absolute bottom-1 left-1/2 z-30 flex -translate-x-1/2 justify-center py-1.5">
                  <button
                    type="button"
                    aria-label="Scroll to end"
                    title="Scroll to end"
                    onClick={() => scrollToEnd(true)}
                    className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-muted-foreground text-xs  transition-colors hover:border-border hover:text-foreground hover:cursor-pointer"
                  >
                    <ChevronDownIcon className="size-3.5" />
                    Scroll to end
                  </button>
                </div>
              )}
            </div>

            {/* Input bar — centered hero while a draft has no messages, docked at the bottom otherwise */}
            <div
              ref={setComposerOverlayElement}
              data-chat-composer-overlay="true"
              data-chat-footer-layout={chatFooterLayout.mode}
              data-chat-footer-measured-height={composerOverlayHeight}
              data-chat-footer-reserved-inset={chatFooterLayout.timelineEndInset}
              data-chat-footer-keyboard-offset={phoneVisualViewportBottomInset}
              data-chat-composer-phone-focused={phoneComposerFocused ? "true" : "false"}
              data-chat-composer-viewport-inset={phoneVisualViewportBottomInset}
              className={cn(
                chatFooterLayout.mode === "draft-hero-overlay"
                  ? "pointer-events-none absolute inset-0 z-20 flex items-center"
                  : chatFooterLayout.mode === "draft-docked-overlay"
                    ? "pointer-events-none absolute inset-x-0 bottom-0 z-20 overscroll-none pt-1.5 sm:pt-2"
                    : "pointer-events-none relative z-20 shrink-0 overscroll-none pt-1.5 sm:pt-2",
                terminalMainSurfaceActive && "hidden",
              )}
              style={
                chatFooterLayout.bottomOffset > 0
                  ? { bottom: `${chatFooterLayout.bottomOffset}px` }
                  : chatFooterLayout.marginBottom > 0
                    ? { marginBottom: `${chatFooterLayout.marginBottom}px` }
                    : undefined
              }
            >
              <div
                ref={attachDraftHeroTransitionGroupRef}
                className="chat-composer-horizontal-inset w-full"
              >
                <ComposerStatusRail
                  voice={
                    visiblePushToTalkStatus ? (
                      <VoiceTranscriptionStatusChip
                        status={visiblePushToTalkStatus}
                        label={visiblePushToTalkLabel}
                      />
                    ) : null
                  }
                  usage={
                    providerUsagePlacement === "active-footer" ? (
                      <ProviderUsageBar
                        environmentId={environmentId}
                        providers={providerStatuses}
                        activities={activeThread.activities}
                        selectedModelSelection={providerUsageModelSelection}
                        detailsSide={providerUsageDetailsSide(false)}
                        onRefreshProvider={refreshProviderUsage}
                        onSwitchUser={requestProviderAccountSwitch}
                        onUseReset={redeemProviderUsageReset}
                      />
                    ) : null
                  }
                  actions={
                    activeSideChatActivity ||
                    activeTerminalActivity ||
                    outboxChipPhase !== "hidden" ? (
                      <>
                        {outboxChipPhase !== "hidden" ? (
                          <OfflineOutboxChip
                            phase={outboxChipPhase}
                            messages={outboxMessages}
                            timestampFormat={timestampFormat}
                            onRetry={(commandId) => resolveOutboxMessage(commandId, "retry")}
                            onDiscard={(commandId) => resolveOutboxMessage(commandId, "discard")}
                          />
                        ) : null}
                        {activeTerminalActivity ? (
                          <button
                            aria-label={`${activeTerminalActivity.count} ${activeTerminalActivity.count === 1 ? "terminal is" : "terminals are"} working. Open the terminal workspace.`}
                            className="chat-composer-status-chip pointer-events-auto flex items-center gap-1.5 rounded-full border border-gold-500/30 bg-background/95 px-2.5 py-1 text-xs font-medium text-gold-600  transition-colors hover:text-gold-500 dark:text-gold-400"
                            data-chat-composer-status-chip="terminals"
                            onClick={openWorkingTerminal}
                            title="Open a working terminal"
                            type="button"
                          >
                            <TerminalSessionIcon className="size-3" working />
                            <span aria-hidden className="tabular-nums">
                              {activeTerminalActivity.count}
                            </span>
                          </button>
                        ) : null}
                        {activeSideChatActivity ? (
                          <button
                            aria-label={`${activeSideChatActivity.count} side ${activeSideChatActivity.count === 1 ? "chat is" : "chats are"} working. Open the first working side chat.`}
                            className="chat-composer-status-chip pointer-events-auto flex items-center gap-1.5 rounded-full border border-gold-500/30 bg-background/95 px-2.5 py-1 text-xs font-medium text-gold-600  transition-colors hover:text-gold-500 dark:text-gold-400"
                            data-chat-composer-status-chip="side-chats"
                            onClick={openWorkingSideChat}
                            title="Open a working side chat"
                            type="button"
                          >
                            <SideChatSessionIcon className="size-3" working />
                            <span aria-hidden className="tabular-nums">
                              {activeSideChatActivity.count}
                            </span>
                          </button>
                        ) : null}
                      </>
                    ) : null
                  }
                />
                <div className="pointer-events-auto relative z-10">
                  {isDraftHeroState ? (
                    <div className="absolute inset-x-0 bottom-full z-0">
                      <div
                        className="pb-8"
                        style={
                          forceExpandedMobileComposer
                            ? {
                                viewTransitionName: MOBILE_DRAFT_HEADLINE_VIEW_TRANSITION_NAME,
                              }
                            : undefined
                        }
                      >
                        <DraftHeroHeadline
                          activeProjectRef={activeProjectRef}
                          activeProjectTitle={activeProject?.title ?? null}
                        />
                        {routeThreadRef ? (
                          <div className="pointer-events-auto mt-4 flex justify-center">
                            <div className="inline-flex items-center gap-0.5 rounded-full border border-border bg-background/80 p-0.5 text-xs">
                              <button
                                type="button"
                                className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3 py-1 text-foreground"
                                aria-pressed
                              >
                                <MessageSquareIcon className="size-3" />
                                Chat
                              </button>
                              <button
                                type="button"
                                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-muted-foreground transition-colors hover:text-foreground"
                                onClick={() => handleMainSurfaceChange("terminal")}
                              >
                                <TerminalSessionIcon
                                  className="size-3"
                                  working={activeTerminalActivity !== null}
                                />
                                Terminal
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                      <ComposerBannerStack className="relative z-0" items={composerBannerItems} />
                    </div>
                  ) : (
                    <ComposerBannerStack className="relative z-0" items={composerBannerItems} />
                  )}
                  {activeProject ? (
                    <ProjectFolderMissingBanner
                      environmentId={activeProject.environmentId}
                      project={activeProject}
                    />
                  ) : null}
                  {providerFailoverActive && providerFailoverNotice ? (
                    <ProviderFailoverBanner notice={providerFailoverNotice} />
                  ) : null}
                  {usageGuardPaused && usageGuardPauseNotice ? (
                    <UsageGuardPausedBanner
                      notice={usageGuardPauseNotice}
                      onResume={onResumeUsageGuard}
                      onCancel={() => {
                        void onInterrupt();
                      }}
                      onRefresh={() => {
                        void onRefreshUsageGuardReading();
                      }}
                      refreshing={usageGuardRefreshing}
                      resuming={usageGuardResuming}
                      selection={usageGuardEffortSelection}
                      provider={providerStatuses.find(
                        (provider) => provider.instanceId === usageGuardEffortSelection?.instanceId,
                      )}
                      onApplyEffort={onApplyUsageGuardEffort}
                    />
                  ) : null}
                  {waitingOnYouAttachment && activeThreadKey ? (
                    <WaitingOnYouComposerTag
                      attachment={waitingOnYouAttachment}
                      onDetach={() => detachWaitingOnYou(activeThreadKey)}
                    />
                  ) : null}
                  <div
                    className="relative"
                    style={
                      forceExpandedMobileComposer
                        ? { viewTransitionName: MOBILE_COMPOSER_VIEW_TRANSITION_NAME }
                        : undefined
                    }
                  >
                    <div
                      data-chat-composer-shell="true"
                      className={cn(
                        "chat-composer-glass-shell chat-composer-measure relative",
                        showComposerContextStrip && "chat-composer-glass-shell-with-context",
                      )}
                    >
                      <div className="chat-composer-glass-host relative z-10 w-full rounded-[22px]">
                        <div ref={attachDraftHeroComposerAnchorRef} className="relative z-10">
                          <ChatComposer
                            composerRef={composerRef}
                            composerDraftTarget={composerDraftTarget}
                            environmentId={environmentId}
                            routeKind={routeKind}
                            routeThreadRef={routeThreadRef}
                            draftId={draftId}
                            activeThreadId={activeThreadId}
                            activeThreadEnvironmentId={activeThread?.environmentId}
                            activeThread={activeThread}
                            isServerThread={isServerThread}
                            isLocalDraftThread={isLocalDraftThread}
                            forceExpandedOnMobile={forceExpandedMobileComposer && isDraftHeroState}
                            acceptUntargetedQuotes={!embeddedSideChat}
                            projectSelectionRequired={isLocalDraftThread && activeProject === null}
                            canReferenceLocalFiles={canReferenceLocalFiles}
                            phase={phase}
                            isInterruptible={isThreadInterruptible}
                            isConnecting={isConnecting}
                            isSendBusy={isSendBusy}
                            sendDisabledReason={resolveSendDisabledReason({
                              providerAuthenticationPaused: activeProviderAuthenticationPaused,
                              threadCatchingUp: threadCatchingUp && !activeThread,
                            })}
                            isPreparingWorktree={isPreparingWorktree}
                            pushToTalkStatus={visiblePushToTalkStatus}
                            pushToTalkDisabled={
                              !pushToTalkEnabledRef.current ||
                              pendingUserInputs.length > 0 ||
                              visiblePushToTalkStatus !== null
                            }
                            pushToTalkDisabledReason={
                              pendingUserInputs.length > 0 ? "Answer this question with text" : null
                            }
                            isApplyingSettings={isApplyingComposerSettings}
                            isInterrupting={isInterrupting}
                            hasQueuedSendNow={hasQueuedGrokMessages}
                            isPromotingQueued={isPromotingQueuedMessages}
                            environmentUnavailable={
                              canQueueLocalMessage ? null : activeEnvironmentUnavailableState
                            }
                            activePendingApproval={activePendingApproval}
                            pendingApprovals={pendingApprovals}
                            pendingUserInputs={pendingUserInputs}
                            activePendingProgress={activePendingProgress}
                            activePendingResolvedAnswers={activePendingResolvedAnswers}
                            activePendingIsResponding={activePendingIsResponding}
                            activePendingDraftAnswers={activePendingDraftAnswers}
                            activePendingQuestionIndex={activePendingQuestionIndex}
                            respondingRequestIds={respondingRequestIds}
                            respondingUserInputRequestIds={respondingUserInputRequestIds}
                            showPlanFollowUpPrompt={showPlanFollowUpPrompt}
                            activeProposedPlan={activeProposedPlan}
                            activePlan={activePlan as { turnId?: TurnId } | null}
                            sidebarProposedPlan={sidebarProposedPlan as { turnId?: TurnId } | null}
                            planSidebarLabel={planSidebarLabel}
                            planSidebarOpen={planSidebarOpen}
                            runtimeMode={runtimeMode}
                            interactionMode={interactionMode}
                            lockedProvider={lockedProvider}
                            providerStatuses={providerStatuses as ServerProvider[]}
                            activeProjectDefaultModelSelection={
                              activeProject?.defaultModelSelection
                            }
                            activeThreadModelSelection={activeThread?.modelSelection}
                            activeThreadActivities={activeThread?.activities}
                            persistModelSelectionAsDefault={persistComposerModelDefaults}
                            resolvedTheme={resolvedTheme}
                            settings={settings}
                            keybindings={keybindings}
                            terminalOpen={terminalMainSurfaceActive}
                            gitCwd={gitCwd}
                            promptRef={promptRef}
                            composerImagesRef={composerImagesRef}
                            composerTerminalContextsRef={composerTerminalContextsRef}
                            composerElementContextsRef={composerElementContextsRef}
                            onSend={onSend}
                            onPushToTalkStart={() => pushToTalkStartRef.current()}
                            onPushToTalkStop={() => pushToTalkStopRef.current()}
                            activeProviderAccountSwitch={providerAccountSwitch}
                            onSwitchProviderAccount={requestProviderAccountSwitch}
                            onApplySettings={onApplyComposerSettings}
                            onPromoteQueued={() => void promoteQueuedMessagesNow()}
                            onInterrupt={onInterrupt}
                            onImplementPlanInNewThread={onImplementPlanInNewThread}
                            onRespondToApproval={onRespondToApproval}
                            onSelectActivePendingUserInputOption={
                              onSelectActivePendingUserInputOption
                            }
                            onAdvanceActivePendingUserInput={onAdvanceActivePendingUserInput}
                            onPreviousActivePendingUserInputQuestion={
                              onPreviousActivePendingUserInputQuestion
                            }
                            onChangeActivePendingUserInputCustomAnswer={
                              onChangeActivePendingUserInputCustomAnswer
                            }
                            onProviderModelSelect={onProviderModelSelect}
                            toggleInteractionMode={toggleInteractionMode}
                            setInteractionMode={handleInteractionModeChange}
                            handleRuntimeModeChange={handleRuntimeModeChange}
                            handleInteractionModeChange={handleInteractionModeChange}
                            togglePlanSidebar={togglePlanSidebar}
                            scheduleComposerFocus={scheduleComposerFocus}
                            setThreadError={setThreadError}
                            onExpandImage={onExpandTimelineImage}
                          />
                        </div>
                      </div>
                      <div className="min-h-0">
                        <div
                          data-terminal-open={terminalMainSurfaceActive ? "true" : undefined}
                          className="relative z-0"
                        >
                          {showComposerContextStrip && (
                            <div className="pointer-events-auto">
                              <BranchToolbar
                                environmentId={activeThread.environmentId}
                                threadId={activeThread.id}
                                {...(routeKind === "draft" && draftId ? { draftId } : {})}
                                onEnvModeChange={onEnvModeChange}
                                startFromOrigin={startFromOrigin}
                                onStartFromOriginChange={onStartFromOriginChange}
                                {...(canOverrideServerThreadEnvMode
                                  ? { effectiveEnvModeOverride: envMode }
                                  : {})}
                                {...(canOverrideServerThreadEnvMode
                                  ? {
                                      activeThreadBranchOverride: activeThreadBranch,
                                      onActiveThreadBranchOverrideChange:
                                        setPendingServerThreadBranch,
                                    }
                                  : {})}
                                envLocked={envLocked}
                                onComposerFocusRequest={scheduleComposerFocus}
                                {...(canCheckoutPullRequestIntoThread
                                  ? { onCheckoutPullRequestRequest: openPullRequestDialog }
                                  : {})}
                                {...(hasMultipleEnvironments ? { onEnvironmentChange } : {})}
                                availableEnvironments={logicalProjectEnvironments}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                    {heldSendPanel}
                    {providerTaskPanel}
                    <div
                      aria-hidden
                      className="h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]"
                    />
                  </div>
                </div>
              </div>
            </div>

            {activeThreadRef && activePreviewMiniPlayer ? (
              <ThreadPreviewMiniPlayer
                key={`${activeThreadKey}:${activePreviewMiniPlayer.tabId}`}
                threadRef={activeThreadRef}
                tabId={activePreviewMiniPlayer.tabId}
                bottomInset={isDraftHeroState ? 0 : floatingFooterBottomInset}
                activePanelTabId={
                  previewPanelOpen && activeRightPanelSurface?.kind === "preview"
                    ? activeRightPanelSurface.resourceId
                    : null
                }
              />
            ) : null}

            {pendingProviderAccountSwitchInstanceId !== null &&
            providerStatuses.find(
              (provider) => provider.instanceId === pendingProviderAccountSwitchInstanceId,
            )?.driver === "deepcode" ? (
              <ProviderApiKeyAccountDialog
                environmentId={environmentId}
                instanceId={pendingProviderAccountSwitchInstanceId}
                onClose={() => setPendingProviderAccountSwitchInstanceId(null)}
              />
            ) : (
              <ProviderAccountSwitchConfirmation
                open={pendingProviderAccountSwitchInstanceId !== null}
                environmentLabel={activeEnvironment?.label ?? null}
                authenticationPaused={activeProviderAuthenticationPaused}
                onClose={() => setPendingProviderAccountSwitchInstanceId(null)}
                onConfirm={() => {
                  const instanceId = pendingProviderAccountSwitchInstanceId;
                  setPendingProviderAccountSwitchInstanceId(null);
                  if (instanceId) void beginProviderAccountSwitch(instanceId);
                }}
              />
            )}

            <AlertDialog
              open={pendingSideChatArchive !== null}
              onOpenChange={(open) => {
                if (!open && archivingSideChatThreadId === null) {
                  setPendingSideChatArchives([]);
                }
              }}
            >
              <AlertDialogPopup data-side-chat-archive-confirmation="true">
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Archive side chat
                    {pendingSideChatArchive ? ` “${pendingSideChatArchive.surface.title}”` : ""}?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    This closes the side-chat tab and moves its conversation to Archived. You can
                    restore it later, so its messages and work are not lost.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <Button
                    variant="outline"
                    disabled={archivingSideChatThreadId !== null}
                    onClick={() => setPendingSideChatArchives([])}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="default"
                    disabled={archivingSideChatThreadId !== null}
                    onClick={confirmSideChatArchive}
                  >
                    {archivingSideChatThreadId !== null ? "Archiving…" : "Archive side chat"}
                  </Button>
                </AlertDialogFooter>
              </AlertDialogPopup>
            </AlertDialog>

            <AlertDialog open={branchRestoreConfirmOpen} onOpenChange={setBranchRestoreConfirmOpen}>
              <AlertDialogPopup>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Switch to{" "}
                    <code className="font-medium">
                      {localCheckoutBranchMismatch?.threadBranch ?? ""}
                    </code>
                    ?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    You have uncommitted changes. They'll carry over to the other branch, or block
                    the switch if they conflict.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
                  <Button
                    variant="default"
                    onClick={() => {
                      setBranchRestoreConfirmOpen(false);
                      void handleSwitchCheckoutToThread();
                    }}
                  >
                    Switch branch
                  </Button>
                </AlertDialogFooter>
              </AlertDialogPopup>
            </AlertDialog>

            {pullRequestDialogState ? (
              <PullRequestThreadDialog
                key={pullRequestDialogState.key}
                open
                environmentId={activeThread.environmentId}
                threadId={activeThread.id}
                cwd={activeProject?.workspaceRoot ?? null}
                initialReference={pullRequestDialogState.initialReference}
                onOpenChange={(open) => {
                  if (!open) {
                    closePullRequestDialog();
                  }
                }}
                onPrepared={handlePreparedPullRequestThread}
              />
            ) : null}
          </div>
          {/* end chat column */}
        </div>
        {/* end horizontal flex container */}
      </div>

      {!shouldUsePlanSidebarSheet && visibleRightPanelOpen && activeThreadRef ? (
        <RightPanelTabs
          mode="inline"
          maximized={rightPanelMaximized}
          layoutControls={panelLayoutControls}
          surfaces={rightPanelState.surfaces}
          activeSurfaceId={activeRightPanelSurface?.id ?? null}
          pendingSurfaceIds={pendingFileSurfaceIds}
          previewSessions={activePreviewState.sessions}
          previewControllerByTabId={previewControllerByTabId}
          floatingPreviewTabIds={floatingPreviewTabIds}
          terminalLabelsById={activeTerminalLabelsById}
          sideChatStatusByThreadId={sideChatStatusByThreadId}
          onActivate={activateRightPanelSurface}
          onCloseSurface={closeRightPanelSurface}
          onCloseOtherSurfaces={closeOtherRightPanelSurfaces}
          onCloseSurfacesToRight={closeRightPanelSurfacesToRight}
          onCloseAllSurfaces={closeAllRightPanelSurfaces}
          onReorderSurface={reorderRightPanelSurface}
          onRenameSurface={renameRightPanelSurface}
          onCopyFilePath={copyRightPanelFilePath}
          onCopySideChatId={copySideChatId}
          onAddBrowser={createBrowserSurface}
          onAddTerminal={addTerminalSurface}
          onAddDiff={addDiffSurface}
          onAddFiles={addFilesSurface}
          onAddSideChat={addSideChatSurface}
          browserAvailable={isPreviewSupportedInRuntime()}
          diffAvailable={isServerThread && isGitRepo}
          filesAvailable={activeProject !== null}
          sideChatAvailable={sideChatAvailable}
          agentSurfaces={agentSurfaces}
          artifactShelf={agentSurfaces ? undefined : artifactShelf}
          artifactMenu={agentSurfaces ? undefined : artifactMenu}
        >
          {rightPanelContent}
        </RightPanelTabs>
      ) : null}
      {shouldUsePlanSidebarSheet && visibleRightPanelOpen && activeThreadRef ? (
        <RightPanelSheet open onClose={planSidebarOpen ? closePlanSidebar : closePreviewPanel}>
          <RightPanelTabs
            mode="sheet"
            layoutControls={panelToggleControls}
            surfaces={rightPanelState.surfaces}
            activeSurfaceId={activeRightPanelSurface?.id ?? null}
            pendingSurfaceIds={pendingFileSurfaceIds}
            previewSessions={activePreviewState.sessions}
            previewControllerByTabId={previewControllerByTabId}
            floatingPreviewTabIds={floatingPreviewTabIds}
            terminalLabelsById={activeTerminalLabelsById}
            sideChatStatusByThreadId={sideChatStatusByThreadId}
            onActivate={activateRightPanelSurface}
            onCloseSurface={closeRightPanelSurface}
            onCloseOtherSurfaces={closeOtherRightPanelSurfaces}
            onCloseSurfacesToRight={closeRightPanelSurfacesToRight}
            onCloseAllSurfaces={closeAllRightPanelSurfaces}
            onReorderSurface={reorderRightPanelSurface}
            onRenameSurface={renameRightPanelSurface}
            onCopyFilePath={copyRightPanelFilePath}
            onCopySideChatId={copySideChatId}
            onAddBrowser={createBrowserSurface}
            onAddTerminal={addTerminalSurface}
            onAddDiff={addDiffSurface}
            onAddFiles={addFilesSurface}
            onAddSideChat={addSideChatSurface}
            browserAvailable={isPreviewSupportedInRuntime()}
            diffAvailable={isServerThread && isGitRepo}
            filesAvailable={activeProject !== null}
            sideChatAvailable={sideChatAvailable}
            agentSurfaces={agentSurfaces}
            artifactShelf={agentSurfaces ? undefined : artifactShelf}
            artifactMenu={agentSurfaces ? undefined : artifactMenu}
          >
            {rightPanelContent}
          </RightPanelTabs>
        </RightPanelSheet>
      ) : null}

      {expandedImage && (
        <ExpandedImageDialog
          key={`${expandedImage.images[expandedImage.index]?.src ?? "image"}:${expandedImage.index}`}
          preview={expandedImage}
          onClose={closeExpandedImage}
          fullScreenMobile={isPhonePortraitViewport}
        />
      )}
    </div>
  );

  return (
    <ExpandedImagePreviewProvider
      fullScreenMobile={isPhonePortraitViewport}
      onOpen={onExpandTimelineImage}
    >
      {activeThreadRef && isPreviewSupportedInRuntime() ? (
        <PreviewSessionHydrator threadRef={activeThreadRef} />
      ) : null}
      {activeThreadRef ? (
        <PreviewDownloadDirectorySync
          environmentId={activeThreadRef.environmentId}
          threadId={activeThreadRef.threadId}
          browserProfileThreadId={activeThread?.browserProfileThreadId ?? undefined}
          cwd={gitStatusCwd}
        />
      ) : null}
      {/* Keyed by thread so arriving at a thread with no tabs from one with
          tabs does not read as a close. Agent panels keep the empty chooser
          available after the last tab closes. */}
      {activeThreadRef && !agentSurfaces ? (
        <RightPanelAutoCollapseOnEmpty
          key={scopedThreadKey(activeThreadRef)}
          surfaceCount={rightPanelState.surfaces.length}
          panelOpen={rightPanelOpen}
          onCollapse={closePreviewPanel}
        />
      ) : null}
      {chatLayout}
    </ExpandedImagePreviewProvider>
  );
}

export default function ChatView(props: ChatViewProps) {
  return (
    <DiffWorkerPoolProvider>
      <ChatViewContent {...props} />
    </DiffWorkerPoolProvider>
  );
}
