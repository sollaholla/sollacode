import type { ContextMenuItem } from "@t3tools/contracts";
import {
  memo,
  type KeyboardEventHandler,
  type MouseEventHandler,
  type PointerEventHandler,
} from "react";
import { ChevronDownIcon, ChevronLeftIcon, MicIcon, RefreshCwIcon } from "lucide-react";
import { useEnvironmentIdentificationMode } from "~/hooks/useSettings";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { isElectron } from "../../env";
import { shouldOfferAppVoiceCapture } from "./appVoiceCaptureAvailability";
import { StageBackdropButtonArt, useSidebarStageBackdropVariant } from "../SidebarStageBackdrop";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface PendingActionState {
  questionIndex: number;
  isLastQuestion: boolean;
  canAdvance: boolean;
  isResponding: boolean;
  isComplete: boolean;
  submitLabel?: string;
}

interface ComposerPrimaryActionsProps {
  compact: boolean;
  pendingAction: PendingActionState | null;
  isRunning: boolean;
  sendWhileRunning?: boolean;
  showPlanFollowUpPrompt: boolean;
  promptHasText: boolean;
  isSendBusy: boolean;
  sendDisabledReason: string | null;
  isConnecting: boolean;
  isEnvironmentUnavailable: boolean;
  isPreparingWorktree: boolean;
  hasSendableContent: boolean;
  pushToTalkStatus?: "recording" | "loading" | "transcribing" | "refining" | null;
  pushToTalkDisabled?: boolean;
  pushToTalkDisabledReason?: string | null;
  pushToTalkAutoSend?: boolean;
  settingsUpdateLabel?: string | null;
  isApplyingSettings?: boolean;
  isInterrupting?: boolean;
  hasQueuedSendNow?: boolean;
  isPromotingQueued?: boolean;
  preserveComposerFocusOnPointerDown?: boolean;
  onPushToTalkStart?: () => void;
  onPushToTalkStop?: () => void;
  onApplySettings?: () => void;
  onRevertSettings?: () => void;
  onPromoteQueued?: () => void;
  onPreviousPendingQuestion: () => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;
}

export const formatPendingPrimaryActionLabel = (input: {
  compact: boolean;
  isLastQuestion: boolean;
  isResponding: boolean;
  questionIndex: number;
  submitLabel?: string;
}) => {
  if (input.isResponding) {
    return "Submitting...";
  }
  if (input.compact) {
    return input.isLastQuestion ? "Submit" : "Next";
  }
  if (!input.isLastQuestion) {
    return "Next question";
  }
  if (input.submitLabel) {
    return input.submitLabel;
  }
  return input.questionIndex > 0 ? "Submit answers" : "Submit answer";
};

export const formatPushToTalkActionLabel = (
  status: "recording" | "loading" | "transcribing" | "refining" | null,
  platform: string | undefined,
  disabledReason?: string | null,
  autoSend = false,
): string => {
  const shortcut = platform?.toLowerCase().includes("mac") === true ? "Cmd+D" : "Ctrl+D";
  switch (status) {
    case "recording":
      return `Mute microphone — release to ${
        autoSend ? "transcribe and send" : "transcribe"
      } (${shortcut})`;
    case "loading":
      return `Loading local transcription model (${shortcut})`;
    case "transcribing":
      return `Transcribing voice message (${shortcut})`;
    case "refining":
      return `Refining voice transcription (${shortcut})`;
    default:
      if (disabledReason) {
        return `${disabledReason} (${shortcut})`;
      }
      return `Unmute microphone — hold to record (${shortcut})`;
  }
};

type SettingsUpdateContextMenuAction = "revert";

export const SETTINGS_UPDATE_CONTEXT_MENU_ITEMS = [
  { id: "revert", label: "Revert" },
] as const satisfies readonly ContextMenuItem<SettingsUpdateContextMenuAction>[];

export async function showSettingsUpdateContextMenu(input: {
  readonly position: { readonly x: number; readonly y: number };
  readonly showContextMenu: (
    items: readonly ContextMenuItem<SettingsUpdateContextMenuAction>[],
    position: { readonly x: number; readonly y: number },
  ) => Promise<SettingsUpdateContextMenuAction | null>;
  readonly onRevert: () => void;
}): Promise<void> {
  const action = await input.showContextMenu(SETTINGS_UPDATE_CONTEXT_MENU_ITEMS, input.position);
  if (action === "revert") input.onRevert();
}

const preventPointerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};

const noop = () => undefined;

export const ComposerPrimaryActions = memo(function ComposerPrimaryActions({
  compact,
  pendingAction,
  isRunning,
  sendWhileRunning = false,
  showPlanFollowUpPrompt,
  promptHasText,
  isSendBusy,
  sendDisabledReason,
  isConnecting,
  isEnvironmentUnavailable,
  isPreparingWorktree,
  hasSendableContent,
  pushToTalkStatus = null,
  pushToTalkDisabled = true,
  pushToTalkDisabledReason = null,
  pushToTalkAutoSend = false,
  settingsUpdateLabel = null,
  isApplyingSettings = false,
  isInterrupting = false,
  hasQueuedSendNow = false,
  isPromotingQueued = false,
  preserveComposerFocusOnPointerDown = false,
  onPushToTalkStart = noop,
  onPushToTalkStop = noop,
  onApplySettings = noop,
  onRevertSettings = noop,
  onPromoteQueued = noop,
  onPreviousPendingQuestion,
  onInterrupt,
  onImplementPlanInNewThread,
}: ComposerPrimaryActionsProps) {
  const pointerFocusProps = preserveComposerFocusOnPointerDown
    ? { onPointerDown: preventPointerFocus }
    : undefined;
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const hasCoarsePointer = useMediaQuery({ pointer: "coarse" });
  const showAppMicrophone = shouldOfferAppVoiceCapture({
    isDesktopElectron: isElectron,
    hasCoarsePointer,
  });
  const isSendDisabled = sendDisabledReason !== null;
  const stageBackdropVariant = useSidebarStageBackdropVariant(
    environmentIdentificationMode === "artwork",
  );
  const pushToTalkActive = pushToTalkStatus === "recording";
  const microphoneDisabled = pushToTalkDisabled && !pushToTalkActive;
  const pushToTalkLabel = formatPushToTalkActionLabel(
    pushToTalkStatus,
    typeof navigator === "undefined" ? undefined : navigator.platform,
    microphoneDisabled ? pushToTalkDisabledReason : null,
    pushToTalkAutoSend,
  );
  const settingsUpdateIconOnly = compact || isRunning;
  const startPushToTalkOnKey: KeyboardEventHandler<HTMLButtonElement> = (event) => {
    if (microphoneDisabled || event.repeat || (event.key !== " " && event.key !== "Enter")) {
      return;
    }
    event.preventDefault();
    onPushToTalkStart();
  };
  const stopPushToTalkOnKey: KeyboardEventHandler<HTMLButtonElement> = (event) => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    onPushToTalkStop();
  };
  const startPushToTalkOnPointer: PointerEventHandler<HTMLButtonElement> = (event) => {
    if (microphoneDisabled || event.button !== 0) return;
    if (preserveComposerFocusOnPointerDown) event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    onPushToTalkStart();
  };
  const stopPushToTalkOnPointer: PointerEventHandler<HTMLButtonElement> = (event) => {
    onPushToTalkStop();
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const showSettingsContextMenu: MouseEventHandler<HTMLButtonElement> = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const api = readLocalApi();
    if (!api) return;
    void showSettingsUpdateContextMenu({
      position: { x: event.clientX, y: event.clientY },
      showContextMenu: api.contextMenu.show,
      onRevert: onRevertSettings,
    });
  };
  const microphoneAction = showAppMicrophone ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(
              "flex h-9 w-9 items-center justify-center rounded-full border text-muted-foreground shadow-xs transition-all duration-150 enabled:cursor-pointer hover:scale-105 active:shadow-none aria-disabled:cursor-not-allowed aria-disabled:opacity-30 aria-disabled:hover:scale-100 sm:h-8 sm:w-8",
              pushToTalkActive
                ? "border-destructive/70 bg-destructive/15 text-destructive ring-2 ring-destructive/20"
                : "border-border/70 bg-background/80 hover:border-border hover:bg-muted/70 hover:text-foreground",
            )}
            aria-disabled={microphoneDisabled}
            aria-label={pushToTalkLabel}
            aria-pressed={pushToTalkActive}
            title={pushToTalkLabel}
            onPointerDown={startPushToTalkOnPointer}
            onPointerUp={stopPushToTalkOnPointer}
            onPointerCancel={stopPushToTalkOnPointer}
            onLostPointerCapture={() => onPushToTalkStop()}
            onKeyDown={startPushToTalkOnKey}
            onKeyUp={stopPushToTalkOnKey}
          />
        }
      >
        {pushToTalkStatus === "loading" ||
        pushToTalkStatus === "transcribing" ||
        pushToTalkStatus === "refining" ? (
          <Spinner className="size-3.5" aria-hidden="true" />
        ) : (
          <MicIcon
            className={cn("size-4", pushToTalkActive && "animate-pulse")}
            aria-hidden="true"
          />
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">{pushToTalkLabel}</TooltipPopup>
    </Tooltip>
  ) : null;
  const settingsUpdateAction = settingsUpdateLabel ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size={settingsUpdateIconOnly ? "icon-sm" : "sm"}
            variant="outline"
            className={cn(
              "rounded-full",
              settingsUpdateIconOnly ? "size-9 p-0 sm:size-8" : "h-9 px-3 sm:h-8",
            )}
            {...pointerFocusProps}
            disabled={
              isApplyingSettings ||
              isSendBusy ||
              isConnecting ||
              isEnvironmentUnavailable ||
              isPreparingWorktree
            }
            onClick={onApplySettings}
            onContextMenu={showSettingsContextMenu}
            aria-label={`Apply conversation changes: ${settingsUpdateLabel}`}
          />
        }
      >
        {isApplyingSettings ? (
          <Spinner className="size-3.5" aria-hidden="true" />
        ) : (
          <RefreshCwIcon className="size-3.5" aria-hidden="true" />
        )}
        {!settingsUpdateIconOnly ? (
          <span>{isApplyingSettings ? "Applying…" : "Apply changes"}</span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="top">{settingsUpdateLabel}</TooltipPopup>
    </Tooltip>
  ) : null;
  const queuedPromotionLabel = isPromotingQueued
    ? "Sending queued messages now"
    : "Send queued now";
  const queuedPromotionAction = hasQueuedSendNow ? (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="h-9 rounded-full px-3 sm:h-8"
      {...pointerFocusProps}
      disabled={
        isPromotingQueued ||
        isSendBusy ||
        isSendDisabled ||
        isConnecting ||
        isEnvironmentUnavailable ||
        isPreparingWorktree
      }
      onClick={onPromoteQueued}
      aria-label={queuedPromotionLabel}
    >
      {isPromotingQueued ? <Spinner className="size-3.5" aria-hidden="true" /> : null}
      <span>{isPromotingQueued ? "Sending queued…" : "Send queued now"}</span>
    </Button>
  ) : null;

  if (pendingAction) {
    return (
      <div className={cn("flex items-center justify-end", compact ? "gap-1.5" : "gap-2")}>
        {microphoneAction}
        {pendingAction.questionIndex > 0 ? (
          compact ? (
            <Button
              size="icon-sm"
              variant="outline"
              className="rounded-full"
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
              aria-label="Previous question"
            >
              <ChevronLeftIcon className="size-3.5" />
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="rounded-full"
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
            >
              Previous
            </Button>
          )
        ) : null}
        <Button
          type="submit"
          size="sm"
          className={cn("rounded-full", compact ? "px-3" : "px-4")}
          {...pointerFocusProps}
          disabled={
            isEnvironmentUnavailable ||
            pushToTalkStatus !== null ||
            pendingAction.isResponding ||
            (pendingAction.isLastQuestion ? !pendingAction.isComplete : !pendingAction.canAdvance)
          }
        >
          {formatPendingPrimaryActionLabel({
            compact,
            isLastQuestion: pendingAction.isLastQuestion,
            isResponding: pendingAction.isResponding,
            questionIndex: pendingAction.questionIndex,
            ...(pendingAction.submitLabel ? { submitLabel: pendingAction.submitLabel } : {}),
          })}
        </Button>
      </div>
    );
  }

  if (isRunning && !sendWhileRunning) {
    return (
      <div className="flex items-center justify-end gap-1.5">
        {settingsUpdateAction}
        {microphoneAction}
        {queuedPromotionAction}
        <button
          type="button"
          className="flex size-8 cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 inset-shadow-[0_1px_--theme(--color-white/16%)] transition-all duration-150 hover:bg-destructive hover:scale-105 active:inset-shadow-[0_1px_--theme(--color-black/8%)] active:shadow-none sm:h-8 sm:w-8"
          {...pointerFocusProps}
          onClick={onInterrupt}
          disabled={isInterrupting}
          aria-label={isInterrupting ? "Stopping generation" : "Stop generation"}
        >
          {isInterrupting ? (
            <Spinner className="size-3.5" aria-hidden="true" />
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
              <rect x="2" y="2" width="8" height="8" rx="1.5" />
            </svg>
          )}
        </button>
      </div>
    );
  }

  if (showPlanFollowUpPrompt) {
    if (promptHasText) {
      return (
        <div className="flex items-center justify-end gap-1.5">
          {microphoneAction}
          <Button
            type="submit"
            size="sm"
            className={cn("rounded-full", compact ? "h-9 px-3 sm:h-8" : "h-9 px-4 sm:h-8")}
            {...pointerFocusProps}
            disabled={
              isSendBusy ||
              isSendDisabled ||
              isConnecting ||
              isEnvironmentUnavailable ||
              pushToTalkStatus !== null
            }
          >
            {isConnecting || isSendBusy ? "Sending..." : "Refine"}
          </Button>
        </div>
      );
    }

    return (
      <div className="flex items-center justify-end gap-1.5">
        {microphoneAction}
        <div data-chat-composer-implement-actions="true" className="flex items-center justify-end">
          <Button
            type="submit"
            size="sm"
            className="h-9 rounded-l-full rounded-r-none px-4 sm:h-8"
            {...pointerFocusProps}
            disabled={
              isSendBusy ||
              isSendDisabled ||
              isConnecting ||
              isEnvironmentUnavailable ||
              pushToTalkStatus !== null
            }
          >
            {isConnecting || isSendBusy ? "Sending..." : "Implement"}
          </Button>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="sm"
                  variant="default"
                  className="h-9 rounded-l-none rounded-r-full border-l-white/12 px-2 sm:h-8"
                  aria-label="Implementation actions"
                  {...pointerFocusProps}
                  disabled={
                    isSendBusy || isSendDisabled || isConnecting || isEnvironmentUnavailable
                  }
                />
              }
            >
              <ChevronDownIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end" side="top">
              <MenuItem
                disabled={isSendBusy || isSendDisabled || isConnecting || isEnvironmentUnavailable}
                onClick={() => void onImplementPlanInNewThread()}
              >
                Implement in a new thread
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-end gap-1.5">
      {settingsUpdateAction}
      {microphoneAction}
      {queuedPromotionAction}

      <button
        type="submit"
        className={cn(
          "relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full text-primary-foreground shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-[0_1px_--theme(--color-white/16%)] hover:scale-105 active:inset-shadow-[0_1px_--theme(--color-black/8%)] active:shadow-none disabled:pointer-events-none disabled:opacity-30 disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8",
          stageBackdropVariant
            ? "bg-transparent enabled:shadow-black/24 enabled:hover:brightness-110"
            : "bg-primary/90 enabled:shadow-primary/24 hover:bg-primary",
        )}
        {...pointerFocusProps}
        // Reconnecting and disconnected deliberately do NOT disable this. A
        // disabled button swallows the click outright, so pressing send while
        // the socket was down did nothing at all and gave no reason — reported
        // from mobile Safari as needing a force-quit to escape. Left enabled,
        // the press reaches onSend, which says why it could not go. What stays
        // disabled is only what the button itself already explains: a send in
        // flight, an empty composer, a recording in progress.
        disabled={isSendBusy || isSendDisabled || pushToTalkStatus !== null || !hasSendableContent}
        aria-label={
          isEnvironmentUnavailable
            ? "Environment disconnected"
            : sendDisabledReason
              ? sendDisabledReason
              : pushToTalkStatus !== null
                ? pushToTalkLabel
                : isConnecting
                  ? "Connecting"
                  : isPreparingWorktree
                    ? "Preparing worktree"
                    : isSendBusy
                      ? "Sending"
                      : "Send message"
        }
      >
        {stageBackdropVariant ? (
          <span className="absolute inset-0 -z-10" aria-hidden="true">
            <StageBackdropButtonArt variant={stageBackdropVariant} />
          </span>
        ) : null}
        {isConnecting || isSendBusy ? (
          <Spinner className="size-3.5" aria-hidden="true" />
        ) : (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path
              d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </button>
    </div>
  );
});
