import type {
  ApprovalRequestId,
  EnvironmentId,
  ModelSelection,
  PreviewAnnotationPayload,
  ProviderAccountSwitchState,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ResolvedKeybindingsConfig,
  RuntimeMode,
  ScopedThreadRef,
  ServerProvider,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "@t3tools/contracts";
import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { resolveOsFilePath } from "../../lib/terminalFileDrop";
import { isActionApprovalQuestion } from "@t3tools/shared/actionApproval";
import { createModelSelection, normalizeModelSlug } from "@t3tools/shared/model";
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  clampCollapsedComposerCursor,
  type ComposerTrigger,
  classifyComposerFileIntake,
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  isComposerSubmitBlocked,
  isEnabledComposerSubmitButton,
  replaceTextRange,
  shouldSubmitComposerOnEnter,
} from "../../composer-logic";
import {
  resolveVoiceTranscriptInputUpdate,
  type VoiceTranscriptInputTarget,
} from "../../pushToTalkTranscription";
import { deriveComposerSendState, readFileAsDataUrl } from "../ChatView.logic";
import {
  dataTransferHasComposerMention,
  makeComposerMentionDragHandlers,
} from "./composerMentionDrag";
import {
  type ComposerImageAttachment,
  type DraftId,
  type PersistedComposerImageAttachment,
  hydrateImagesFromPersisted,
  useComposerDraftStore,
  useComposerThreadDraft,
  useEffectiveComposerModelState,
} from "../../composerDraftStore";
import {
  MAX_STASH_ENTRIES,
  partitionStashAttachments,
  usePromptStashStore,
  type PromptStashEntry,
} from "../../promptStashStore";
import { ComposerStashBadge } from "./ComposerStashBadge";
import { ComposerStashMenu } from "./ComposerStashMenu";
import { revertComposerSettingsToThread } from "./composerSettingsRevert";
import { compressImageForStash } from "../../lib/stashImageCompression";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { getTerminalFocusOwner } from "../../lib/terminalFocus";
import { resolveShortcutCommand } from "../../keybindings";
import {
  type TerminalContextDraft,
  type TerminalContextSelection,
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  insertInlineTerminalContextPlaceholder,
  removeInlineTerminalContextPlaceholder,
} from "../../lib/terminalContext";
import { useComposerPathSearch } from "../../lib/composerPathSearchState";
import { type ElementContextDraft } from "../../lib/elementContext";
import { ComposerPendingElementContexts } from "./ComposerPendingElementContexts";
import { ComposerPendingReviewComments } from "./ComposerPendingReviewComments";
import { ComposerPreviewAnnotationCards } from "./ComposerPreviewAnnotationCards";
import { ComposerEmojiPicker } from "./ComposerEmojiPicker";
import {
  type ComposerFooterLayoutMode,
  resolveComposerFooterLayoutMode,
  shouldUseCompactComposerPrimaryActions,
} from "../composerFooterLayout";
import { type ComposerPromptEditorHandle, ComposerPromptEditor } from "../ComposerPromptEditor";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { type ComposerCommandItem, ComposerCommandMenu } from "./ComposerCommandMenu";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { ComposerPlanFollowUpBanner } from "./ComposerPlanFollowUpBanner";
import { ProviderAccountSwitcher } from "./ProviderAccountSwitcher";
import { ComposerControl, ComposerControlIcon, ComposerSelectControl } from "./ComposerControl";
import { resolveComposerMenuActiveItemId } from "./composerMenuHighlight";
import { searchSlashCommandItems } from "./composerSlashCommandSearch";
import {
  getComposerPromptInjectionState,
  getComposerProviderState,
  renderProviderTraitsMenuContent,
  renderProviderTraitsPicker,
} from "./composerProviderState";
import {
  shouldCollapseMobileComposer,
  shouldSendComposerWhileProcessing,
} from "./mobileComposerPresentation";
import {
  discardComposerTransfer,
  hasPersistedComposerTransfer,
  hasTransferableComposerContent,
  persistComposerTransfer,
  planComposerPaste,
  readClipboardImageFiles,
  readComposerTransferFromClipboard,
  resolveComposerTransferFromClipboard,
  stageComposerTransfer,
  writeComposerTransferToClipboard,
} from "../../composerTransferClipboard";
import { installMobileComposerTouchBoundary } from "./mobileComposerInteraction";
import { shouldDismissMobileKeyboardOnSubmit } from "./mobileComposerViewport";
import { ContextWindowMeter } from "./ContextWindowMeter";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";
import { basenameOfPath } from "../../pierre-icons";
import { cn, randomUUID } from "~/lib/utils";
import { Separator } from "../ui/separator";

function ComposerCommandMenuLayer(props: { anchor: HTMLElement | null; children: ReactNode }) {
  const [position, setPosition] = useState<{
    bottom: number;
    left: number;
    maxHeight: number;
    width: number;
  } | null>(null);

  useLayoutEffect(() => {
    const anchor = props.anchor;
    if (!anchor) {
      setPosition(null);
      return;
    }

    const updatePosition = () => {
      const rect = anchor.getBoundingClientRect();
      setPosition({
        bottom: window.innerHeight - rect.top + 8,
        left: rect.left,
        maxHeight: Math.max(96, rect.top - 24),
        width: rect.width,
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updatePosition);
    observer?.observe(anchor);

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [props.anchor]);

  if (!position) return null;

  return createPortal(
    <div
      className="pointer-events-auto fixed z-[70]"
      style={{
        bottom: position.bottom,
        left: position.left,
        maxHeight: position.maxHeight,
        width: position.width,
      }}
    >
      {props.children}
    </div>,
    document.body,
  );
}
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Select, SelectItem, SelectPopup, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { CircleAlertIcon, ListTodoIcon, ScissorsIcon, XIcon } from "lucide-react";
import { proposedPlanTitle } from "../../proposedPlan";
import { getProviderDisplayName, getProviderInteractionModeToggle } from "../../providerModels";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  NO_PROVIDER_MODEL_SELECTION,
  resolveProviderDriverKindForInstanceSelection,
  resolveSelectableProviderInstanceEntry,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { type AppModelOption, getAppModelOptionsForInstance } from "../../modelSelection";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import type { SessionPhase, Thread } from "../../types";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";
import type { PendingApproval, PendingUserInput } from "../../session-logic";
import {
  deriveLatestContextWindowSnapshot,
  formatProviderDisplayName,
} from "../../lib/contextWindow";
import { providerSupportsConfigurableAutoCompaction } from "./ContextWindowMeter";
import { formatProviderSkillDisplayName } from "../../providerSkillPresentation";
import { searchProviderSkills } from "../../providerSkillSearch";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import type { ReviewCommentContext } from "../../reviewCommentContext";
import { buildQuotedPrompt, useComposerQuoteStore } from "../../composerQuote";
import { interactionModeConfig, interactionModeOptions } from "./interactionModes";
import { runtimeModeConfig, runtimeModeDangerClasses, runtimeModeOptions } from "./runtimeModes";

const COMPOSER_FLOATING_LAYER_SELECTOR = [
  '[data-slot="popover-popup"]',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
].join(",");

const extendReplacementRangeForTrailingSpace = (
  text: string,
  rangeEnd: number,
  replacement: string,
): number => {
  if (!replacement.endsWith(" ")) {
    return rangeEnd;
  }
  return text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
};

const syncTerminalContextsByIds = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): TerminalContextDraft[] => {
  const contextsById = new Map(contexts.map((context) => [context.id, context]));
  return ids.flatMap((id) => {
    const context = contextsById.get(id);
    return context ? [context] : [];
  });
};

const terminalContextIdListsEqual = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): boolean =>
  contexts.length === ids.length && contexts.every((context, index) => context.id === ids[index]);

function isInsideComposerFloatingLayer(element: Element): boolean {
  return element.closest(COMPOSER_FLOATING_LAYER_SELECTOR) !== null;
}

const ComposerFooterModeControls = memo(function ComposerFooterModeControls(props: {
  iconOnly: boolean;
  showInteractionModeToggle: boolean;
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  showPlanToggle: boolean;
  planSidebarLabel: string;
  planSidebarOpen: boolean;
  onInteractionModeChange: (mode: ProviderInteractionMode) => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  onTogglePlanSidebar: () => void;
}) {
  const runtimeModeOption = runtimeModeConfig[props.runtimeMode];
  const runtimeModeIsDangerous = runtimeModeOption.tone === "danger";
  const RuntimeModeIcon = runtimeModeOption.icon;
  const interactionModeOption = interactionModeConfig[props.interactionMode];
  const InteractionModeIcon = interactionModeOption.icon;
  const planSidebarTooltip = props.planSidebarOpen
    ? `Hide ${props.planSidebarLabel.toLowerCase()} sidebar`
    : `Show ${props.planSidebarLabel.toLowerCase()} sidebar`;

  // A picker rather than a cycling button: with more than two modes, clicking
  // to advance one step makes the current mode hard to predict and impossible
  // to jump between directly.
  const interactionModeToggle = props.showInteractionModeToggle ? (
    <>
      <Separator
        orientation="vertical"
        className={cn("mx-0.5 hidden h-4 sm:block", props.iconOnly && "sm:hidden")}
      />
      <Tooltip>
        <Select
          value={props.interactionMode}
          onValueChange={(value) => props.onInteractionModeChange(value!)}
        >
          <TooltipTrigger
            render={
              <ComposerSelectControl
                className={cn(
                  "font-medium",
                  props.iconOnly &&
                    "size-7 justify-center px-0 [&_[data-slot=select-icon]]:hidden [&_[data-slot=select-value]]:hidden",
                  props.interactionMode !== "default" &&
                    "bg-blue-500/10 text-blue-400 hover:bg-blue-500/15 hover:text-blue-300",
                )}
                aria-label="Interaction mode"
                data-chat-composer-control-display={props.iconOnly ? "icon" : "label"}
              />
            }
          >
            <ComposerControlIcon
              icon={InteractionModeIcon}
              className={
                props.interactionMode !== "default" ? "text-current opacity-100" : undefined
              }
            />
            <SelectValue>{interactionModeOption.label}</SelectValue>
          </TooltipTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {interactionModeOptions.map((mode) => {
              const option = interactionModeConfig[mode];
              const OptionIcon = option.icon;
              return (
                <SelectItem key={mode} value={mode} hideIndicator className="min-w-64 py-2">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="grid min-w-0 flex-1 gap-0.5">
                      <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                        <OptionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        {option.label}
                      </span>
                      <span className="text-muted-foreground text-xs leading-4">
                        {option.description}
                      </span>
                    </div>
                  </div>
                </SelectItem>
              );
            })}
          </SelectPopup>
        </Select>
        <TooltipPopup side="top">
          {props.iconOnly
            ? `${interactionModeOption.label}: ${interactionModeOption.description}`
            : interactionModeOption.description}
        </TooltipPopup>
      </Tooltip>
    </>
  ) : null;

  return (
    <>
      <Separator
        orientation="vertical"
        className={cn("mx-0.5 hidden h-4 sm:block", props.iconOnly && "sm:hidden")}
      />

      <Tooltip>
        <Select
          value={props.runtimeMode}
          onValueChange={(value) => props.onRuntimeModeChange(value!)}
        >
          <TooltipTrigger
            render={
              <ComposerSelectControl
                className={cn(
                  "font-medium",
                  props.iconOnly &&
                    "size-7 justify-center px-0 [&_[data-slot=select-icon]]:hidden [&_[data-slot=select-value]]:hidden",
                  runtimeModeIsDangerous && runtimeModeDangerClasses.control,
                )}
                aria-label="Runtime mode"
                data-chat-composer-control-display={props.iconOnly ? "icon" : "label"}
              />
            }
          >
            <ComposerControlIcon
              icon={RuntimeModeIcon}
              className={runtimeModeIsDangerous ? "text-current opacity-100" : undefined}
            />
            <SelectValue>{runtimeModeOption.label}</SelectValue>
          </TooltipTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {runtimeModeOptions.map((mode) => {
              const option = runtimeModeConfig[mode];
              const OptionIcon = option.icon;
              const optionIsDangerous = option.tone === "danger";
              return (
                <SelectItem
                  key={mode}
                  value={mode}
                  hideIndicator
                  className={cn(
                    "min-w-64 py-2",
                    optionIsDangerous && runtimeModeDangerClasses.item,
                  )}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="grid min-w-0 flex-1 gap-0.5">
                      <span
                        className={cn(
                          "inline-flex items-center gap-1.5 font-medium",
                          optionIsDangerous ? runtimeModeDangerClasses.label : "text-foreground",
                        )}
                      >
                        <OptionIcon
                          className={cn(
                            "size-3.5 shrink-0",
                            optionIsDangerous
                              ? runtimeModeDangerClasses.icon
                              : "text-muted-foreground",
                          )}
                        />
                        {option.label}
                      </span>
                      <span
                        className={cn(
                          "text-xs leading-4",
                          optionIsDangerous
                            ? runtimeModeDangerClasses.description
                            : "text-muted-foreground",
                        )}
                      >
                        {option.description}
                      </span>
                    </div>
                  </div>
                </SelectItem>
              );
            })}
          </SelectPopup>
        </Select>
        <TooltipPopup side="top">
          {props.iconOnly
            ? `${runtimeModeOption.label}: ${runtimeModeOption.description}`
            : runtimeModeOption.description}
        </TooltipPopup>
      </Tooltip>

      {interactionModeToggle}

      {props.showPlanToggle ? (
        <>
          <Separator
            orientation="vertical"
            className={cn("mx-0.5 hidden h-4 sm:block", props.iconOnly && "sm:hidden")}
          />
          <Tooltip>
            <TooltipTrigger
              render={
                <ComposerControl
                  className={cn(
                    "shrink-0 whitespace-nowrap",
                    props.iconOnly && "size-7 justify-center px-0",
                    props.planSidebarOpen
                      ? "bg-blue-500/10 text-blue-400 hover:bg-blue-500/15 hover:text-blue-300"
                      : "text-muted-foreground/70 hover:text-foreground/80",
                  )}
                  type="button"
                  onClick={props.onTogglePlanSidebar}
                  aria-label={planSidebarTooltip}
                  data-chat-composer-control-display={props.iconOnly ? "icon" : "label"}
                />
              }
            >
              <ComposerControlIcon
                icon={ListTodoIcon}
                className={props.planSidebarOpen ? "text-current opacity-100" : undefined}
              />
              <span className={props.iconOnly ? "sr-only" : "sr-only sm:not-sr-only"}>
                {props.planSidebarLabel}
              </span>
            </TooltipTrigger>
            <TooltipPopup side="top">{planSidebarTooltip}</TooltipPopup>
          </Tooltip>
        </>
      ) : null}
    </>
  );
});

const ComposerFooterPrimaryActions = memo(function ComposerFooterPrimaryActions(props: {
  compact: boolean;
  providers: ReadonlyArray<ServerProvider>;
  activeProviderInstanceId: ProviderInstanceId;
  activeProviderAccountSwitch: ProviderAccountSwitchState | null;
  activeContextWindow: ReturnType<typeof deriveLatestContextWindowSnapshot>;
  activeThreadProviderDisplayName: string | null;
  activeThreadSupportsConfigurableAutoCompaction: boolean;
  autoCompactionThresholdPercentage: UnifiedSettings["autoCompactionThresholdPercentage"];
  onAutoCompactionThresholdChange: (
    value: UnifiedSettings["autoCompactionThresholdPercentage"],
  ) => void;
  isPreparingWorktree: boolean;
  pendingAction: {
    questionIndex: number;
    isLastQuestion: boolean;
    canAdvance: boolean;
    isResponding: boolean;
    isComplete: boolean;
  } | null;
  isRunning: boolean;
  sendWhileRunning: boolean;
  showPlanFollowUpPrompt: boolean;
  promptHasText: boolean;
  isSendBusy: boolean;
  sendDisabledReason: string | null;
  isConnecting: boolean;
  isEnvironmentUnavailable: boolean;
  hasSendableContent: boolean;
  pushToTalkStatus: "recording" | "loading" | "transcribing" | null;
  pushToTalkDisabled: boolean;
  pushToTalkDisabledReason: string | null;
  pushToTalkAutoSend: boolean;
  settingsUpdateLabel: string | null;
  isApplyingSettings: boolean;
  isInterrupting: boolean;
  preserveComposerFocusOnPointerDown?: boolean;
  onPushToTalkStart: () => void;
  onPushToTalkStop: () => void;
  onApplySettings: () => void;
  onRevertSettings: () => void;
  onSwitchProviderAccount: (instanceId: ProviderInstanceId) => void;
  onPreviousPendingQuestion: () => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;
}) {
  return (
    <>
      {props.activeContextWindow ? (
        <ContextWindowMeter
          usage={props.activeContextWindow}
          providerDisplayName={props.activeThreadProviderDisplayName}
          configurableAutoCompaction={props.activeThreadSupportsConfigurableAutoCompaction}
          autoCompactionThresholdPercentage={props.autoCompactionThresholdPercentage}
          onAutoCompactionThresholdChange={props.onAutoCompactionThresholdChange}
          autoCompactionDisabledReason={
            props.isRunning ? "Finish the active turn to change this threshold." : null
          }
        />
      ) : null}
      {props.isPreparingWorktree ? (
        <span className="text-muted-foreground/70 text-xs">Preparing worktree...</span>
      ) : null}
      <ProviderAccountSwitcher
        providers={props.providers}
        activeInstanceId={props.activeProviderInstanceId}
        activeSwitch={props.activeProviderAccountSwitch}
        onSwitchUser={props.onSwitchProviderAccount}
      />
      <ComposerPrimaryActions
        compact={props.compact}
        pendingAction={props.pendingAction}
        isRunning={props.isRunning}
        sendWhileRunning={props.sendWhileRunning}
        showPlanFollowUpPrompt={props.showPlanFollowUpPrompt}
        promptHasText={props.promptHasText}
        isSendBusy={props.isSendBusy}
        sendDisabledReason={props.sendDisabledReason}
        isConnecting={props.isConnecting}
        isEnvironmentUnavailable={props.isEnvironmentUnavailable}
        isPreparingWorktree={props.isPreparingWorktree}
        hasSendableContent={props.hasSendableContent}
        pushToTalkStatus={props.pushToTalkStatus}
        pushToTalkDisabled={props.pushToTalkDisabled}
        pushToTalkDisabledReason={props.pushToTalkDisabledReason}
        pushToTalkAutoSend={props.pushToTalkAutoSend}
        settingsUpdateLabel={props.settingsUpdateLabel}
        isApplyingSettings={props.isApplyingSettings}
        isInterrupting={props.isInterrupting}
        preserveComposerFocusOnPointerDown={props.preserveComposerFocusOnPointerDown ?? false}
        onPushToTalkStart={props.onPushToTalkStart}
        onPushToTalkStop={props.onPushToTalkStop}
        onApplySettings={props.onApplySettings}
        onRevertSettings={props.onRevertSettings}
        onPreviousPendingQuestion={props.onPreviousPendingQuestion}
        onInterrupt={props.onInterrupt}
        onImplementPlanInNewThread={props.onImplementPlanInNewThread}
      />
    </>
  );
});

// --------------------------------------------------------------------------
// Handle exposed to ChatView
// --------------------------------------------------------------------------

export interface ChatComposerHandle {
  focusAtEnd: () => void;
  focusAt: (cursor: number) => void;
  insertTextAtEnd: (text: string, options?: { ensureLeadingBoundary?: boolean }) => boolean;
  applyVoiceTranscript: (transcript: string) => {
    readonly prompt: string;
    readonly target: VoiceTranscriptInputTarget;
  };
  openModelPicker: () => void;
  toggleModelPicker: () => void;
  isModelPickerOpen: () => boolean;
  readSnapshot: () => {
    value: string;
    cursor: number;
    expandedCursor: number;
    terminalContextIds: string[];
  };
  /** Reset composer cursor/trigger/highlight after external prompt mutations (e.g. onSend). */
  resetCursorState: (options?: {
    cursor?: number;
    prompt?: string;
    detectTrigger?: boolean;
  }) => void;
  /** Insert a terminal context from the terminal drawer. */
  addTerminalContext: (selection: TerminalContextSelection) => void;
  /** Get the current prompt/effort/model state for use in send. */
  getSendContext: () => {
    prompt: string;
    images: ComposerImageAttachment[];
    terminalContexts: TerminalContextDraft[];
    elementContexts: ElementContextDraft[];
    previewAnnotations: PreviewAnnotationPayload[];
    reviewComments: ReviewCommentContext[];
    selectedPromptEffort: string | null;
    selectedModelOptionsForDispatch: unknown;
    selectedModelSelection: ModelSelection;
    providerAvailable: boolean;
    selectedProvider: ProviderDriverKind;
    selectedModel: string;
    selectedProviderModels: ReadonlyArray<ServerProvider["models"][number]>;
  };
}

// --------------------------------------------------------------------------
// Props
// --------------------------------------------------------------------------

export interface ChatComposerProps {
  composerDraftTarget: ScopedThreadRef | DraftId;
  environmentId: EnvironmentId;
  routeKind: "server" | "draft";
  routeThreadRef: ScopedThreadRef;
  draftId: DraftId | null;

  // Thread context
  activeThreadId: ThreadId | null;
  activeThreadEnvironmentId: EnvironmentId | undefined;
  activeThread: Thread | undefined;
  isServerThread: boolean;
  isLocalDraftThread: boolean;
  forceExpandedOnMobile: boolean;
  projectSelectionRequired: boolean;

  // Session phase
  phase: SessionPhase;
  isInterruptible: boolean;
  isConnecting: boolean;
  isSendBusy: boolean;
  sendDisabledReason: string | null;
  isPreparingWorktree: boolean;
  pushToTalkStatus: "recording" | "loading" | "transcribing" | null;
  pushToTalkDisabled: boolean;
  pushToTalkDisabledReason: string | null;
  isApplyingSettings: boolean;
  isInterrupting: boolean;
  environmentUnavailable: {
    readonly label: string;
    readonly connection: EnvironmentConnectionPresentation;
  } | null;

  // Pending approvals / inputs
  activePendingApproval: PendingApproval | null;
  pendingApprovals: PendingApproval[];
  pendingUserInputs: PendingUserInput[];
  activePendingProgress: {
    questionIndex: number;
    isLastQuestion: boolean;
    canAdvance: boolean;
    customAnswer: string;
    activeQuestion: { id: string; multiSelect?: boolean | undefined } | null;
  } | null;
  activePendingResolvedAnswers: Record<string, unknown> | null;
  activePendingIsResponding: boolean;
  activePendingDraftAnswers: Record<string, PendingUserInputDraftAnswer>;
  activePendingQuestionIndex: number;
  respondingRequestIds: ApprovalRequestId[];
  respondingUserInputRequestIds: ApprovalRequestId[];

  // Plan
  showPlanFollowUpPrompt: boolean;
  activeProposedPlan: Thread["proposedPlans"][number] | null;
  activePlan: { turnId?: TurnId } | null;
  sidebarProposedPlan: { turnId?: TurnId } | null;
  planSidebarLabel: string;
  planSidebarOpen: boolean;

  // Mode
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;

  // Provider / model
  lockedProvider: ProviderDriverKind | null;
  providerStatuses: ServerProvider[];
  activeProjectDefaultModelSelection: ModelSelection | null | undefined;
  activeThreadModelSelection: ModelSelection | null | undefined;

  // Context window
  activeThreadActivities: Thread["activities"] | undefined;
  persistModelSelectionAsDefault: boolean;

  // Misc
  resolvedTheme: "light" | "dark";
  settings: UnifiedSettings;
  keybindings: ResolvedKeybindingsConfig;
  terminalOpen: boolean;
  gitCwd: string | null;

  // Refs the parent needs kept in sync
  promptRef: React.RefObject<string>;
  composerImagesRef: React.RefObject<ComposerImageAttachment[]>;
  composerTerminalContextsRef: React.RefObject<TerminalContextDraft[]>;
  composerElementContextsRef: React.RefObject<ElementContextDraft[]>;
  composerRef: React.RefObject<ChatComposerHandle | null>;

  // Callbacks
  onSend: (e?: { preventDefault: () => void }) => void;
  onPushToTalkStart: () => void;
  onPushToTalkStop: () => void;
  activeProviderAccountSwitch: ProviderAccountSwitchState | null;
  onSwitchProviderAccount: (instanceId: ProviderInstanceId) => void;
  onApplySettings: (description: string) => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
  onSelectActivePendingUserInputOption: (questionId: string, optionLabel: string) => void;
  onAdvanceActivePendingUserInput: () => void;
  onPreviousActivePendingUserInputQuestion: () => void;
  onChangeActivePendingUserInputCustomAnswer: (
    questionId: string,
    value: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
  ) => void;

  onProviderModelSelect: (instanceId: ProviderInstanceId, model: string) => void;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  toggleInteractionMode: () => void;
  setInteractionMode: (mode: ProviderInteractionMode) => void;
  handleRuntimeModeChange: (mode: RuntimeMode) => void;
  handleInteractionModeChange: (mode: ProviderInteractionMode) => void;
  togglePlanSidebar: () => void;

  focusComposer: () => void;
  scheduleComposerFocus: () => void;
  setThreadError: (threadId: ThreadId | null, error: string | null) => void;
  onExpandImage: (preview: ExpandedImagePreview) => void;
}

// --------------------------------------------------------------------------
// Component
// --------------------------------------------------------------------------

export const ChatComposer = memo(function ChatComposer(props: ChatComposerProps) {
  const {
    composerDraftTarget,
    environmentId,
    routeKind,
    routeThreadRef,
    draftId,
    activeThreadId,
    activeThreadEnvironmentId: _activeThreadEnvironmentId,
    activeThread,
    isServerThread: _isServerThread,
    isLocalDraftThread: _isLocalDraftThread,
    forceExpandedOnMobile,
    projectSelectionRequired,
    phase,
    isInterruptible,
    isConnecting,
    isSendBusy,
    sendDisabledReason,
    isPreparingWorktree,
    pushToTalkStatus,
    pushToTalkDisabled,
    pushToTalkDisabledReason,
    isApplyingSettings,
    isInterrupting,
    environmentUnavailable,
    activePendingApproval,
    pendingApprovals,
    pendingUserInputs,
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingIsResponding,
    activePendingDraftAnswers,
    activePendingQuestionIndex,
    respondingRequestIds,
    respondingUserInputRequestIds,
    showPlanFollowUpPrompt,
    activeProposedPlan,
    activePlan,
    sidebarProposedPlan,
    planSidebarLabel,
    planSidebarOpen,
    runtimeMode,
    interactionMode,
    lockedProvider,
    providerStatuses,
    activeProjectDefaultModelSelection,
    activeThreadModelSelection,
    activeThreadActivities,
    resolvedTheme,
    settings,
    keybindings,
    terminalOpen,
    gitCwd,
    promptRef,
    composerRef,
    composerImagesRef,
    composerTerminalContextsRef,
    composerElementContextsRef,
    onSend,
    onPushToTalkStart,
    onPushToTalkStop,
    activeProviderAccountSwitch,
    onSwitchProviderAccount,
    onApplySettings,
    onInterrupt,
    onImplementPlanInNewThread,
    onRespondToApproval,
    onSelectActivePendingUserInputOption,
    onAdvanceActivePendingUserInput,
    onPreviousActivePendingUserInputQuestion,
    onChangeActivePendingUserInputCustomAnswer,
    onProviderModelSelect,
    getModelDisabledReason,
    toggleInteractionMode,
    setInteractionMode,
    handleRuntimeModeChange,
    handleInteractionModeChange,
    togglePlanSidebar,
    focusComposer,
    scheduleComposerFocus,
    setThreadError,
    onExpandImage,
    persistModelSelectionAsDefault,
  } = props;
  const isSendDisabled = sendDisabledReason !== null;
  const updateEnvironmentSettings = useUpdateEnvironmentSettings(environmentId);
  const refreshThreadPlanCommand = useAtomCommand(threadEnvironment.refreshPlan, "plan refresh");
  const onAutoCompactionThresholdChange = useCallback(
    (value: UnifiedSettings["autoCompactionThresholdPercentage"]) => {
      updateEnvironmentSettings({ autoCompactionThresholdPercentage: value });
    },
    [updateEnvironmentSettings],
  );

  // ------------------------------------------------------------------
  // Store subscriptions (prompt / images / terminal contexts)
  // ------------------------------------------------------------------
  const composerDraft = useComposerThreadDraft(composerDraftTarget);
  const prompt = composerDraft.prompt;
  const [editorHasText, setEditorHasText] = useState(() => prompt.trim().length > 0);
  const composerImages = composerDraft.images;
  const composerTerminalContexts = composerDraft.terminalContexts;
  const composerElementContexts = composerDraft.elementContexts;
  const composerPreviewAnnotations = composerDraft.previewAnnotations;
  const composerReviewComments = composerDraft.reviewComments;
  const nonPersistedComposerImageIds = composerDraft.nonPersistedImageIds;
  const currentEditorHasText = editorHasText || prompt.trim().length > 0;

  useEffect(() => {
    setEditorHasText(prompt.trim().length > 0);
  }, [prompt]);

  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const addComposerDraftImage = useComposerDraftStore((store) => store.addImage);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
  const insertComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.insertTerminalContext,
  );
  const removeComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.removeTerminalContext,
  );
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const removeComposerDraftElementContext = useComposerDraftStore(
    (store) => store.removeElementContext,
  );
  const removeComposerDraftPreviewAnnotation = useComposerDraftStore(
    (store) => store.removePreviewAnnotation,
  );
  const removeComposerDraftReviewComment = useComposerDraftStore(
    (store) => store.removeReviewComment,
  );
  const clearComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.clearPersistedAttachments,
  );
  const clearComposerDraftPromptAndImages = useComposerDraftStore(
    (store) => store.clearComposerPromptAndImages,
  );
  const syncComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.syncPersistedAttachments,
  );
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);

  // ------------------------------------------------------------------
  // Model state
  // ------------------------------------------------------------------
  // Instance-aware projection of the wire provider list. One entry per
  // configured instance (default built-in + any custom `providerInstances.*`),
  // sorted default-first per driver kind for a stable picker order.
  const providerInstanceEntries = useMemo<ReadonlyArray<ProviderInstanceEntry>>(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providerStatuses), settings),
      ),
    [providerStatuses, settings],
  );
  const selectedProviderByThreadId = composerDraft.activeProvider ?? null;
  const threadProvider =
    activeThread?.session?.providerInstanceId ??
    activeThreadModelSelection?.instanceId ??
    activeProjectDefaultModelSelection?.instanceId ??
    null;
  const explicitSelectedInstanceId = selectedProviderByThreadId ?? threadProvider;

  const unlockedSelectedProvider =
    resolveProviderDriverKindForInstanceSelection(
      providerInstanceEntries,
      providerStatuses,
      explicitSelectedInstanceId,
    ) ??
    providerInstanceEntries[0]?.driverKind ??
    ProviderDriverKind.make("unconfigured");
  const requestedDriverKind: ProviderDriverKind = lockedProvider ?? unlockedSelectedProvider;
  const lockedContinuationGroupKey = useMemo((): string | null => {
    if (!lockedProvider || !activeThread) return null;
    const lockedInstanceId =
      activeThread.session?.providerInstanceId ?? activeThreadModelSelection?.instanceId;
    if (!lockedInstanceId) return null;
    return (
      providerInstanceEntries.find((entry) => entry.instanceId === lockedInstanceId)
        ?.continuationGroupKey ?? null
    );
  }, [
    activeThread,
    activeThreadModelSelection?.instanceId,
    lockedProvider,
    providerInstanceEntries,
  ]);

  // Resolve which configured instance the composer is currently targeting.
  // Priority:
  //   1. The composer draft's `activeProvider` — the user's unsaved pick
  //      from the model picker (must win, otherwise the UI appears to
  //      ignore picker selections).
  //   2. Thread's persisted instance id (server-side saved selection).
  //   3. Project default's instance id.
  //   4. First enabled entry matching the current driver kind.
  //   5. First enabled entry overall / default instance for the kind.
  //
  const selectedInstanceId = useMemo<ProviderInstanceId>(() => {
    const authoritativeInstanceId =
      activeThread?.session?.providerInstanceId ?? activeThreadModelSelection?.instanceId ?? null;
    const localOverride =
      composerDraft.activeProvider !== authoritativeInstanceId
        ? composerDraft.activeProvider
        : null;
    for (const candidate of [localOverride, authoritativeInstanceId]) {
      if (!candidate) continue;
      const match = providerInstanceEntries.find(
        (entry) => entry.instanceId === candidate && entry.enabled && entry.isAvailable,
      );
      if (match) {
        // When locked to a specific driver kind, ignore persisted instance
        // ids from a different kind or continuation group.
        if (lockedProvider && match.driverKind !== lockedProvider) continue;
        if (
          lockedContinuationGroupKey &&
          match.continuationGroupKey !== lockedContinuationGroupKey
        ) {
          continue;
        }
        return match.instanceId;
      }
    }
    // A server-backed thread's provider is host-authoritative. Preserve that
    // identity even when the host no longer exposes the provider so every
    // client shows the same unavailable state instead of silently selecting a
    // different local provider and presenting a bogus "Apply changes" action.
    if (authoritativeInstanceId) {
      return authoritativeInstanceId;
    }
    const projectDefaultEntry = providerInstanceEntries.find(
      (entry) =>
        entry.instanceId === activeProjectDefaultModelSelection?.instanceId &&
        entry.enabled &&
        entry.isAvailable,
    );
    if (projectDefaultEntry) {
      return projectDefaultEntry.instanceId;
    }
    const compatibleEntries = providerInstanceEntries.filter(
      (entry) =>
        (!lockedProvider || entry.driverKind === lockedProvider) &&
        (!lockedContinuationGroupKey || entry.continuationGroupKey === lockedContinuationGroupKey),
    );
    const requestedDriverEntries = compatibleEntries.filter(
      (entry) => entry.driverKind === requestedDriverKind,
    );
    return (
      resolveSelectableProviderInstanceEntry(requestedDriverEntries, undefined)?.instanceId ??
      resolveSelectableProviderInstanceEntry(compatibleEntries, undefined)?.instanceId ??
      NO_PROVIDER_MODEL_SELECTION.instanceId
    );
  }, [
    activeProjectDefaultModelSelection?.instanceId,
    activeThread?.session?.providerInstanceId,
    activeThreadModelSelection?.instanceId,
    composerDraft.activeProvider,
    lockedContinuationGroupKey,
    lockedProvider,
    providerInstanceEntries,
    requestedDriverKind,
  ]);

  // Resolve the active instance's snapshot by `instanceId` so a custom
  // instance gets its own slash commands, skills, and model list — not
  // the first snapshot for the same driver kind.
  const selectedProviderEntry = useMemo(
    () => providerInstanceEntries.find((entry) => entry.instanceId === selectedInstanceId),
    [providerInstanceEntries, selectedInstanceId],
  );
  const noProviderAvailable =
    selectedProviderEntry === undefined ||
    !selectedProviderEntry.enabled ||
    !selectedProviderEntry.isAvailable;
  // The driver kind follows the instance that will actually run the turn,
  // which can differ from the persisted selection when that selection is
  // disabled.
  const selectedProvider: ProviderDriverKind =
    selectedProviderEntry?.driverKind ?? requestedDriverKind;

  const { modelOptions: composerModelOptions, selectedModel } = useEffectiveComposerModelState({
    threadRef: composerDraftTarget,
    providers: providerStatuses,
    selectedProvider,
    selectedInstanceId,
    threadModelSelection: activeThreadModelSelection,
    projectModelSelection: activeProjectDefaultModelSelection,
    settings,
  });
  const selectedProviderStatus = useMemo(
    () => selectedProviderEntry?.snapshot ?? null,
    [selectedProviderEntry],
  );
  const selectedProviderModels = useMemo<ReadonlyArray<ServerProvider["models"][number]>>(
    () => selectedProviderEntry?.models ?? [],
    [selectedProviderEntry],
  );

  const composerPromptInjectionState = useMemo(
    () => getComposerPromptInjectionState(prompt),
    [prompt],
  );
  const composerProviderState = useMemo(
    () =>
      getComposerProviderState({
        provider: selectedProvider,
        model: selectedModel,
        models: selectedProviderModels,
        promptInjectionState: composerPromptInjectionState,
        modelOptions: composerModelOptions?.[selectedInstanceId],
      }),
    [
      composerModelOptions,
      composerPromptInjectionState,
      selectedInstanceId,
      selectedModel,
      selectedProvider,
      selectedProviderModels,
    ],
  );

  const selectedPromptEffort = composerProviderState.promptEffort;
  const selectedModelOptionsForDispatch = composerProviderState.modelOptionsForDispatch;
  const composerProviderControls = useMemo(
    () => ({
      showInteractionModeToggle: getProviderInteractionModeToggle(
        providerStatuses,
        selectedProvider,
      ),
    }),
    [providerStatuses, selectedProvider],
  );
  const selectedModelSelection = useMemo<ModelSelection>(
    () => createModelSelection(selectedInstanceId, selectedModel, selectedModelOptionsForDispatch),
    [selectedInstanceId, selectedModel, selectedModelOptionsForDispatch],
  );
  const settingsUpdateLabel = useMemo(() => {
    if (!activeThread || !_isServerThread) return null;
    const changes: string[] = [];
    const currentSelection = activeThread.modelSelection;
    if (currentSelection.instanceId !== selectedModelSelection.instanceId) {
      changes.push(`provider to ${selectedProviderEntry?.displayName ?? selectedProvider}`);
    }
    if (
      currentSelection.model !== selectedModelSelection.model ||
      JSON.stringify(currentSelection.options ?? null) !==
        JSON.stringify(selectedModelSelection.options ?? null)
    ) {
      const effort = selectedModelSelection.options?.find(
        (option) => option.id === "effort" || option.id === "reasoningEffort",
      )?.value;
      changes.push(
        typeof effort === "string"
          ? `${selectedModelSelection.model} with ${effort} effort`
          : selectedModelSelection.model,
      );
    }
    if (activeThread.runtimeMode !== runtimeMode) {
      changes.push(runtimeMode === "full-access" ? "Full access" : "Approval required");
    }
    if (activeThread.interactionMode !== interactionMode) {
      // Read from the shared config so a new mode cannot silently render as
      // "Build mode", which is how Agent was mislabelled here.
      changes.push(`${interactionModeConfig[interactionMode].label} mode`);
    }
    return changes.length > 0 ? changes.join(" · ") : null;
  }, [
    _isServerThread,
    activeThread,
    interactionMode,
    runtimeMode,
    selectedModelSelection,
    selectedProvider,
    selectedProviderEntry?.displayName,
  ]);
  const revertSettingsToThread = useCallback(() => {
    if (!activeThread || !_isServerThread) return;
    revertComposerSettingsToThread({
      composerTarget: composerDraftTarget,
      thread: activeThread,
      setModelSelection: setComposerDraftModelSelection,
      setRuntimeMode: setComposerDraftRuntimeMode,
      setInteractionMode: setComposerDraftInteractionMode,
    });
    scheduleComposerFocus();
  }, [
    _isServerThread,
    activeThread,
    composerDraftTarget,
    scheduleComposerFocus,
    setComposerDraftInteractionMode,
    setComposerDraftModelSelection,
    setComposerDraftRuntimeMode,
  ]);
  const selectedModelForPicker = selectedModel;
  // Instance-keyed option list so the picker can show each configured
  // instance (built-in + custom) as a first-class sidebar entry. The
  // options are server-reported models plus that exact instance's
  // configured custom models; selected slugs are not injected into lists.
  const modelOptionsByInstance = useMemo<
    ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>
  >(() => {
    const out = new Map<ProviderInstanceId, ReadonlyArray<AppModelOption>>();
    for (const entry of providerInstanceEntries) {
      out.set(entry.instanceId, getAppModelOptionsForInstance(settings, entry));
    }
    return out;
  }, [providerInstanceEntries, settings]);
  const selectedModelForPickerWithCustomFallback = useMemo(() => {
    const currentOptions = modelOptionsByInstance.get(selectedInstanceId) ?? [];
    return currentOptions.some((option) => option.slug === selectedModelForPicker)
      ? selectedModelForPicker
      : (normalizeModelSlug(selectedModelForPicker, selectedProvider) ?? selectedModelForPicker);
  }, [modelOptionsByInstance, selectedInstanceId, selectedModelForPicker, selectedProvider]);

  // ------------------------------------------------------------------
  // Context window
  // ------------------------------------------------------------------
  const activeContextWindow = useMemo(
    () => deriveLatestContextWindowSnapshot(activeThreadActivities ?? []),
    [activeThreadActivities],
  );
  const activeThreadProviderDisplayName = useMemo(() => {
    if (!activeThreadModelSelection) return null;
    const entry = providerStatuses.find(
      (p) => p.instanceId === activeThreadModelSelection.instanceId,
    );
    if (entry) {
      return getProviderDisplayName(providerStatuses, entry.driver);
    }
    return formatProviderDisplayName(activeThreadModelSelection.instanceId);
  }, [providerStatuses, activeThreadModelSelection]);
  const activeThreadSupportsConfigurableAutoCompaction = useMemo(() => {
    if (!activeThreadModelSelection) return false;
    return providerSupportsConfigurableAutoCompaction(
      providerStatuses.find(
        (provider) => provider.instanceId === activeThreadModelSelection.instanceId,
      )?.driver,
    );
  }, [providerStatuses, activeThreadModelSelection]);

  // ------------------------------------------------------------------
  // Composer-local state
  // ------------------------------------------------------------------
  const [composerCursor, setComposerCursor] = useState(() =>
    collapseExpandedComposerCursor(prompt, prompt.length),
  );
  const [composerTrigger, setComposerTrigger] = useState<ComposerTrigger | null>(() =>
    detectComposerTrigger(prompt, prompt.length),
  );
  const [composerHighlightedItemId, setComposerHighlightedItemId] = useState<string | null>(null);
  const [composerHighlightedSearchKey, setComposerHighlightedSearchKey] = useState<string | null>(
    null,
  );
  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
  const [composerFooterLayoutMode, setComposerFooterLayoutMode] =
    useState<ComposerFooterLayoutMode>("full");
  const [isComposerPrimaryActionsCompact, setIsComposerPrimaryActionsCompact] = useState(false);
  const [isComposerModelPickerOpen, setIsComposerModelPickerOpen] = useState(false);
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const [composerMenuAnchor, setComposerMenuAnchor] = useState<HTMLDivElement | null>(null);
  const [isStashMenuOpen, setIsStashMenuOpen] = useState(false);
  const [isCuttingComposerContents, setIsCuttingComposerContents] = useState(false);
  const [stashPulse, setStashPulse] = useState<{ key: number; active: boolean }>({
    key: 0,
    active: false,
  });
  const isMobileViewport = useMediaQuery("max-sm");
  const isPortraitMobileViewport = useMediaQuery("(max-width: 639px) and (orientation: portrait)");
  const isComposerCollapsedMobile = shouldCollapseMobileComposer({
    isMobileViewport,
    isPortraitViewport: isPortraitMobileViewport,
    routeKind,
    forceExpandedOnMobile,
    isComposerFocused,
    voiceStatus: pushToTalkStatus,
  });

  // ------------------------------------------------------------------
  // Refs
  // ------------------------------------------------------------------
  const composerEditorRef = useRef<ComposerPromptEditorHandle>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const composerSurfaceRef = useRef<HTMLDivElement>(null);
  const composerSelectLockRef = useRef(false);
  const composerMenuOpenRef = useRef(false);
  const composerMenuItemsRef = useRef<ComposerCommandItem[]>([]);
  const activeComposerMenuItemRef = useRef<ComposerCommandItem | null>(null);
  const composerBlurFrameRef = useRef<number | null>(null);
  const mobileKeyboardDismissFrameRef = useRef<number | null>(null);
  const mobileComposerExpandFrameRef = useRef<number | null>(null);
  const mobileComposerExpandReleaseFrameRef = useRef<number | null>(null);
  const mobileComposerExpandInFlightRef = useRef(false);
  const dragDepthRef = useRef(0);
  const stashPulseKeyRef = useRef(0);
  const stashPulseTimeoutRef = useRef<number | null>(null);
  /**
   * Snapshots currently being encoded, keyed by target+prompt+image ids.
   * Keyed rather than boolean so a genuinely different prompt (or a different
   * thread) can still be stashed while an earlier encode is running.
   */
  const stashInFlightRef = useRef<Set<string>>(new Set());

  // ------------------------------------------------------------------
  // Derived: composer send state
  // ------------------------------------------------------------------
  const composerSendState = useMemo(
    () =>
      deriveComposerSendState({
        prompt,
        imageCount: composerImages.length,
        terminalContexts: composerTerminalContexts,
        elementContextCount:
          composerElementContexts.length +
          composerPreviewAnnotations.length +
          composerReviewComments.length,
      }),
    [
      composerElementContexts.length,
      composerImages.length,
      composerPreviewAnnotations.length,
      composerReviewComments.length,
      composerTerminalContexts,
      prompt,
    ],
  );

  // ------------------------------------------------------------------
  // Derived: composer trigger / menu
  // ------------------------------------------------------------------
  const composerTriggerKind = composerTrigger?.kind ?? null;
  const pathTriggerQuery = composerTrigger?.kind === "path" ? composerTrigger.query : "";
  const isPathTrigger = composerTriggerKind === "path";
  const workspaceEntries = useComposerPathSearch({
    environmentId,
    cwd: isPathTrigger ? gitCwd : null,
    query: isPathTrigger ? pathTriggerQuery : null,
  });

  const composerMenuItems = useMemo<ComposerCommandItem[]>(() => {
    if (!composerTrigger) return [];
    if (composerTrigger.kind === "path") {
      return workspaceEntries.entries.map((entry) => ({
        id: `path:${entry.kind}:${entry.path}`,
        type: "path",
        path: entry.path,
        pathKind: entry.kind,
        label: basenameOfPath(entry.path),
        description: entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))),
      }));
    }
    if (composerTrigger.kind === "slash-command") {
      const builtInSlashCommandItems = [
        {
          id: "slash:model",
          type: "slash-command",
          command: "model",
          label: "/model",
          description: "Switch response model for this thread",
        },
        {
          id: "slash:plan",
          type: "slash-command",
          command: "plan",
          label: "/plan",
          description: "Switch this thread into plan mode",
        },
        {
          id: "slash:default",
          type: "slash-command",
          command: "default",
          label: "/default",
          description: "Switch this thread back to normal build mode",
        },
        {
          id: "slash:refresh-plan",
          type: "slash-command",
          command: "refresh-plan",
          label: "/refresh-plan",
          description: "Re-read the conversation and update the task list",
        },
      ] satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>>;
      const providerSlashCommandItems = (selectedProviderStatus?.slashCommands ?? []).map(
        (command) => ({
          id: `provider-slash-command:${selectedProvider}:${command.name}`,
          type: "provider-slash-command" as const,
          provider: selectedProvider,
          command,
          label: `/${command.name}`,
          description: command.description ?? command.input?.hint ?? "Run provider command",
        }),
      );
      const query = composerTrigger.query.trim().toLowerCase();
      const slashCommandItems = [...builtInSlashCommandItems, ...providerSlashCommandItems];
      if (!query) {
        return slashCommandItems;
      }
      return searchSlashCommandItems(slashCommandItems, query);
    }
    if (composerTrigger.kind === "skill") {
      return searchProviderSkills(selectedProviderStatus?.skills ?? [], composerTrigger.query).map(
        (skill) => ({
          id: `skill:${selectedProvider}:${skill.name}`,
          type: "skill" as const,
          provider: selectedProvider,
          skill,
          label: formatProviderSkillDisplayName(skill),
          description:
            skill.shortDescription ??
            skill.description ??
            (skill.scope ? `${skill.scope} skill` : "Run provider skill"),
        }),
      );
    }
    return [];
  }, [composerTrigger, selectedProvider, selectedProviderStatus, workspaceEntries.entries]);

  const composerMenuOpen = Boolean(composerTrigger);
  const composerMenuSearchKey = composerTrigger
    ? `${composerTrigger.kind}:${composerTrigger.query.trim().toLowerCase()}`
    : null;
  const activeComposerMenuItem = useMemo(() => {
    const activeItemId = resolveComposerMenuActiveItemId({
      items: composerMenuItems,
      highlightedItemId: composerHighlightedItemId,
      currentSearchKey: composerMenuSearchKey,
      highlightedSearchKey: composerHighlightedSearchKey,
    });
    return composerMenuItems.find((item) => item.id === activeItemId) ?? null;
  }, [
    composerHighlightedItemId,
    composerHighlightedSearchKey,
    composerMenuItems,
    composerMenuSearchKey,
  ]);

  composerMenuOpenRef.current = composerMenuOpen;
  composerMenuItemsRef.current = composerMenuItems;
  activeComposerMenuItemRef.current = activeComposerMenuItem;

  const nonPersistedComposerImageIdSet = useMemo(
    () => new Set(nonPersistedComposerImageIds),
    [nonPersistedComposerImageIds],
  );

  const isComposerApprovalState = activePendingApproval !== null;
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const hasComposerHeader =
    isComposerApprovalState ||
    pendingUserInputs.length > 0 ||
    (showPlanFollowUpPrompt && activeProposedPlan !== null);
  const showCollapsedMobilePromptRow =
    isComposerCollapsedMobile && !isComposerApprovalState && pendingUserInputs.length === 0;

  const composerFooterHasWideActions =
    showPlanFollowUpPrompt || activePendingProgress !== null || settingsUpdateLabel !== null;
  const showPlanSidebarToggle = Boolean(activePlan || sidebarProposedPlan || planSidebarOpen);
  const composerFooterActionLayoutKey = useMemo(() => {
    if (activePendingProgress) {
      return `pending:${activePendingProgress.questionIndex}:${activePendingProgress.isLastQuestion}:${activePendingIsResponding}`;
    }
    if (isInterruptible) {
      return "running";
    }
    if (showPlanFollowUpPrompt) {
      return prompt.trim().length > 0 ? "plan:refine" : "plan:implement";
    }
    return `idle:${composerSendState.hasSendableContent}:${isSendBusy}:${isConnecting}:${isPreparingWorktree}`;
  }, [
    activePendingIsResponding,
    activePendingProgress,
    composerSendState.hasSendableContent,
    isConnecting,
    isPreparingWorktree,
    isSendBusy,
    isInterruptible,
    prompt,
    showPlanFollowUpPrompt,
  ]);

  const isComposerMenuLoading =
    composerTriggerKind === "path" && pathTriggerQuery.length > 0 && workspaceEntries.isPending;
  const composerMenuEmptyState = useMemo(() => {
    if (composerTriggerKind === "skill") {
      return "No skills found. Try / to browse provider commands.";
    }
    return composerTriggerKind === "path"
      ? "No matching files or folders."
      : "No matching command.";
  }, [composerTriggerKind]);

  // ------------------------------------------------------------------
  // Provider traits UI
  // ------------------------------------------------------------------
  const setPromptFromTraits = useCallback(
    (nextPrompt: string) => {
      if (nextPrompt === promptRef.current) {
        scheduleComposerFocus();
        return;
      }
      promptRef.current = nextPrompt;
      setComposerDraftPrompt(composerDraftTarget, nextPrompt);
      const nextCursor = collapseExpandedComposerCursor(nextPrompt, nextPrompt.length);
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      scheduleComposerFocus();
    },
    [composerDraftTarget, promptRef, scheduleComposerFocus, setComposerDraftPrompt],
  );
  const providerTraitsMenuContent = renderProviderTraitsMenuContent({
    provider: selectedProvider,
    instanceId: selectedInstanceId,
    ...(routeKind === "server" ? { threadRef: routeThreadRef } : {}),
    ...(routeKind === "draft" && draftId ? { draftId } : {}),
    model: selectedModel,
    models: selectedProviderModels,
    modelOptions: composerModelOptions?.[selectedInstanceId],
    persistSticky: persistModelSelectionAsDefault,
    prompt,
    onPromptChange: setPromptFromTraits,
  });
  const providerTraitsPicker = renderProviderTraitsPicker({
    provider: selectedProvider,
    instanceId: selectedInstanceId,
    ...(routeKind === "server" ? { threadRef: routeThreadRef } : {}),
    ...(routeKind === "draft" && draftId ? { draftId } : {}),
    model: selectedModel,
    models: selectedProviderModels,
    modelOptions: composerModelOptions?.[selectedInstanceId],
    persistSticky: persistModelSelectionAsDefault,
    iconOnly: composerFooterLayoutMode === "icons",
    prompt,
    onPromptChange: setPromptFromTraits,
  });
  const pendingPrimaryAction = useMemo(
    () =>
      activePendingProgress
        ? {
            questionIndex: activePendingProgress.questionIndex,
            isLastQuestion: activePendingProgress.isLastQuestion,
            canAdvance: activePendingProgress.canAdvance,
            isResponding: activePendingIsResponding,
            isComplete: Boolean(activePendingResolvedAnswers),
            ...(isActionApprovalQuestion(activePendingProgress.activeQuestion)
              ? {
                  submitLabel:
                    activePendingProgress.customAnswer.trim().length > 0
                      ? "Request changes"
                      : "Approve",
                }
              : {}),
          }
        : null,
    [activePendingIsResponding, activePendingProgress, activePendingResolvedAnswers],
  );
  const sendWhileRunning = shouldSendComposerWhileProcessing({
    isProcessing: phase === "running",
    hasCurrentEditorText: currentEditorHasText,
    hasPendingComposerContent: composerSendState.hasSendableContent,
  });
  const hasCurrentSendableContent = composerSendState.hasSendableContent || currentEditorHasText;
  const collapsedComposerPrimaryActionDisabled = isInterruptible
    ? isInterrupting
    : isSendBusy ||
      isSendDisabled ||
      isConnecting ||
      noProviderAvailable ||
      projectSelectionRequired ||
      environmentUnavailable !== null ||
      !composerSendState.hasSendableContent;
  const collapsedComposerPrimaryActionLabel = isInterruptible
    ? isInterrupting
      ? "Stopping generation"
      : "Stop generation"
    : "Send message";
  const showMobilePendingAnswerActions =
    isMobileViewport && !isComposerCollapsedMobile && pendingPrimaryAction !== null;
  const showComposerCutButton =
    !isComposerApprovalState &&
    pendingUserInputs.length === 0 &&
    hasTransferableComposerContent(prompt, composerImages.length);

  // ------------------------------------------------------------------
  // Prompt helpers
  // ------------------------------------------------------------------
  const setPrompt = useCallback(
    (nextPrompt: string) => {
      setComposerDraftPrompt(composerDraftTarget, nextPrompt);
    },
    [composerDraftTarget, setComposerDraftPrompt],
  );

  const addComposerImage = useCallback(
    (image: ComposerImageAttachment) => {
      addComposerDraftImage(composerDraftTarget, image);
    },
    [composerDraftTarget, addComposerDraftImage],
  );

  const addComposerImagesToDraft = useCallback(
    (images: ComposerImageAttachment[]) => {
      addComposerDraftImages(composerDraftTarget, images);
    },
    [composerDraftTarget, addComposerDraftImages],
  );

  const removeComposerImageFromDraft = useCallback(
    (imageId: string) => {
      removeComposerDraftImage(composerDraftTarget, imageId);
    },
    [composerDraftTarget, removeComposerDraftImage],
  );

  const removeComposerTerminalContextFromDraft = useCallback(
    (contextId: string) => {
      const contextIndex = composerTerminalContexts.findIndex(
        (context) => context.id === contextId,
      );
      if (contextIndex < 0) return;
      const removal = removeInlineTerminalContextPlaceholder(promptRef.current, contextIndex);
      promptRef.current = removal.prompt;
      setPrompt(removal.prompt);
      removeComposerDraftTerminalContext(composerDraftTarget, contextId);
      const nextCursor = collapseExpandedComposerCursor(removal.prompt, removal.cursor);
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(removal.prompt, removal.cursor));
    },
    [
      composerDraftTarget,
      composerTerminalContexts,
      promptRef,
      removeComposerDraftTerminalContext,
      setPrompt,
    ],
  );

  // ------------------------------------------------------------------
  // Sync refs back to parent
  // ------------------------------------------------------------------
  useEffect(() => {
    promptRef.current = prompt;
    setComposerCursor((existing) => clampCollapsedComposerCursor(prompt, existing));
  }, [prompt, promptRef]);

  useEffect(() => {
    composerImagesRef.current = composerImages;
  }, [composerImages, composerImagesRef]);

  useEffect(() => {
    composerTerminalContextsRef.current = composerTerminalContexts;
  }, [composerTerminalContexts, composerTerminalContextsRef]);

  useEffect(() => {
    composerElementContextsRef.current = composerElementContexts;
  }, [composerElementContexts, composerElementContextsRef]);

  // ------------------------------------------------------------------
  // Composer menu highlight sync
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!composerMenuOpen) {
      setComposerHighlightedItemId(null);
      setComposerHighlightedSearchKey(null);
      return;
    }
    const nextActiveItemId = resolveComposerMenuActiveItemId({
      items: composerMenuItems,
      highlightedItemId: composerHighlightedItemId,
      currentSearchKey: composerMenuSearchKey,
      highlightedSearchKey: composerHighlightedSearchKey,
    });
    setComposerHighlightedItemId((existing) =>
      existing === nextActiveItemId ? existing : nextActiveItemId,
    );
    setComposerHighlightedSearchKey((existing) =>
      existing === composerMenuSearchKey ? existing : composerMenuSearchKey,
    );
  }, [
    composerHighlightedItemId,
    composerHighlightedSearchKey,
    composerMenuItems,
    composerMenuOpen,
    composerMenuSearchKey,
  ]);

  const lastSyncedPendingInputRef = useRef<{
    requestId: string | null;
    questionId: string | null;
  } | null>(null);

  useEffect(() => {
    const nextCustomAnswer = activePendingProgress?.customAnswer;
    if (typeof nextCustomAnswer !== "string") {
      lastSyncedPendingInputRef.current = null;
      return;
    }

    const nextRequestId = activePendingUserInput?.requestId ?? null;
    const nextQuestionId = activePendingProgress?.activeQuestion?.id ?? null;
    const questionChanged =
      lastSyncedPendingInputRef.current?.requestId !== nextRequestId ||
      lastSyncedPendingInputRef.current?.questionId !== nextQuestionId;
    const textChangedExternally = promptRef.current !== nextCustomAnswer;

    lastSyncedPendingInputRef.current = {
      requestId: nextRequestId,
      questionId: nextQuestionId,
    };

    if (!questionChanged && !textChangedExternally) {
      return;
    }

    promptRef.current = nextCustomAnswer;
    const nextCursor = collapseExpandedComposerCursor(nextCustomAnswer, nextCustomAnswer.length);
    setComposerCursor(nextCursor);
    setComposerTrigger(
      detectComposerTrigger(
        nextCustomAnswer,
        expandCollapsedComposerCursor(nextCustomAnswer, nextCursor),
      ),
    );
    setComposerHighlightedItemId(null);
  }, [
    activePendingProgress?.customAnswer,
    activePendingProgress?.activeQuestion?.id,
    activePendingUserInput?.requestId,
    promptRef,
  ]);

  // ------------------------------------------------------------------
  // Reset compositor state on thread/draft change
  // ------------------------------------------------------------------
  useEffect(() => {
    setComposerHighlightedItemId(null);
    setComposerCursor(collapseExpandedComposerCursor(promptRef.current, promptRef.current.length));
    setComposerTrigger(detectComposerTrigger(promptRef.current, promptRef.current.length));
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
  }, [draftId, activeThreadId, promptRef]);

  // ------------------------------------------------------------------
  // Footer responsive layout observation
  // ------------------------------------------------------------------
  useLayoutEffect(() => {
    const composerForm = composerFormRef.current;
    if (!composerForm) return;
    const measureComposerFormWidth = () => composerForm.clientWidth;
    const measureFooterLayout = () => {
      const composerFormWidth = measureComposerFormWidth();
      const footerLayoutMode = resolveComposerFooterLayoutMode(composerFormWidth, {
        hasWideActions: composerFooterHasWideActions,
      });
      const primaryActionsCompact = shouldUseCompactComposerPrimaryActions(composerFormWidth, {
        hasWideActions: composerFooterHasWideActions,
      });
      return {
        primaryActionsCompact,
        footerLayoutMode,
      };
    };

    const initialLayout = measureFooterLayout();
    setIsComposerPrimaryActionsCompact(initialLayout.primaryActionsCompact);
    setComposerFooterLayoutMode(initialLayout.footerLayoutMode);
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      const nextLayout = measureFooterLayout();
      setIsComposerPrimaryActionsCompact((previous) =>
        previous === nextLayout.primaryActionsCompact ? previous : nextLayout.primaryActionsCompact,
      );
      setComposerFooterLayoutMode((previous) =>
        previous === nextLayout.footerLayoutMode ? previous : nextLayout.footerLayoutMode,
      );
    });

    observer.observe(composerForm);
    return () => {
      observer.disconnect();
    };
  }, [activeThreadId, composerFooterActionLayoutKey, composerFooterHasWideActions]);

  // ------------------------------------------------------------------
  // Image persist effect
  // ------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (composerImages.length === 0) {
        clearComposerDraftPersistedAttachments(composerDraftTarget);
        return;
      }
      const getPersistedAttachmentsForThread = () =>
        getComposerDraft(composerDraftTarget)?.persistedAttachments ?? [];
      try {
        const currentPersistedAttachments = getPersistedAttachmentsForThread();
        const existingPersistedById = new Map(
          currentPersistedAttachments.map((attachment) => [attachment.id, attachment]),
        );
        const stagedAttachmentById = new Map<string, PersistedComposerImageAttachment>();
        await Promise.all(
          composerImages.map(async (image) => {
            try {
              const dataUrl = await readFileAsDataUrl(image.file);
              stagedAttachmentById.set(image.id, {
                id: image.id,
                name: image.name,
                mimeType: image.mimeType,
                sizeBytes: image.sizeBytes,
                dataUrl,
              });
            } catch {
              const existingPersisted = existingPersistedById.get(image.id);
              if (existingPersisted) {
                stagedAttachmentById.set(image.id, existingPersisted);
              }
            }
          }),
        );
        const serialized = Array.from(stagedAttachmentById.values());
        if (cancelled) return;
        syncComposerDraftPersistedAttachments(composerDraftTarget, serialized);
      } catch {
        const currentImageIds = new Set(composerImages.map((image) => image.id));
        const fallbackPersistedAttachments = getPersistedAttachmentsForThread();
        const fallbackPersistedIds: Array<string> = [];
        for (const attachment of fallbackPersistedAttachments) {
          if (currentImageIds.has(attachment.id)) {
            fallbackPersistedIds.push(attachment.id);
          }
        }
        const fallbackPersistedIdSet = new Set(fallbackPersistedIds);
        const fallbackAttachments = fallbackPersistedAttachments.filter((attachment) =>
          fallbackPersistedIdSet.has(attachment.id),
        );
        if (cancelled) return;
        syncComposerDraftPersistedAttachments(composerDraftTarget, fallbackAttachments);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    composerDraftTarget,
    clearComposerDraftPersistedAttachments,
    composerImages,
    getComposerDraft,
    syncComposerDraftPersistedAttachments,
  ]);

  // ------------------------------------------------------------------
  // Callbacks: prompt change
  // ------------------------------------------------------------------
  const onPromptChange = useCallback(
    (
      nextPrompt: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
      terminalContextIds: string[],
    ) => {
      if (activePendingProgress?.activeQuestion && pendingUserInputs.length > 0) {
        setComposerCursor(nextCursor);
        setComposerTrigger(
          cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
        );
        onChangeActivePendingUserInputCustomAnswer(
          activePendingProgress.activeQuestion.id,
          nextPrompt,
          nextCursor,
          expandedCursor,
          cursorAdjacentToMention,
        );
        return;
      }
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      if (!terminalContextIdListsEqual(composerTerminalContexts, terminalContextIds)) {
        setComposerDraftTerminalContexts(
          composerDraftTarget,
          syncTerminalContextsByIds(composerTerminalContexts, terminalContextIds),
        );
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
      );
    },
    [
      activePendingProgress?.activeQuestion,
      pendingUserInputs.length,
      onChangeActivePendingUserInputCustomAnswer,
      promptRef,
      setPrompt,
      composerDraftTarget,
      composerTerminalContexts,
      setComposerDraftTerminalContexts,
    ],
  );

  // ------------------------------------------------------------------
  // Callbacks: prompt replacement / menu
  // ------------------------------------------------------------------
  const applyPromptReplacement = useCallback(
    (
      rangeStart: number,
      rangeEnd: number,
      replacement: string,
      options?: { expectedText?: string; focusEditorAfterReplace?: boolean },
    ): boolean => {
      const currentText = promptRef.current;
      const safeStart = Math.max(0, Math.min(currentText.length, rangeStart));
      const safeEnd = Math.max(safeStart, Math.min(currentText.length, rangeEnd));
      if (
        options?.expectedText !== undefined &&
        currentText.slice(safeStart, safeEnd) !== options.expectedText
      ) {
        return false;
      }
      const next = replaceTextRange(promptRef.current, rangeStart, rangeEnd, replacement);
      const nextCursor = collapseExpandedComposerCursor(next.text, next.cursor);
      const nextExpandedCursor = expandCollapsedComposerCursor(next.text, nextCursor);
      promptRef.current = next.text;
      const activePendingQuestion = activePendingProgress?.activeQuestion;
      if (activePendingQuestion && activePendingUserInput) {
        onChangeActivePendingUserInputCustomAnswer(
          activePendingQuestion.id,
          next.text,
          nextCursor,
          nextExpandedCursor,
          false,
        );
      } else {
        setPrompt(next.text);
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(next.text, nextExpandedCursor));
      if (options?.focusEditorAfterReplace !== false) {
        window.requestAnimationFrame(() => {
          composerEditorRef.current?.focusAt(nextCursor);
        });
      }
      return true;
    },
    [
      activePendingProgress?.activeQuestion,
      activePendingUserInput,
      onChangeActivePendingUserInputCustomAnswer,
      promptRef,
      setPrompt,
    ],
  );

  const readComposerSnapshot = useCallback((): {
    value: string;
    cursor: number;
    expandedCursor: number;
    terminalContextIds: string[];
  } => {
    const editorSnapshot = composerEditorRef.current?.readSnapshot();
    if (editorSnapshot) {
      return editorSnapshot;
    }
    return {
      value: promptRef.current,
      cursor: composerCursor,
      expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
      terminalContextIds: composerTerminalContexts.map((context) => context.id),
    };
  }, [composerCursor, composerTerminalContexts, promptRef]);

  const insertComposerEmoji = useCallback(
    (emoji: string) => {
      const snapshot = readComposerSnapshot();
      applyPromptReplacement(snapshot.expandedCursor, snapshot.expandedCursor, emoji, {
        focusEditorAfterReplace: false,
      });
    },
    [applyPromptReplacement, readComposerSnapshot],
  );

  const resolveActiveComposerTrigger = useCallback((): {
    snapshot: { value: string; cursor: number; expandedCursor: number };
    trigger: ComposerTrigger | null;
  } => {
    const snapshot = readComposerSnapshot();
    return {
      snapshot,
      trigger: detectComposerTrigger(snapshot.value, snapshot.expandedCursor),
    };
  }, [readComposerSnapshot]);

  const onSelectComposerItem = useCallback(
    (item: ComposerCommandItem) => {
      if (composerSelectLockRef.current) return;
      composerSelectLockRef.current = true;
      window.requestAnimationFrame(() => {
        composerSelectLockRef.current = false;
      });
      const { snapshot, trigger } = resolveActiveComposerTrigger();
      if (!trigger) return;
      if (item.type === "path") {
        const replacement = `${serializeComposerFileLink(item.path)} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "slash-command") {
        if (item.command === "model") {
          const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
            expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
            focusEditorAfterReplace: false,
          });
          if (applied) {
            setComposerHighlightedItemId(null);
            setIsComposerModelPickerOpen(true);
          }
          return;
        }
        if (item.command === "refresh-plan") {
          // Performs the action directly — no message is sent and the turn is
          // untouched. Handled before the mode-change fall-through below, which
          // would otherwise read any unknown command as "default" and quietly
          // switch the thread out of its current mode.
          const threadId = activeThread?.id;
          if (threadId) {
            void refreshThreadPlanCommand({ environmentId, input: { threadId } });
          }
          const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
            expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
          });
          if (applied) {
            setComposerHighlightedItemId(null);
          }
          return;
        }
        void handleInteractionModeChange(item.command === "plan" ? "plan" : "default");
        const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
          expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
        });
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "provider-slash-command") {
        const replacement = `/${item.command.name} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "skill") {
        const replacement = `$${item.skill.name} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
    },
    [applyPromptReplacement, handleInteractionModeChange, resolveActiveComposerTrigger],
  );

  const onComposerMenuItemHighlighted = useCallback(
    (itemId: string | null) => {
      setComposerHighlightedItemId(itemId);
      setComposerHighlightedSearchKey(composerMenuSearchKey);
    },
    [composerMenuSearchKey],
  );

  const nudgeComposerMenuHighlight = useCallback(
    (key: "ArrowDown" | "ArrowUp") => {
      if (composerMenuItems.length === 0) return;
      const highlightedIndex = composerMenuItems.findIndex(
        (item) => item.id === composerHighlightedItemId,
      );
      const normalizedIndex =
        highlightedIndex >= 0 ? highlightedIndex : key === "ArrowDown" ? -1 : 0;
      const offset = key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        (normalizedIndex + offset + composerMenuItems.length) % composerMenuItems.length;
      const nextItem = composerMenuItems[nextIndex];
      setComposerHighlightedItemId(nextItem?.id ?? null);
    },
    [composerHighlightedItemId, composerMenuItems],
  );

  const blurFocusedComposerElement = useCallback(() => {
    if (!isMobileViewport) return;
    composerEditorRef.current?.blur();
    const composerForm = composerFormRef.current;
    const activeElement = document.activeElement;
    if (
      composerForm &&
      activeElement instanceof HTMLElement &&
      composerForm.contains(activeElement)
    ) {
      activeElement.blur();
    }
    setIsComposerFocused(false);
  }, [isMobileViewport]);

  const dismissMobileKeyboardOnSubmit = shouldDismissMobileKeyboardOnSubmit({
    isMobileViewport,
    submitBlocked:
      isSendBusy ||
      isSendDisabled ||
      isConnecting ||
      noProviderAvailable ||
      environmentUnavailable !== null,
    hasSubmitAction: activePendingProgress
      ? activePendingProgress.isLastQuestion && Boolean(activePendingResolvedAnswers)
      : showPlanFollowUpPrompt || hasCurrentSendableContent,
  });

  const dismissMobileKeyboardAfterSend = useCallback(() => {
    if (!dismissMobileKeyboardOnSubmit) return;
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
      composerBlurFrameRef.current = null;
    }
    if (mobileKeyboardDismissFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileKeyboardDismissFrameRef.current);
    }

    const virtualKeyboard = (
      navigator as Navigator & {
        virtualKeyboard?: { hide: () => void };
      }
    ).virtualKeyboard;
    try {
      virtualKeyboard?.hide();
    } catch {
      // WebKit has no VirtualKeyboard API; the explicit editor blur remains
      // the portable path and is guarded through the post-submit rerenders.
    }
    blurFocusedComposerElement();
    let remainingFrames = 2;
    const guardAgainstFocusRestoration = () => {
      mobileKeyboardDismissFrameRef.current = null;
      blurFocusedComposerElement();
      remainingFrames -= 1;
      if (remainingFrames > 0) {
        mobileKeyboardDismissFrameRef.current = window.requestAnimationFrame(
          guardAgainstFocusRestoration,
        );
      }
    };
    mobileKeyboardDismissFrameRef.current = window.requestAnimationFrame(
      guardAgainstFocusRestoration,
    );
  }, [blurFocusedComposerElement, dismissMobileKeyboardOnSubmit]);

  // The keyboard used to also be dismissed here, from a pointerdown/touchstart
  // capture handler, to keep the blur inside the originating gesture — mobile
  // WebKit can ignore a blur that waits on form submit. But blurring on
  // pointerdown resizes the visual viewport mid-tap: the composer reflows
  // downward and the finger is no longer over the send button when the click
  // resolves, so the first tap only closed the keyboard and the message needed
  // tapping send twice. `submitComposer` already dismisses after committing,
  // from inside the click — itself a user gesture — so this was redundant as
  // well as harmful.

  const submitComposer = useCallback(
    (event?: { preventDefault: () => void }) => {
      if (isComposerSubmitBlocked({ noProviderAvailable, isSendDisabled, pushToTalkStatus })) {
        event?.preventDefault();
        return;
      }
      if (!activePendingProgress) {
        const currentEditorPrompt = composerEditorRef.current?.readSnapshot().value;
        if (currentEditorPrompt !== undefined && currentEditorPrompt !== promptRef.current) {
          promptRef.current = currentEditorPrompt;
          setComposerDraftPrompt(composerDraftTarget, currentEditorPrompt);
        }
      }
      if (dismissMobileKeyboardOnSubmit) {
        dismissMobileKeyboardAfterSend();
      }
      onSend(event);
    },
    [
      activePendingProgress,
      composerDraftTarget,
      dismissMobileKeyboardAfterSend,
      dismissMobileKeyboardOnSubmit,
      isSendDisabled,
      noProviderAvailable,
      onSend,
      promptRef,
      pushToTalkStatus,
      setComposerDraftPrompt,
    ],
  );

  // Applies a "Quote" from the transcript context menu. Subscribing rather than
  // polling means only the mounted composer for the active thread consumes it,
  // and the store clears on read so a remount cannot duplicate the quote.
  const pendingQuote = useComposerQuoteStore((state) => state.pending);
  useEffect(() => {
    if (pendingQuote === null) return;
    const selection = useComposerQuoteStore.getState().takeQuote();
    if (selection === null) return;
    const current = composerEditorRef.current?.readSnapshot().value ?? promptRef.current;
    const { prompt } = buildQuotedPrompt({ prompt: current, selection });
    if (prompt === current) return;
    promptRef.current = prompt;
    setComposerDraftPrompt(composerDraftTarget, prompt);
    // Let the draft render reach the editor before moving the caret, otherwise
    // focus lands on the stale value. The quote always ends with a blank line,
    // so the end of the prompt is exactly where the reply should start.
    window.requestAnimationFrame(() => {
      composerEditorRef.current?.focusAtEnd();
    });
  }, [composerDraftTarget, pendingQuote, promptRef, setComposerDraftPrompt]);

  useEffect(() => {
    if (!isMobileViewport) return;
    const composerForm = composerFormRef.current;
    if (!composerForm) return;
    return installMobileComposerTouchBoundary(composerForm);
  }, [isMobileViewport]);
  const expandMobileComposer = useCallback(() => {
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
      composerBlurFrameRef.current = null;
    }
    if (mobileComposerExpandFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileComposerExpandFrameRef.current);
    }
    if (mobileComposerExpandReleaseFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileComposerExpandReleaseFrameRef.current);
    }
    mobileComposerExpandInFlightRef.current = true;
    setIsComposerFocused(true);
    mobileComposerExpandFrameRef.current = window.requestAnimationFrame(() => {
      mobileComposerExpandFrameRef.current = null;
      composerEditorRef.current?.focusAtEnd();
      mobileComposerExpandReleaseFrameRef.current = window.requestAnimationFrame(() => {
        mobileComposerExpandReleaseFrameRef.current = null;
        mobileComposerExpandInFlightRef.current = false;
      });
    });
  }, []);

  // ------------------------------------------------------------------
  // Callbacks: command key
  // ------------------------------------------------------------------
  const onComposerCommandKey = (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab",
    event: KeyboardEvent,
  ) => {
    if (key === "Tab" && event.shiftKey) {
      toggleInteractionMode();
      return true;
    }
    const { trigger } = resolveActiveComposerTrigger();
    const menuIsActive = composerMenuOpenRef.current || trigger !== null;
    if (menuIsActive) {
      const currentItems = composerMenuItemsRef.current;
      const selectedItem = activeComposerMenuItemRef.current ?? currentItems[0];
      if (key === "ArrowDown" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowDown");
        return true;
      }
      if (key === "ArrowUp" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowUp");
        return true;
      }
      if ((key === "Enter" || key === "Tab") && selectedItem) {
        onSelectComposerItem(selectedItem);
        return true;
      }
    }
    if (
      key === "Enter" &&
      shouldSubmitComposerOnEnter({ isMobileViewport, shiftKey: event.shiftKey })
    ) {
      // Enter must honour the same guard as the send button rather than infer
      // permission from the rendered submit button. While a turn is running the
      // primary action is Stop, so no submit button exists to read a disabled
      // state from — and a transcription still writing into the draft would
      // otherwise be submitted half-finished into the middle of the turn.
      if (isComposerSubmitBlocked({ noProviderAvailable, isSendDisabled, pushToTalkStatus })) {
        return true;
      }
      const composerForm = composerFormRef.current;
      const submitButton =
        composerForm?.querySelector<HTMLButtonElement>('button[type="submit"]') ?? null;
      if (composerForm && isEnabledComposerSubmitButton(submitButton)) {
        composerForm.requestSubmit(submitButton);
      }
      return true;
    }
    return false;
  };

  // ------------------------------------------------------------------
  // Prompt stash (⌘S)
  // ------------------------------------------------------------------
  // One global queue. Stashed prompts carry only text + images so they can be
  // restored into any thread or provider — stash, switch, restore is the
  // whole point.
  const stashQueue = usePromptStashStore((state) => state.entries);
  const stashEntryToQueue = usePromptStashStore((state) => state.stashEntry);
  const takeStashEntry = usePromptStashStore((state) => state.takeEntry);
  const finalizeStashEntryImages = usePromptStashStore((state) => state.finalizeEntryImages);

  useEffect(() => {
    return () => {
      if (stashPulseTimeoutRef.current !== null) {
        window.clearTimeout(stashPulseTimeoutRef.current);
      }
    };
  }, []);

  /** Briefly highlight the badge so the save registers without a flourish. */
  const pulseStashBadge = useCallback(() => {
    stashPulseKeyRef.current += 1;
    setStashPulse({ key: stashPulseKeyRef.current, active: true });
    if (stashPulseTimeoutRef.current !== null) {
      window.clearTimeout(stashPulseTimeoutRef.current);
    }
    stashPulseTimeoutRef.current = window.setTimeout(() => {
      stashPulseTimeoutRef.current = null;
      setStashPulse((current) => ({ ...current, active: false }));
    }, 1200);
  }, []);

  const restoreStashEntry = useCallback(
    (entry: PromptStashEntry) => {
      // Remove first so a double activation (click + Enter) can't restore twice.
      const { entry: taken, durable } = takeStashEntry(entry.id);
      if (!taken) return;
      if (!durable) {
        toastManager.add({
          type: "warning",
          title: "Restored prompt may reappear in the stash",
          description:
            "Browser storage rejected the update, so this entry could still be there after a reload.",
          data: { hideCopyButton: true },
        });
      }
      setIsStashMenuOpen(false);

      const currentPrompt = promptRef.current;
      // An image-only stash must not append blank lines to whatever is
      // already in the composer.
      const nextPrompt =
        entry.prompt.length === 0
          ? currentPrompt
          : currentPrompt.trim().length
            ? `${currentPrompt.replace(/\s+$/, "")}\n\n${entry.prompt}`
            : entry.prompt;
      const promptChanged = nextPrompt !== currentPrompt;
      if (promptChanged) {
        promptRef.current = nextPrompt;
        setComposerDraftPrompt(composerDraftTarget, nextPrompt);
        setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
        setComposerTrigger(null);
      }

      let unrestoredImageNames: string[] = [];
      if (entry.attachments.length > 0) {
        const existingIds = new Set(composerImagesRef.current.map((image) => image.id));
        // The draft store also dedupes by mimeType+sizeBytes+name, so filter
        // on the same key here. Counting a duplicate against capacity would
        // burn a slot the store then refuses to fill, pushing a genuinely
        // unique image into the overflow list for nothing.
        const existingDedupKeys = new Set(
          composerImagesRef.current.map(
            (image) => `${image.mimeType}\0${image.sizeBytes}\0${image.name}`,
          ),
        );
        const capacity = Math.max(
          0,
          PROVIDER_SEND_TURN_MAX_ATTACHMENTS - composerImagesRef.current.length,
        );
        const pending = entry.attachments.filter(
          (attachment) =>
            !existingIds.has(attachment.id) &&
            !existingDedupKeys.has(
              `${attachment.mimeType}\0${attachment.sizeBytes}\0${attachment.name}`,
            ),
        );
        // Anything past the attachment limit cannot be restored. The entry is
        // already out of the queue, so report the overflow by name instead of
        // discarding it silently.
        unrestoredImageNames = pending.slice(capacity).map((attachment) => attachment.name);
        const restoredImages = hydrateImagesFromPersisted(pending.slice(0, capacity));
        if (restoredImages.length > 0) {
          addComposerDraftImages(composerDraftTarget, restoredImages);
        }
      }

      // Deliberately no model/provider restore: the stash exists to carry a
      // prompt across threads and providers, so whatever the composer has
      // selected right now stays selected.

      // Each cause gets its own sentence so "too large" is never blamed for a
      // file that actually failed to decode, or for one the composer simply
      // had no room to take back.
      const missingImageReasons: string[] = [];
      if (entry.droppedImageNames.length > 0) {
        missingImageReasons.push(
          `${entry.droppedImageNames.join(", ")} exceeded the stash size limit when this prompt was saved.`,
        );
      }
      if (entry.unreadableImageNames && entry.unreadableImageNames.length > 0) {
        missingImageReasons.push(
          `${entry.unreadableImageNames.join(", ")} could not be read when this prompt was saved.`,
        );
      }
      if (unrestoredImageNames.length > 0) {
        missingImageReasons.push(
          `${unrestoredImageNames.join(", ")} could not be restored: the composer is at its ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}-image limit.`,
        );
      }
      if (missingImageReasons.length > 0) {
        toastManager.add({
          type: "warning",
          title: "Some images were not restored",
          description: missingImageReasons.join(" "),
        });
      }

      // Only yank the caret to the end when text was actually inserted;
      // restoring images alone should leave the user where they were typing.
      if (promptChanged) {
        window.requestAnimationFrame(() => {
          composerEditorRef.current?.focusAtEnd();
        });
      }
    },
    [
      addComposerDraftImages,
      composerDraftTarget,
      composerImagesRef,
      promptRef,
      setComposerDraftPrompt,
      takeStashEntry,
    ],
  );

  const deleteStashEntry = useCallback(
    (entry: PromptStashEntry) => {
      const { durable } = takeStashEntry(entry.id);
      if (!durable) {
        toastManager.add({
          type: "warning",
          title: "Stash entry may come back",
          description:
            "Browser storage rejected the delete, so this prompt could reappear after a reload.",
          data: { hideCopyButton: true },
        });
      }
    },
    [takeStashEntry],
  );

  const stashCurrentPrompt = useCallback(async () => {
    // Terminal-context placeholders reference live sessions the stash can't
    // round-trip, so they are stripped from the stashed prompt.
    const prompt = promptRef.current.split(INLINE_TERMINAL_CONTEXT_PLACEHOLDER).join("").trim();
    const images = [...composerImagesRef.current];
    if (prompt.length === 0 && images.length === 0) {
      setIsStashMenuOpen((open) => !open);
      return;
    }
    // A repeat ⌘S on the *same* still-unencoded snapshot would stash it
    // twice. Guard on the snapshot itself rather than a bare boolean: once
    // the composer has been cleared the user can type something genuinely
    // new (or switch threads) while encoding continues, and that deserves its
    // own entry.
    const snapshotKey = `${String(composerDraftTarget)}\0${prompt}\0${images
      .map((image) => image.id)
      .join(",")}`;
    if (stashInFlightRef.current.has(snapshotKey)) return;
    stashInFlightRef.current.add(snapshotKey);

    const stashTarget = composerDraftTarget;
    const entryId = randomUUID();
    try {
      // Persist the text-only entry *first*, then clear. Ordering matters in
      // both directions: writing before clearing means a crash or closed tab
      // mid-encode still leaves the prompt recoverable, while clearing before
      // the async image work means edits typed during encoding are not wiped.
      // Images are appended to the stored entry as they finish encoding.
      const { evicted, written, durable } = stashEntryToQueue({
        id: entryId,
        createdAt: new Date().toISOString(),
        prompt,
        attachments: [],
        droppedImageNames: [],
        unreadableImageNames: [],
        pendingImageCount: images.length,
      });

      // Clearing the composer is only safe once the write actually landed.
      // If it was rejected (quota) the store has already rolled itself back,
      // so leave the composer untouched rather than making it the second
      // casualty of a reload.
      if (!written) {
        toastManager.add({
          type: "error",
          title: "Could not stash this prompt",
          description:
            "Browser storage rejected the write, so the composer was left as-is. Free up site data and try again.",
          data: { hideCopyButton: true },
        });
        return;
      }
      // Written but only into the in-memory fallback (localStorage blocked):
      // the entry is visible and restorable this session, so proceed with the
      // clear, but say it won't survive a reload.
      if (!durable) {
        toastManager.add({
          type: "warning",
          title: "Stashed prompt will not survive a reload",
          description:
            "Browser storage is unavailable, so this stash is kept in memory only for this session.",
          data: { hideCopyButton: true },
        });
      }

      // Only the prompt and images are cleared — terminal/element contexts,
      // preview annotations, and review comments are not stashable, so
      // destroying them here would be unrecoverable.
      promptRef.current = "";
      clearComposerDraftPromptAndImages(stashTarget);
      setComposerCursor(0);
      setComposerTrigger(null);
      pulseStashBadge();

      if (evicted) {
        toastManager.add({
          type: "warning",
          title: "Oldest stashed prompt discarded",
          description: `The stash holds ${MAX_STASH_ENTRIES} prompts; the oldest was removed to make room.`,
          data: { hideCopyButton: true },
        });
      }

      // Images are re-encoded for the stash rather than stored verbatim: the
      // composer allows up to 10MB per image, but localStorage gives the whole
      // origin ~5MB. Only the stashed copy shrinks; the live attachment (and
      // anything sent without stashing) keeps the original file.
      const candidateAttachments: PersistedComposerImageAttachment[] = [];
      const oversizedImageNames: string[] = [];
      const unreadableImageNames: string[] = [];
      for (const image of images) {
        const result = await compressImageForStash(image.file);
        if (!result.ok) {
          // "too large" and "could not be read" are distinct outcomes; the
          // menu and restore toast report them separately.
          (result.reason === "too-large" ? oversizedImageNames : unreadableImageNames).push(
            image.name,
          );
          continue;
        }
        candidateAttachments.push({
          id: image.id,
          name: image.name,
          mimeType: result.image.mimeType,
          sizeBytes: result.image.sizeBytes,
          dataUrl: result.image.dataUrl,
        });
      }
      const { kept, droppedNames } = partitionStashAttachments(candidateAttachments);

      const { attached, durable: imagesDurable } = finalizeStashEntryImages(entryId, {
        attachments: kept,
        droppedImageNames: [...oversizedImageNames, ...droppedNames],
        unreadableImageNames,
      });
      if (attached) {
        // The second phase can be rejected on its own: the text-only entry
        // fit, but adding image payloads pushed past the quota. Disk would
        // then still hold the phase-one entry with pendingImageCount set,
        // which reads as an orphan after reload — so say so now. Gated on the
        // entry write having been durable: on the in-memory fallback nothing
        // is ever durable, and the session-only warning already covered it.
        if (!imagesDurable && durable && images.length > 0) {
          toastManager.add({
            type: "warning",
            title: "Stashed images were not saved",
            description:
              "The prompt was stashed, but browser storage rejected its images. They will be missing if you reload.",
            data: { hideCopyButton: true },
          });
        }
      } else if (kept.length > 0) {
        // The entry was restored or deleted before its images finished
        // encoding, so they have nowhere to land. Say so rather than letting
        // them evaporate.
        toastManager.add({
          type: "warning",
          title: "Stashed images did not attach",
          description: `That prompt was restored or deleted before ${kept.length} image${kept.length === 1 ? "" : "s"} finished saving. Re-attach ${kept.length === 1 ? "it" : "them"} if you still need ${kept.length === 1 ? "it" : "them"}.`,
          data: { hideCopyButton: true },
        });
      }
    } finally {
      // Must clear on every path: a throw that left this set would wedge this
      // snapshot's ⌘S until the composer remounts.
      stashInFlightRef.current.delete(snapshotKey);
    }
  }, [
    clearComposerDraftPromptAndImages,
    composerDraftTarget,
    composerImagesRef,
    finalizeStashEntryImages,
    promptRef,
    pulseStashBadge,
    stashEntryToQueue,
  ]);

  const toggleStashMenu = useCallback(() => {
    setIsStashMenuOpen((open) => !open);
  }, []);

  // Close the stash menu whenever the trigger-driven command menu opens so
  // the two popovers never stack in the same layer, and when the user
  // resumes typing (the menu is a transient picker, not a panel).
  useEffect(() => {
    if (composerMenuOpen) {
      setIsStashMenuOpen(false);
    }
  }, [composerMenuOpen]);
  useEffect(() => {
    setIsStashMenuOpen(false);
  }, [prompt]);

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: getTerminalFocusOwner() !== null,
          terminalOpen,
          modelPickerOpen: isComposerModelPickerOpen,
        },
      });
      if (command !== "composer.stash") return;
      // Always claim the shortcut so the browser save dialog never opens,
      // even when the composer is in a state that can't stash.
      event.preventDefault();
      event.stopPropagation();
      if (
        isCommandPaletteOpen() ||
        isComposerApprovalState ||
        pendingUserInputs.length > 0 ||
        projectSelectionRequired ||
        activePendingProgress !== null
      ) {
        return;
      }
      void stashCurrentPrompt();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [
    activePendingProgress,
    isComposerApprovalState,
    isComposerModelPickerOpen,
    keybindings,
    pendingUserInputs.length,
    projectSelectionRequired,
    stashCurrentPrompt,
    terminalOpen,
  ]);

  // ------------------------------------------------------------------
  // Callbacks: images
  // ------------------------------------------------------------------
  const addComposerImages = (files: File[]) => {
    if (files.length === 0) return;
    if (pendingUserInputs.length > 0) {
      toastManager.add({
        type: "error",
        title: "Attach images after answering plan questions.",
      });
      return;
    }
    const intake = classifyComposerFileIntake(files, {
      resolvePath: (file) => resolveOsFilePath(file, window.desktopBridge?.getPathForFile),
      imageSlotsUsed: composerImagesRef.current.length,
      maxImages: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
    });
    let error = intake.error;
    const nextImages: ComposerImageAttachment[] = intake.imageFiles.map((file) => ({
      type: "image",
      id: randomUUID(),
      name: file.name || "image",
      mimeType: file.type,
      sizeBytes: file.size,
      previewUrl: URL.createObjectURL(file),
      file,
    }));
    if (nextImages.length === 1 && nextImages[0]) {
      addComposerImage(nextImages[0]);
    } else if (nextImages.length > 1) {
      addComposerImagesToDraft(nextImages);
    }
    if (intake.referencedPaths.length > 0) {
      // Trailing space matters: a file link is chipped once a boundary closes
      // it, and every other insertion site writes `link + " "` for the same
      // reason.
      const inserted = insertComposerTextAtEnd(
        intake.referencedPaths.map((path) => `${serializeComposerFileLink(path)} `).join(""),
        { ensureLeadingBoundary: true },
      );
      if (!inserted) {
        error = "The composer is busy; drop the file again once it is ready.";
      }
    }
    setThreadError(activeThreadId, error);
  };

  const removeComposerImage = (imageId: string) => {
    removeComposerImageFromDraft(imageId);
  };

  const cutComposerContents = async () => {
    if (isCuttingComposerContents) return;
    const cutTarget = composerDraftTarget;
    const cutPrompt = composerEditorRef.current?.readSnapshot().value ?? promptRef.current;
    const cutImages = [...composerImagesRef.current];
    if (!hasTransferableComposerContent(cutPrompt, cutImages.length)) return;

    const transfer = stageComposerTransfer(
      cutPrompt,
      cutImages.map((image) => image.file),
    );
    setIsCuttingComposerContents(true);
    try {
      if (cutImages.length > 0 && !(await persistComposerTransfer(transfer))) {
        discardComposerTransfer(transfer.token);
        toastManager.add({
          type: "error",
          title: "Could not safely cut these images",
          description:
            "Browser storage could not preserve every attachment, so the composer was left unchanged.",
          data: { hideCopyButton: true },
        });
        return;
      }
      const copied = await writeComposerTransferToClipboard(
        transfer,
        cutImages.map((image) => image.file),
      );
      if (!copied) {
        discardComposerTransfer(transfer.token);
        toastManager.add({
          type: "error",
          title: "Could not cut this draft",
          description: "Clipboard access was rejected, so the composer was left unchanged.",
          data: { hideCopyButton: true },
        });
        return;
      }

      const currentImages = composerImagesRef.current;
      const currentPrompt = composerEditorRef.current?.readSnapshot().value ?? promptRef.current;
      const sourceIsUnchanged =
        currentPrompt === cutPrompt &&
        currentImages.length === cutImages.length &&
        currentImages.every((image, index) => image.id === cutImages[index]?.id);
      if (!sourceIsUnchanged) {
        toastManager.add({
          type: "info",
          title: "Draft copied",
          description:
            "Newer edits were kept in this composer. Paste into another chat to transfer the copied snapshot.",
          data: { hideCopyButton: true },
        });
        return;
      }

      promptRef.current = "";
      clearComposerDraftPromptAndImages(cutTarget);
      setComposerCursor(0);
      setComposerTrigger(null);
      setEditorHasText(false);
      toastManager.add({
        type: "success",
        title: "Draft cut",
        description: "Paste into another chat to move the text and attachments.",
        data: { hideCopyButton: true },
      });
    } finally {
      setIsCuttingComposerContents(false);
    }
  };

  // ------------------------------------------------------------------
  // Callbacks: paste / drag
  // ------------------------------------------------------------------
  const onComposerPaste = (event: React.ClipboardEvent<HTMLElement>) => {
    const clipboardText = event.clipboardData.getData("text/plain");
    const clipboardFiles = readClipboardImageFiles(event.clipboardData);
    const immediateTransfer = readComposerTransferFromClipboard(event.clipboardData);
    const needsDurableRestore =
      immediateTransfer === null && hasPersistedComposerTransfer(event.clipboardData);
    const applyPastePlan = (plan: ReturnType<typeof planComposerPaste>) => {
      if (!plan.handled) return;
      if (plan.prompt !== null) {
        // Preventing the default paste also suppresses the browser's own text
        // insertion, so text arriving beside an image has to be inserted here.
        const snapshot = composerEditorRef.current?.readSnapshot();
        if (snapshot && snapshot.value !== promptRef.current) {
          promptRef.current = snapshot.value;
        }
        const cursor = snapshot?.expandedCursor ?? promptRef.current.length;
        applyPromptReplacement(cursor, cursor, plan.prompt);
      }
      if (plan.files.length > 0) {
        addComposerImages([...plan.files]);
      }
    };

    if (!needsDurableRestore) {
      const plan = planComposerPaste({
        transfer: immediateTransfer,
        clipboardText,
        clipboardFiles,
      });
      if (!plan.handled) return;
      event.preventDefault();
      applyPastePlan(plan);
      return;
    }

    // Hold the browser's default text insertion while IndexedDB returns every
    // staged image. If storage unexpectedly fails, insert the text ourselves
    // and report the missing images rather than silently delivering half a cut.
    event.preventDefault();
    void resolveComposerTransferFromClipboard(event.clipboardData).then((transfer) => {
      const plan = planComposerPaste({ transfer, clipboardText, clipboardFiles });
      if (plan.handled) {
        applyPastePlan(plan);
        return;
      }
      if (clipboardText.length > 0) {
        applyPastePlan({ handled: true, prompt: clipboardText, files: [] });
      }
      toastManager.add({
        type: "error",
        title: "Could not restore cut images",
        description:
          "The prompt text was kept, but browser storage could not read the staged attachments.",
        data: { hideCopyButton: true },
      });
    });
  };

  const onComposerDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOverComposer(true);
  };

  const onComposerDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDragOverComposer(true);
  };

  const onComposerDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragOverComposer(false);
    }
  };

  const onComposerDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
    const files = Array.from(event.dataTransfer.files);
    addComposerImages(files);
    focusComposer();
  };

  const insertComposerTextAtEnd = (
    text: string,
    options?: { ensureLeadingBoundary?: boolean },
  ): boolean => {
    if (
      text.length === 0 ||
      isConnecting ||
      isComposerApprovalState ||
      pendingUserInputs.length > 0 ||
      projectSelectionRequired
    ) {
      return false;
    }
    const prompt = promptRef.current;
    const needsLeadingSpace =
      (options?.ensureLeadingBoundary ?? false) && prompt.length > 0 && !/\s$/.test(prompt);
    return applyPromptReplacement(
      prompt.length,
      prompt.length,
      needsLeadingSpace ? ` ${text}` : text,
    );
  };

  // File-tree drags land as mentions. Handled in the capture phase so the
  // editor never sees the drop; the load-bearing rules (native stop, "move"
  // effect, no eager focus) live in makeComposerMentionDragHandlers.
  const composerMentionDragHandlers = makeComposerMentionDragHandlers({
    insertMentionAtEnd: (text) => insertComposerTextAtEnd(text, { ensureLeadingBoundary: true }),
    setDragActive: setIsDragOverComposer,
    onInsertRejected: () => {
      toastManager.add({
        type: "error",
        title: "Unable to add to chat",
        description: "The composer is busy; try again once it is ready.",
      });
    },
  });

  const onComposerMentionDragLeaveCapture = (event: React.DragEvent<HTMLDivElement>) => {
    if (!dataTransferHasComposerMention(event.dataTransfer.types)) return;
    event.stopPropagation();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setIsDragOverComposer(false);
  };

  // A cancelled drag (Escape) can end without a dragleave on the hovered
  // target, which would leave the drop highlight stuck. dragend always fires
  // on the in-page drag source and bubbles to window, so it is the reset of
  // last resort while the highlight is up.
  useEffect(() => {
    if (!isDragOverComposer) return;
    const onWindowDragEnd = () => {
      dragDepthRef.current = 0;
      setIsDragOverComposer(false);
    };
    window.addEventListener("dragend", onWindowDragEnd);
    return () => window.removeEventListener("dragend", onWindowDragEnd);
  }, [isDragOverComposer]);
  const handleInterruptPrimaryAction = useCallback(() => {
    void onInterrupt();
  }, [onInterrupt]);
  const handleImplementPlanInNewThreadPrimaryAction = useCallback(() => {
    void onImplementPlanInNewThread();
  }, [onImplementPlanInNewThread]);
  const scheduleComposerCollapseCheck = useCallback(() => {
    if (!isMobileViewport) {
      return;
    }
    if (mobileComposerExpandInFlightRef.current) {
      return;
    }
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
    }
    composerBlurFrameRef.current = window.requestAnimationFrame(() => {
      composerBlurFrameRef.current = null;
      if (mobileComposerExpandInFlightRef.current) {
        return;
      }
      const composerSurface = composerSurfaceRef.current;
      const activeElement = document.activeElement;
      if (activeElement instanceof Element && isInsideComposerFloatingLayer(activeElement)) {
        return;
      }
      if (
        composerSurface &&
        activeElement instanceof Node &&
        composerSurface.contains(activeElement)
      ) {
        return;
      }
      setIsComposerFocused(false);
    });
  }, [isMobileViewport]);

  useEffect(() => {
    return () => {
      if (composerBlurFrameRef.current !== null) {
        window.cancelAnimationFrame(composerBlurFrameRef.current);
      }
      if (mobileKeyboardDismissFrameRef.current !== null) {
        window.cancelAnimationFrame(mobileKeyboardDismissFrameRef.current);
      }
      if (mobileComposerExpandFrameRef.current !== null) {
        window.cancelAnimationFrame(mobileComposerExpandFrameRef.current);
      }
      if (mobileComposerExpandReleaseFrameRef.current !== null) {
        window.cancelAnimationFrame(mobileComposerExpandReleaseFrameRef.current);
      }
    };
  }, []);

  // ------------------------------------------------------------------
  // Imperative handle
  // ------------------------------------------------------------------
  useImperativeHandle(
    composerRef,
    () => ({
      focusAtEnd: () => {
        composerEditorRef.current?.focusAtEnd();
      },
      focusAt: (cursor: number) => {
        composerEditorRef.current?.focusAt(cursor);
      },
      insertTextAtEnd: insertComposerTextAtEnd,
      applyVoiceTranscript: (transcript: string) => {
        const pendingQuestionId = activePendingProgress?.activeQuestion?.id ?? null;
        const update = resolveVoiceTranscriptInputUpdate({
          currentPrompt:
            activePendingProgress?.activeQuestion === null || activePendingProgress === null
              ? promptRef.current
              : activePendingProgress.customAnswer,
          transcript,
          pendingQuestionId,
        });
        const nextExpandedCursor = update.prompt.length;
        const nextCursor = collapseExpandedComposerCursor(update.prompt, nextExpandedCursor);

        promptRef.current = update.prompt;
        if (update.target.kind === "pending-user-input") {
          onChangeActivePendingUserInputCustomAnswer(
            update.target.questionId,
            update.prompt,
            nextCursor,
            nextExpandedCursor,
            false,
          );
        } else {
          setPrompt(update.prompt);
        }
        setComposerHighlightedItemId(null);
        setComposerCursor(nextCursor);
        setComposerTrigger(null);
        return update;
      },
      openModelPicker: () => {
        setIsComposerModelPickerOpen(true);
      },
      toggleModelPicker: () => {
        setIsComposerModelPickerOpen((open) => !open);
      },
      isModelPickerOpen: () => isComposerModelPickerOpen,
      readSnapshot: () => {
        return readComposerSnapshot();
      },
      resetCursorState: (options?: {
        cursor?: number;
        prompt?: string;
        detectTrigger?: boolean;
      }) => {
        const promptForState = options?.prompt ?? promptRef.current;
        const cursor = clampCollapsedComposerCursor(promptForState, options?.cursor ?? 0);
        setComposerHighlightedItemId(null);
        setComposerCursor(cursor);
        setComposerTrigger(
          options?.detectTrigger
            ? detectComposerTrigger(
                promptForState,
                expandCollapsedComposerCursor(promptForState, cursor),
              )
            : null,
        );
      },
      addTerminalContext: (selection: TerminalContextSelection) => {
        if (!activeThread) return;
        const snapshot = composerEditorRef.current?.readSnapshot() ?? {
          value: promptRef.current,
          cursor: composerCursor,
          expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
          terminalContextIds: composerTerminalContexts.map((context) => context.id),
        };
        const insertion = insertInlineTerminalContextPlaceholder(
          snapshot.value,
          snapshot.expandedCursor,
        );
        const nextCollapsedCursor = collapseExpandedComposerCursor(
          insertion.prompt,
          insertion.cursor,
        );
        const inserted = insertComposerDraftTerminalContext(
          composerDraftTarget,
          insertion.prompt,
          {
            id: randomUUID(),
            threadId: activeThread.id,
            createdAt: new Date().toISOString(),
            ...selection,
          },
          insertion.contextIndex,
        );
        if (!inserted) return;
        promptRef.current = insertion.prompt;
        setComposerCursor(nextCollapsedCursor);
        setComposerTrigger(detectComposerTrigger(insertion.prompt, insertion.cursor));
        window.requestAnimationFrame(() => {
          composerEditorRef.current?.focusAt(nextCollapsedCursor);
        });
      },
      getSendContext: () => ({
        prompt: promptRef.current,
        images: composerImagesRef.current,
        terminalContexts: composerTerminalContextsRef.current,
        elementContexts: composerElementContextsRef.current,
        previewAnnotations: composerPreviewAnnotations,
        reviewComments: composerReviewComments,
        selectedPromptEffort,
        selectedModelOptionsForDispatch,
        selectedModelSelection,
        providerAvailable: !noProviderAvailable,
        selectedProvider,
        selectedModel,
        selectedProviderModels,
      }),
    }),
    [
      activePendingProgress,
      activeThread,
      composerDraftTarget,
      composerCursor,
      composerTerminalContexts,
      insertComposerDraftTerminalContext,
      promptRef,
      composerImagesRef,
      composerTerminalContextsRef,
      composerElementContextsRef,
      composerPreviewAnnotations,
      composerReviewComments,
      isConnecting,
      isComposerApprovalState,
      pendingUserInputs.length,
      projectSelectionRequired,
      applyPromptReplacement,
      isComposerModelPickerOpen,
      readComposerSnapshot,
      selectedModel,
      selectedModelOptionsForDispatch,
      selectedModelSelection,
      noProviderAvailable,
      onChangeActivePendingUserInputCustomAnswer,
      setPrompt,
      selectedPromptEffort,
      selectedProvider,
      selectedProviderModels,
    ],
  );

  // Render
  // ------------------------------------------------------------------
  return (
    <form
      ref={composerFormRef}
      onSubmit={submitComposer}
      className="chat-composer-measure min-w-0 overscroll-none"
      data-chat-composer-form="true"
    >
      <div
        className={cn(
          "group rounded-[22px] p-px transition-colors duration-200",
          composerProviderState.composerFrameClassName,
        )}
        onDragEnter={onComposerDragEnter}
        onDragOver={onComposerDragOver}
        onDragLeave={onComposerDragLeave}
        onDrop={onComposerDrop}
        onDragEnterCapture={composerMentionDragHandlers.onDragEnter}
        onDragOverCapture={composerMentionDragHandlers.onDragOver}
        onDragLeaveCapture={onComposerMentionDragLeaveCapture}
        onDropCapture={composerMentionDragHandlers.onDrop}
      >
        <div
          ref={composerSurfaceRef}
          data-chat-composer-mobile-collapsed={isComposerCollapsedMobile ? "true" : "false"}
          className={cn(
            "rounded-[20px] transition-[background-color] duration-200",
            isDragOverComposer ? "bg-accent/45 ring-1 ring-primary/70" : null,
            projectSelectionRequired ? "opacity-75" : null,
            composerProviderState.composerSurfaceClassName,
          )}
          onFocusCapture={(event) => {
            const activeElement = event.target;
            if (
              isComposerCollapsedMobile &&
              activeElement instanceof HTMLElement &&
              activeElement.closest('[data-chat-composer-collapsed-controls="true"]')
            ) {
              return;
            }
            if (composerBlurFrameRef.current !== null) {
              window.cancelAnimationFrame(composerBlurFrameRef.current);
              composerBlurFrameRef.current = null;
            }
            setIsComposerFocused(true);
          }}
          onBlurCapture={() => {
            scheduleComposerCollapseCheck();
          }}
        >
          {!isComposerCollapsedMobile &&
            (activePendingApproval ? (
              <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                <ComposerPendingApprovalPanel
                  approval={activePendingApproval}
                  pendingCount={pendingApprovals.length}
                />
              </div>
            ) : pendingUserInputs.length > 0 ? (
              <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                <ComposerPendingUserInputPanel
                  pendingUserInputs={pendingUserInputs}
                  respondingRequestIds={respondingUserInputRequestIds}
                  answers={activePendingDraftAnswers}
                  questionIndex={activePendingQuestionIndex}
                  onToggleOption={onSelectActivePendingUserInputOption}
                  onAdvance={onAdvanceActivePendingUserInput}
                />
              </div>
            ) : showPlanFollowUpPrompt && activeProposedPlan ? (
              <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                <ComposerPlanFollowUpBanner
                  key={activeProposedPlan.id}
                  planTitle={proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null}
                />
              </div>
            ) : null)}

          {isComposerCollapsedMobile && activePendingApproval ? (
            <div
              className="rounded-t-[19px] border-b border-border/65 bg-muted/20"
              data-chat-composer-collapsed-controls="true"
            >
              <ComposerPendingApprovalPanel
                approval={activePendingApproval}
                pendingCount={pendingApprovals.length}
              />
              <div className="flex flex-wrap items-center justify-end gap-2 px-3 pb-3 sm:px-4">
                <ComposerPendingApprovalActions
                  requestId={activePendingApproval.requestId}
                  isResponding={respondingRequestIds.includes(activePendingApproval.requestId)}
                  onRespondToApproval={onRespondToApproval}
                />
              </div>
            </div>
          ) : isComposerCollapsedMobile && pendingUserInputs.length > 0 ? (
            <div
              className="rounded-t-[19px] border-b border-border/65 bg-muted/20"
              data-chat-composer-collapsed-controls="true"
            >
              <ComposerPendingUserInputPanel
                pendingUserInputs={pendingUserInputs}
                respondingRequestIds={respondingUserInputRequestIds}
                answers={activePendingDraftAnswers}
                questionIndex={activePendingQuestionIndex}
                onToggleOption={onSelectActivePendingUserInputOption}
                onAdvance={onAdvanceActivePendingUserInput}
              />
              <div className="px-3 pb-3 sm:px-4">
                <div
                  data-chat-composer-mobile-pending-compact="true"
                  className={cn(
                    "flex min-w-0 items-center gap-2 rounded-lg border border-border/55 bg-background/55 p-1.5 pl-3 transition-colors hover:bg-background/80",
                    !activePendingProgress?.activeQuestion?.multiSelect && "p-0",
                  )}
                >
                  <button
                    type="button"
                    className={cn(
                      "min-w-0 flex-1 truncate bg-transparent py-1.5 text-left text-sm",
                      activePendingProgress?.customAnswer
                        ? "text-foreground"
                        : "text-muted-foreground/60",
                      !activePendingProgress?.activeQuestion?.multiSelect && "px-3 py-2",
                    )}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={expandMobileComposer}
                    aria-label="Write custom answer"
                  >
                    {activePendingProgress?.customAnswer || "Write custom answer"}
                  </button>
                  {activePendingProgress?.activeQuestion?.multiSelect ? (
                    <ComposerPrimaryActions
                      compact
                      pendingAction={pendingPrimaryAction}
                      isRunning={false}
                      showPlanFollowUpPrompt={false}
                      promptHasText={false}
                      isSendBusy={isSendBusy}
                      sendDisabledReason={sendDisabledReason}
                      isConnecting={isConnecting}
                      isEnvironmentUnavailable={
                        environmentUnavailable !== null ||
                        noProviderAvailable ||
                        projectSelectionRequired
                      }
                      isPreparingWorktree={false}
                      hasSendableContent={false}
                      pushToTalkStatus={pushToTalkStatus}
                      preserveComposerFocusOnPointerDown
                      onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                      onInterrupt={handleInterruptPrimaryAction}
                      onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryAction}
                    />
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}

          {showCollapsedMobilePromptRow ? (
            <div className="flex items-center justify-between gap-2 px-3 py-2">
              <button
                type="button"
                className={cn(
                  "min-w-0 flex-1 truncate bg-transparent p-0 text-left text-[14px] focus:outline-none",
                  (activePendingProgress ? activePendingProgress.customAnswer : prompt.trim())
                    ? "text-foreground"
                    : "text-muted-foreground/35",
                )}
                onPointerDown={(event) => event.preventDefault()}
                onClick={expandMobileComposer}
                aria-label="Expand composer"
              >
                {activePendingProgress
                  ? activePendingProgress.customAnswer ||
                    "Type your own answer, or leave this blank to use the selected option"
                  : prompt.trim() ||
                    (noProviderAvailable
                      ? "Selected provider unavailable on this environment"
                      : "Ask anything...")}
              </button>
              <button
                type="button"
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-full text-white disabled:opacity-30",
                  isInterruptible ? "bg-destructive/90" : "bg-primary/90 text-primary-foreground",
                )}
                disabled={collapsedComposerPrimaryActionDisabled}
                aria-label={collapsedComposerPrimaryActionLabel}
                onPointerDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.stopPropagation();
                  if (isInterruptible) {
                    handleInterruptPrimaryAction();
                  } else {
                    submitComposer();
                  }
                }}
              >
                {isInterrupting ? (
                  <Spinner className="size-3.5" aria-hidden="true" />
                ) : isInterruptible ? (
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <rect x="2" y="2" width="8" height="8" rx="1.5" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path
                      d="M8 3L8 13M8 3L4 7M8 3L12 7"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>
            </div>
          ) : null}

          <div
            ref={setComposerMenuAnchor}
            className={cn(
              "relative px-3 pb-2 sm:px-4",
              hasComposerHeader ? "pt-2.5 sm:pt-3" : "pt-3.5 sm:pt-4",
              isComposerCollapsedMobile && "hidden",
            )}
          >
            <ComposerStashBadge
              count={stashQueue.length}
              pulseKey={stashPulse.key}
              pulsing={stashPulse.active}
              menuOpen={isStashMenuOpen}
              onToggleMenu={toggleStashMenu}
            />

            {isStashMenuOpen && !composerMenuOpen && !isComposerApprovalState && (
              <ComposerCommandMenuLayer anchor={composerMenuAnchor}>
                <ComposerStashMenu
                  entries={stashQueue}
                  onRestore={restoreStashEntry}
                  onDelete={deleteStashEntry}
                  onClose={() => setIsStashMenuOpen(false)}
                />
              </ComposerCommandMenuLayer>
            )}

            {composerMenuOpen && !isComposerApprovalState && (
              <ComposerCommandMenuLayer anchor={composerMenuAnchor}>
                <ComposerCommandMenu
                  items={composerMenuItems}
                  resolvedTheme={resolvedTheme}
                  isLoading={isComposerMenuLoading}
                  triggerKind={composerTriggerKind}
                  groupSlashCommandSections={
                    composerTrigger?.kind === "slash-command" &&
                    composerTrigger.query.trim().length === 0
                  }
                  emptyStateText={composerMenuEmptyState}
                  activeItemId={activeComposerMenuItem?.id ?? null}
                  onHighlightedItemChange={onComposerMenuItemHighlighted}
                  onSelect={onSelectComposerItem}
                />
              </ComposerCommandMenuLayer>
            )}

            {!isComposerCollapsedMobile &&
              !isComposerApprovalState &&
              pendingUserInputs.length === 0 &&
              composerPreviewAnnotations.length > 0 && (
                <ComposerPreviewAnnotationCards
                  annotations={composerPreviewAnnotations}
                  images={composerImages}
                  onRemove={(annotationId) =>
                    removeComposerDraftPreviewAnnotation(composerDraftTarget, annotationId)
                  }
                  onExpandImage={(imageId) => {
                    const preview = buildExpandedImagePreview(composerImages, imageId);
                    if (preview) onExpandImage(preview);
                  }}
                  className="mb-3"
                />
              )}

            {!isComposerCollapsedMobile &&
              !isComposerApprovalState &&
              pendingUserInputs.length === 0 &&
              composerReviewComments.length > 0 && (
                <ComposerPendingReviewComments
                  comments={composerReviewComments}
                  onRemove={(commentId) =>
                    removeComposerDraftReviewComment(composerDraftTarget, commentId)
                  }
                  className="mb-3"
                />
              )}

            {!isComposerCollapsedMobile &&
              !isComposerApprovalState &&
              pendingUserInputs.length === 0 &&
              composerElementContexts.length > 0 && (
                <ComposerPendingElementContexts
                  contexts={composerElementContexts}
                  onRemove={(contextId) =>
                    removeComposerDraftElementContext(composerDraftTarget, contextId)
                  }
                  className="mb-3"
                />
              )}

            {!isComposerCollapsedMobile &&
              !isComposerApprovalState &&
              pendingUserInputs.length === 0 &&
              composerImages.some(
                (image) =>
                  !composerPreviewAnnotations.some((annotation) => annotation.id === image.id),
              ) && (
                <div className="mb-3 flex flex-wrap gap-2">
                  {composerImages
                    .filter(
                      (image) =>
                        !composerPreviewAnnotations.some(
                          (annotation) => annotation.id === image.id,
                        ),
                    )
                    .map((image) => (
                      <div
                        key={image.id}
                        className="relative h-16 w-16 overflow-hidden rounded-lg border border-border/80 bg-background"
                      >
                        {image.previewUrl ? (
                          <button
                            type="button"
                            className="h-full w-full cursor-zoom-in"
                            aria-label={`Preview ${image.name}`}
                            onClick={() => {
                              const preview = buildExpandedImagePreview(composerImages, image.id);
                              if (!preview) return;
                              onExpandImage(preview);
                            }}
                          >
                            <img
                              src={image.previewUrl}
                              alt={image.name}
                              className="h-full w-full object-cover"
                            />
                          </button>
                        ) : (
                          <div className="flex h-full w-full items-center justify-center px-1 text-center text-[10px] text-muted-foreground/70">
                            {image.name}
                          </div>
                        )}
                        {nonPersistedComposerImageIdSet.has(image.id) && (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <span
                                  role="img"
                                  aria-label="Draft attachment may not persist"
                                  className="absolute left-1 top-1 inline-flex items-center justify-center rounded bg-background/85 p-0.5 text-amber-600"
                                >
                                  <CircleAlertIcon className="size-3" />
                                </span>
                              }
                            />
                            <TooltipPopup
                              side="top"
                              className="max-w-64 whitespace-normal leading-tight"
                            >
                              Draft attachment could not be saved locally and may be lost on
                              navigation.
                            </TooltipPopup>
                          </Tooltip>
                        )}
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="absolute right-1 top-1 bg-background/80 hover:bg-background/90"
                          onClick={() => removeComposerImage(image.id)}
                          aria-label={`Remove ${image.name}`}
                        >
                          <XIcon />
                        </Button>
                      </div>
                    ))}
                </div>
              )}

            <div className="relative">
              <ComposerPromptEditor
                editorRef={composerEditorRef}
                value={
                  isComposerApprovalState
                    ? ""
                    : activePendingProgress
                      ? activePendingProgress.customAnswer
                      : prompt
                }
                cursor={composerCursor}
                terminalContexts={
                  !isComposerApprovalState && pendingUserInputs.length === 0
                    ? composerTerminalContexts
                    : []
                }
                skills={selectedProviderStatus?.skills ?? []}
                className={cn(
                  showMobilePendingAnswerActions && "max-sm:pb-11",
                  showComposerCutButton && "pr-16",
                )}
                onRemoveTerminalContext={removeComposerTerminalContextFromDraft}
                onChange={onPromptChange}
                onTextPresenceChange={setEditorHasText}
                onCommandKeyDown={onComposerCommandKey}
                onPaste={onComposerPaste}
                placeholder={
                  isComposerApprovalState
                    ? (activePendingApproval?.detail ?? "Resolve this approval request to continue")
                    : activePendingProgress
                      ? isActionApprovalQuestion(activePendingProgress.activeQuestion)
                        ? "Type corrections, or choose Approve above"
                        : "Type your own answer, or leave this blank to use the selected option"
                      : showPlanFollowUpPrompt && activeProposedPlan
                        ? "Add feedback to refine the plan, or leave this blank to implement it"
                        : projectSelectionRequired
                          ? "Choose a project above to start a thread"
                          : noProviderAvailable
                            ? "The selected provider is unavailable on this environment"
                            : phase === "disconnected"
                              ? "Ask for follow-up changes or attach images"
                              : "Ask anything, @tag files/folders, $use skills, or / for commands"
                }
                disabled={isConnecting || isComposerApprovalState || projectSelectionRequired}
              />
              {!isComposerApprovalState ? (
                <div
                  data-chat-composer-top-actions="true"
                  className="absolute right-0 top-0 z-10 flex items-center gap-1"
                >
                  <ComposerEmojiPicker
                    disabled={isConnecting || projectSelectionRequired}
                    hasTextUnderlay={currentEditorHasText}
                    onSelect={insertComposerEmoji}
                  />
                  {showComposerCutButton ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      data-chat-composer-cut="true"
                      className={cn(
                        "h-7 shrink-0 gap-1 rounded-md bg-background/90 px-2 text-xs text-muted-foreground shadow-sm ring-1 ring-border/50 transition-opacity duration-150 hover:text-foreground",
                        // Matches the emoji picker beside it: both float over
                        // the same text, so they have to recede together or the
                        // row reads as half-faded.
                        currentEditorHasText
                          ? "opacity-45 hover:opacity-100 focus-visible:opacity-100 active:opacity-100 max-sm:opacity-25"
                          : "opacity-100",
                      )}
                      disabled={isCuttingComposerContents}
                      aria-label="Cut draft text and attachments"
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => void cutComposerContents()}
                    >
                      <ScissorsIcon className="size-3" />
                      Cut
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {showMobilePendingAnswerActions ? (
                <div
                  data-chat-composer-mobile-pending-actions="true"
                  className="absolute bottom-0 right-0 flex justify-end"
                >
                  <ComposerPrimaryActions
                    compact
                    pendingAction={pendingPrimaryAction}
                    isRunning={false}
                    showPlanFollowUpPrompt={false}
                    promptHasText={false}
                    isSendBusy={isSendBusy}
                    sendDisabledReason={sendDisabledReason}
                    isConnecting={isConnecting}
                    isEnvironmentUnavailable={
                      environmentUnavailable !== null ||
                      noProviderAvailable ||
                      projectSelectionRequired
                    }
                    isPreparingWorktree={false}
                    hasSendableContent={false}
                    pushToTalkStatus={pushToTalkStatus}
                    preserveComposerFocusOnPointerDown
                    onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                    onInterrupt={handleInterruptPrimaryAction}
                    onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryAction}
                  />
                </div>
              ) : null}
            </div>
          </div>

          {/* Bottom toolbar */}
          {isComposerCollapsedMobile ? null : activePendingApproval ? (
            <div className="flex items-center justify-end gap-2 px-2.5 pb-2.5 sm:px-3 sm:pb-3">
              <ComposerPendingApprovalActions
                requestId={activePendingApproval.requestId}
                isResponding={respondingRequestIds.includes(activePendingApproval.requestId)}
                onRespondToApproval={onRespondToApproval}
              />
            </div>
          ) : (
            <div
              data-chat-composer-footer="true"
              data-chat-composer-footer-layout={composerFooterLayoutMode}
              data-chat-composer-footer-compact={
                composerFooterLayoutMode === "overflow" ? "true" : "false"
              }
              className={cn(
                "flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-2.5 pb-2.5 sm:px-3 sm:pb-3",
                pendingUserInputs.length > 0 && "pt-2",
                composerFooterLayoutMode === "full" ? "gap-2 sm:gap-0" : "gap-1.5",
                showMobilePendingAnswerActions && "hidden sm:flex",
              )}
            >
              <div className="-m-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {noProviderAvailable ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled
                    data-chat-provider-unavailable="true"
                    aria-label={
                      activeThreadProviderDisplayName
                        ? `${activeThreadProviderDisplayName} unavailable on this environment`
                        : "No provider available on this environment"
                    }
                    className={cn(
                      "shrink-0 gap-2 text-muted-foreground/70",
                      composerFooterLayoutMode === "full" ? "px-2 sm:px-3" : "size-7 px-0",
                    )}
                  >
                    <CircleAlertIcon className="size-4" />
                    {composerFooterLayoutMode === "full"
                      ? activeThreadProviderDisplayName
                        ? `${activeThreadProviderDisplayName} unavailable on this environment`
                        : "No provider available on this environment"
                      : null}
                  </Button>
                ) : (
                  <ProviderModelPicker
                    compact={composerFooterLayoutMode !== "full"}
                    iconOnly={composerFooterLayoutMode !== "full"}
                    activeInstanceId={selectedInstanceId}
                    model={selectedModelForPickerWithCustomFallback}
                    lockedProvider={lockedProvider}
                    lockedContinuationGroupKey={lockedContinuationGroupKey}
                    instanceEntries={providerInstanceEntries}
                    keybindings={keybindings}
                    modelOptionsByInstance={modelOptionsByInstance}
                    terminalOpen={terminalOpen}
                    open={isComposerModelPickerOpen}
                    {...(composerProviderState.modelPickerIconClassName
                      ? {
                          activeProviderIconClassName:
                            composerProviderState.modelPickerIconClassName,
                        }
                      : {})}
                    onOpenChange={(open) => {
                      setIsComposerModelPickerOpen(open);
                    }}
                    {...(getModelDisabledReason ? { getModelDisabledReason } : {})}
                    onInstanceModelChange={onProviderModelSelect}
                  />
                )}

                {composerFooterLayoutMode === "overflow" ? (
                  <CompactComposerControlsMenu
                    activePlan={showPlanSidebarToggle}
                    interactionMode={interactionMode}
                    planSidebarLabel={planSidebarLabel}
                    planSidebarOpen={planSidebarOpen}
                    runtimeMode={runtimeMode}
                    showInteractionModeToggle={composerProviderControls.showInteractionModeToggle}
                    traitsMenuContent={providerTraitsMenuContent}
                    onInteractionModeChange={setInteractionMode}
                    onTogglePlanSidebar={togglePlanSidebar}
                    onRuntimeModeChange={handleRuntimeModeChange}
                  />
                ) : (
                  <>
                    {providerTraitsPicker ? (
                      <>
                        <Separator
                          orientation="vertical"
                          className={cn(
                            "mx-0.5 hidden h-4 sm:block",
                            composerFooterLayoutMode === "icons" && "sm:hidden",
                          )}
                        />
                        {providerTraitsPicker}
                      </>
                    ) : null}
                    <ComposerFooterModeControls
                      iconOnly={composerFooterLayoutMode === "icons"}
                      showInteractionModeToggle={composerProviderControls.showInteractionModeToggle}
                      interactionMode={interactionMode}
                      runtimeMode={runtimeMode}
                      showPlanToggle={showPlanSidebarToggle}
                      planSidebarLabel={planSidebarLabel}
                      planSidebarOpen={planSidebarOpen}
                      onInteractionModeChange={setInteractionMode}
                      onRuntimeModeChange={handleRuntimeModeChange}
                      onTogglePlanSidebar={togglePlanSidebar}
                    />
                  </>
                )}
              </div>

              {/* Right side: send / stop button */}
              <div
                data-chat-composer-actions="right"
                data-chat-composer-primary-actions-compact={
                  isComposerPrimaryActionsCompact ? "true" : "false"
                }
                className="flex shrink-0 flex-nowrap items-center justify-end gap-2"
              >
                <ComposerFooterPrimaryActions
                  compact={isComposerPrimaryActionsCompact}
                  providers={providerStatuses}
                  activeProviderInstanceId={selectedInstanceId}
                  activeProviderAccountSwitch={activeProviderAccountSwitch}
                  activeContextWindow={activeContextWindow}
                  activeThreadProviderDisplayName={activeThreadProviderDisplayName}
                  activeThreadSupportsConfigurableAutoCompaction={
                    activeThreadSupportsConfigurableAutoCompaction
                  }
                  autoCompactionThresholdPercentage={settings.autoCompactionThresholdPercentage}
                  onAutoCompactionThresholdChange={onAutoCompactionThresholdChange}
                  pendingAction={pendingPrimaryAction}
                  isRunning={isInterruptible}
                  sendWhileRunning={sendWhileRunning}
                  showPlanFollowUpPrompt={pendingUserInputs.length === 0 && showPlanFollowUpPrompt}
                  promptHasText={currentEditorHasText}
                  isSendBusy={isSendBusy}
                  sendDisabledReason={sendDisabledReason}
                  isConnecting={isConnecting}
                  isEnvironmentUnavailable={
                    environmentUnavailable !== null ||
                    noProviderAvailable ||
                    projectSelectionRequired
                  }
                  isPreparingWorktree={isPreparingWorktree}
                  hasSendableContent={hasCurrentSendableContent}
                  pushToTalkStatus={pushToTalkStatus}
                  pushToTalkDisabled={pushToTalkDisabled}
                  pushToTalkDisabledReason={pushToTalkDisabledReason}
                  pushToTalkAutoSend={settings.autoSendVoiceTranscription}
                  settingsUpdateLabel={settingsUpdateLabel}
                  isApplyingSettings={isApplyingSettings}
                  isInterrupting={isInterrupting}
                  preserveComposerFocusOnPointerDown={isMobileViewport}
                  onPushToTalkStart={onPushToTalkStart}
                  onPushToTalkStop={onPushToTalkStop}
                  onApplySettings={() => {
                    if (settingsUpdateLabel) onApplySettings(settingsUpdateLabel);
                  }}
                  onRevertSettings={revertSettingsToThread}
                  onSwitchProviderAccount={onSwitchProviderAccount}
                  onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                  onInterrupt={handleInterruptPrimaryAction}
                  onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryAction}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </form>
  );
});
