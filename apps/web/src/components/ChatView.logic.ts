import {
  type EnvironmentId,
  ProjectId,
  type ModelSelection,
  type OrchestrationThreadPendingWork,
  type ProviderDriverKind,
  isProviderDriverKind,
  type ServerProvider,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import type {
  ConnectionTargetKind,
  EnvironmentConnectionPhase,
} from "@t3tools/client-runtime/connection";
import {
  resolveQueuedTurnPromotionOutcome,
  type QueuedTurnPromotionOutcome,
} from "@t3tools/client-runtime/state/queued-turn-promotion";
import { type ChatMessage, type SessionPhase, type Thread, type ThreadShell } from "../types";
import { type ComposerImageAttachment, type DraftThreadState } from "../composerDraftStore";
import * as Schema from "effect/Schema";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadDetails } from "../state/threads";
import {
  filterTerminalContextsWithText,
  stripInlineTerminalContextPlaceholders,
  type TerminalContextDraft,
} from "../lib/terminalContext";
import type { DraftThreadEnvMode } from "../composerDraftStore";
import { RESUME_PROMPT } from "../resumePrompt";

export const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "t3code:last-invoked-script-by-project";
export const MAX_HIDDEN_MOUNTED_PREVIEW_THREADS = 3;

export const LastInvokedScriptByProjectSchema = Schema.Record(ProjectId, Schema.String);

export function shouldConfirmRemoteProviderAccountSwitch(input: {
  readonly activeEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  return (
    input.primaryEnvironmentId !== null && input.activeEnvironmentId !== input.primaryEnvironmentId
  );
}

export function canQueueLocalMessageDuringReconnect(input: {
  readonly targetKind: ConnectionTargetKind | null;
  readonly phase: EnvironmentConnectionPhase;
  readonly threadDetailLoaded: boolean;
}): boolean {
  return (
    input.targetKind === "PrimaryConnectionTarget" &&
    (input.phase === "connecting" || input.phase === "reconnecting") &&
    input.threadDetailLoaded
  );
}

export async function runResumeIncompleteTurn(input: {
  inFlightRef: { current: boolean };
  send: (message: typeof RESUME_PROMPT) => Promise<void>;
}): Promise<boolean> {
  if (input.inFlightRef.current) {
    return false;
  }
  input.inFlightRef.current = true;
  try {
    await input.send(RESUME_PROMPT);
    return true;
  } finally {
    input.inFlightRef.current = false;
  }
}

export type QueuedMessagePromotionPhase = "requesting" | "awaiting-projection";
export interface QueuedMessagePromotionState {
  readonly phase: QueuedMessagePromotionPhase;
  readonly messageIds: ReadonlyArray<string>;
  readonly requestId: string;
  readonly startedAtMs: number;
}
export type QueuedMessagePromotionPhases = Readonly<Record<string, QueuedMessagePromotionState>>;

/** Composer lock for "Sending queued…" if the provider never projects a terminal. */
export const QUEUED_MESSAGE_PROMOTION_STALE_MS = 20_000;

export function deriveQueuedGrokMessageIds(input: {
  readonly activeSessionProviderDriver: ProviderDriverKind | null | undefined;
  readonly phase: SessionPhase;
  readonly messages: ReadonlyArray<
    Pick<ChatMessage, "id" | "role" | "turnId" | "createdAt" | "voiceTranscript">
  >;
  readonly activeWorkStartedAt: string | null;
  readonly promotedMessageIds: ReadonlySet<string>;
  readonly pendingMessageIds: ReadonlySet<string>;
  readonly deliveredMessageIds: ReadonlySet<string>;
}): ReadonlyArray<ChatMessage["id"]> {
  if (input.activeSessionProviderDriver !== "grok" || input.phase !== "running") return [];
  return input.messages
    .filter(
      (message) =>
        message.role === "user" &&
        message.voiceTranscript !== true &&
        message.turnId === null &&
        (input.activeWorkStartedAt === null || message.createdAt > input.activeWorkStartedAt) &&
        !input.promotedMessageIds.has(message.id) &&
        !input.pendingMessageIds.has(message.id) &&
        !input.deliveredMessageIds.has(message.id),
    )
    .map((message) => message.id);
}

function setQueuedMessagePromotionPhase(input: {
  phasesRef: { current: QueuedMessagePromotionPhases };
  setPhases: (phases: QueuedMessagePromotionPhases) => void;
  threadKey: string;
  state: QueuedMessagePromotionState | null;
}): void {
  const phases = { ...input.phasesRef.current };
  if (input.state === null) {
    delete phases[input.threadKey];
  } else {
    phases[input.threadKey] = input.state;
  }
  input.phasesRef.current = phases;
  input.setPhases(phases);
}

export async function runQueuedMessagePromotion(input: {
  phasesRef: { current: QueuedMessagePromotionPhases };
  setPhases: (phases: QueuedMessagePromotionPhases) => void;
  threadKey: string;
  messageIds: ReadonlyArray<string>;
  requestId: string;
  promote: () => Promise<boolean>;
  onStart: () => void;
  onSuccess: () => void;
  onError: (error: unknown) => void;
}): Promise<boolean> {
  if (input.phasesRef.current[input.threadKey] !== undefined) return false;

  const startedAtMs = Date.now();
  setQueuedMessagePromotionPhase({
    ...input,
    state: {
      phase: "requesting",
      messageIds: input.messageIds,
      requestId: input.requestId,
      startedAtMs,
    },
  });
  input.onStart();
  const isCurrentRequest = () =>
    input.phasesRef.current[input.threadKey]?.requestId === input.requestId;
  try {
    const accepted = await input.promote();
    if (!isCurrentRequest()) return true;
    if (!accepted) {
      setQueuedMessagePromotionPhase({ ...input, state: null });
      return true;
    }
    setQueuedMessagePromotionPhase({
      ...input,
      state: {
        phase: "awaiting-projection",
        messageIds: input.messageIds,
        requestId: input.requestId,
        startedAtMs,
      },
    });
    input.onSuccess();
    return true;
  } catch (error) {
    if (!isCurrentRequest()) return true;
    input.onError(error);
    setQueuedMessagePromotionPhase({ ...input, state: null });
    return true;
  }
}

export function expireStaleQueuedMessagePromotion(input: {
  phasesRef: { current: QueuedMessagePromotionPhases };
  setPhases: (phases: QueuedMessagePromotionPhases) => void;
  threadKey: string;
  nowMs: number;
}): QueuedTurnPromotionOutcome | null {
  const state = input.phasesRef.current[input.threadKey];
  if (state === undefined) return null;
  if (input.nowMs - state.startedAtMs < QUEUED_MESSAGE_PROMOTION_STALE_MS) return null;
  setQueuedMessagePromotionPhase({ ...input, state: null });
  return {
    status: "failed",
    detail: "Sending queued messages timed out. Try Send queued now again.",
  };
}

export function settleQueuedMessagePromotion(input: {
  phasesRef: { current: QueuedMessagePromotionPhases };
  setPhases: (phases: QueuedMessagePromotionPhases) => void;
  threadKey: string;
  activities: Thread["activities"];
}): QueuedTurnPromotionOutcome | null {
  const state = input.phasesRef.current[input.threadKey];
  if (state?.phase !== "awaiting-projection") return null;
  const outcome = resolveQueuedTurnPromotionOutcome({
    activities: input.activities,
    expectedMessageIds: state.messageIds,
    requestId: state.requestId,
  });
  if (outcome === null) return null;
  setQueuedMessagePromotionPhase({ ...input, state: null });
  return outcome;
}

export function isProviderOverloadRetrying(input: {
  activities: Thread["activities"];
  latestTurn: Thread["latestTurn"];
  isWorking: boolean;
}): boolean {
  const startedAt = input.latestTurn?.startedAt;
  if (!input.isWorking || !startedAt) {
    return false;
  }
  return input.activities.some(
    (activity) =>
      activity.kind === "provider.overload.retrying" &&
      activity.createdAt >= startedAt &&
      (activity.turnId === null || activity.turnId === input.latestTurn?.turnId),
  );
}

export function startNewThreadForProject(
  projectRef: ScopedProjectRef | null,
  handleNewThread: (projectRef: ScopedProjectRef) => Promise<void>,
): boolean {
  if (projectRef === null) return false;
  void handleNewThread(projectRef);

  return true;
}

export function resolveThreadMetadataUpdateForNextTurn(input: {
  currentModelSelection: ModelSelection;
  nextModelSelection?: ModelSelection;
  currentBranch: string | null;
  nextBranch?: string;
}): {
  modelSelection?: ModelSelection;
  branch?: string;
  worktreePath?: null;
} | null {
  const nextModelSelection = input.nextModelSelection;
  const modelSelectionChanged =
    nextModelSelection !== undefined &&
    (nextModelSelection.model !== input.currentModelSelection.model ||
      nextModelSelection.instanceId !== input.currentModelSelection.instanceId ||
      JSON.stringify(nextModelSelection.options ?? null) !==
        JSON.stringify(input.currentModelSelection.options ?? null));
  const branchChanged = input.nextBranch !== undefined && input.nextBranch !== input.currentBranch;
  if (!modelSelectionChanged && !branchChanged) {
    return null;
  }
  return {
    ...(modelSelectionChanged ? { modelSelection: nextModelSelection } : {}),
    ...(branchChanged ? { branch: input.nextBranch, worktreePath: null } : {}),
  };
}

export function authoritativeThreadSettingsFingerprint(
  thread: Pick<Thread, "modelSelection" | "runtimeMode" | "interactionMode">,
): string {
  return JSON.stringify({
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
  });
}

export function buildLocalDraftThread(
  threadId: ThreadId,
  draftThread: DraftThreadState,
  fallbackModelSelection: ModelSelection,
): Thread {
  return {
    id: threadId,
    environmentId: draftThread.environmentId,
    projectId: draftThread.projectId,
    title: "New thread",
    modelSelection: fallbackModelSelection,
    runtimeMode: draftThread.runtimeMode,
    interactionMode: draftThread.interactionMode,
    session: null,
    messages: [],
    createdAt: draftThread.createdAt,
    updatedAt: draftThread.createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: draftThread.branch,
    worktreePath: draftThread.worktreePath,
    checkpoints: [],
    activities: [],
    proposedPlans: [],
  };
}

export function buildLoadingThreadFromShell(shell: ThreadShell): Thread {
  return {
    ...shell,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    deletedAt: null,
  };
}

export function shouldWriteThreadErrorToCurrentServerThread(input: {
  activeServerThread:
    | {
        environmentId: EnvironmentId;
        id: ThreadId;
      }
    | null
    | undefined;
  routeThreadRef: ScopedThreadRef;
  targetThreadId: ThreadId;
}): boolean {
  return Boolean(
    input.activeServerThread &&
    input.targetThreadId === input.routeThreadRef.threadId &&
    input.activeServerThread.environmentId === input.routeThreadRef.environmentId &&
    input.activeServerThread.id === input.targetThreadId,
  );
}

export function resolveVisibleServerThreadError(
  localEntry: { readonly message: string | null } | undefined,
  serverLastError: string | null | undefined,
  dismissedServerError?: string | null,
): string | null {
  if (localEntry?.message) {
    return localEntry.message;
  }
  const serverError = serverLastError ?? null;
  return serverError !== null && serverError === dismissedServerError ? null : serverError;
}

/**
 * How long ago a thread's recorded error happened, in words.
 *
 * The banner shows a provider's last error with no sense of when it happened,
 * and that error is carried indefinitely — a thread that failed once and then
 * sat idle keeps presenting it. A two-hour-old spawn failure read as a live
 * one and sent a user debugging a CLI that was working perfectly.
 *
 * Returns null when there is no usable timestamp, or when the error is recent
 * enough that saying "just now" adds nothing.
 */
export const RECENT_THREAD_ERROR_MS = 60_000;

export function describeThreadErrorAge(
  occurredAt: string | null | undefined,
  nowMs: number,
): string | null {
  if (!occurredAt) return null;
  const at = Date.parse(occurredAt);
  if (!Number.isFinite(at)) return null;
  const elapsed = nowMs - at;
  // A clock that disagrees is not evidence of age; say nothing rather than
  // claiming an error arrived from the future.
  if (elapsed < RECENT_THREAD_ERROR_MS) return null;

  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function buildThreadTurnInterruptInput(thread: Pick<Thread, "id" | "session">): {
  threadId: ThreadId;
  turnId?: TurnId;
} {
  const runningTurnId = thread.session?.status === "running" ? thread.session.activeTurnId : null;
  return {
    threadId: thread.id,
    ...(runningTurnId !== null ? { turnId: runningTurnId } : {}),
  };
}

const INTERRUPTIBLE_PENDING_WORK_STATES: ReadonlySet<string> = new Set([
  "pending",
  "claimed",
  "executing",
  "sleeping",
]);

export function isThreadWorkInterruptible(input: {
  readonly phase: SessionPhase;
  readonly pendingWork: OrchestrationThreadPendingWork | null | undefined;
}): boolean {
  return (
    input.phase === "running" ||
    input.phase === "connecting" ||
    (input.pendingWork?.kind === "active-turn-recovery" &&
      INTERRUPTIBLE_PENDING_WORK_STATES.has(input.pendingWork.state))
  );
}

export function reconcileRetainedMountedThreadIds(input: {
  currentThreadIds: ReadonlyArray<string>;
  openThreadIds: ReadonlyArray<string>;
  activeThreadId: string | null;
  activeThreadOpen: boolean;
  maxHiddenThreadCount: number;
  retainInactiveActiveThread?: boolean;
}): string[] {
  const openThreadIdSet = new Set(input.openThreadIds);
  const hiddenThreadIds = input.currentThreadIds.filter(
    (threadId) =>
      (threadId !== input.activeThreadId || input.retainInactiveActiveThread === true) &&
      openThreadIdSet.has(threadId),
  );
  const maxHiddenThreadCount = Math.max(0, input.maxHiddenThreadCount);
  const nextThreadIds =
    hiddenThreadIds.length > maxHiddenThreadCount
      ? hiddenThreadIds.slice(-maxHiddenThreadCount)
      : hiddenThreadIds;

  if (
    input.activeThreadId &&
    input.activeThreadOpen &&
    !nextThreadIds.includes(input.activeThreadId)
  ) {
    nextThreadIds.push(input.activeThreadId);
  }

  return nextThreadIds;
}

/**
 * Keep close suppression active until the server shell has actually removed
 * each archived side-chat child. Clearing it when the archive RPC returns creates a
 * race where a lagging shell re-adds the just-closed surface as a zombie.
 */
export function retainClosingSideChatThreadIds(
  closingThreadIds: ReadonlySet<string>,
  presentSideChatThreadIds: ReadonlySet<string>,
): ReadonlySet<string> {
  if (closingThreadIds.size === 0) return closingThreadIds;
  const retained = new Set(
    [...closingThreadIds].filter((threadId) => presentSideChatThreadIds.has(threadId)),
  );
  return retained.size === closingThreadIds.size ? closingThreadIds : retained;
}

export function shouldPersistComposerModelDefaults(input: {
  readonly embeddedSideChat: boolean;
  readonly threadIsSideChat: boolean;
}): boolean {
  return !input.embeddedSideChat && !input.threadIsSideChat;
}

export function revokeBlobPreviewUrl(previewUrl: string | undefined): void {
  if (!previewUrl || typeof URL === "undefined" || !previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

export function revokeUserMessagePreviewUrls(message: ChatMessage): void {
  if (message.role !== "user" || !message.attachments) {
    return;
  }
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") {
      continue;
    }
    revokeBlobPreviewUrl(attachment.previewUrl);
  }
}

export function collectUserMessageBlobPreviewUrls(message: ChatMessage): string[] {
  if (message.role !== "user" || !message.attachments) {
    return [];
  }
  const previewUrls: string[] = [];
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") continue;
    if (!attachment.previewUrl || !attachment.previewUrl.startsWith("blob:")) continue;
    previewUrls.push(attachment.previewUrl);
  }
  return previewUrls;
}

export interface PullRequestDialogState {
  initialReference: string | null;
  key: number;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read image data."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read image."));
    });
    reader.readAsDataURL(file);
  });
}

export function resolveSendEnvMode(input: {
  requestedEnvMode: DraftThreadEnvMode;
  isGitRepo: boolean;
}): DraftThreadEnvMode {
  return input.isGitRepo ? input.requestedEnvMode : "local";
}

export function cloneComposerImageForRetry(
  image: ComposerImageAttachment,
): ComposerImageAttachment {
  if (typeof URL === "undefined" || !image.previewUrl.startsWith("blob:")) {
    return image;
  }
  try {
    return {
      ...image,
      previewUrl: URL.createObjectURL(image.file),
    };
  } catch {
    return image;
  }
}

export function deriveComposerSendState(options: {
  prompt: string;
  imageCount: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  /**
   * Optional element-pick attachment count. Element contexts contribute to
   * "sendable content" exactly like images and (text-bearing) terminal
   * contexts do: a prompt of just element chips is still a valid send.
   */
  elementContextCount?: number;
}): {
  trimmedPrompt: string;
  sendableTerminalContexts: TerminalContextDraft[];
  expiredTerminalContextCount: number;
  hasSendableContent: boolean;
} {
  const trimmedPrompt = stripInlineTerminalContextPlaceholders(options.prompt).trim();
  const sendableTerminalContexts = filterTerminalContextsWithText(options.terminalContexts);
  const expiredTerminalContextCount =
    options.terminalContexts.length - sendableTerminalContexts.length;
  const elementContextCount = options.elementContextCount ?? 0;
  return {
    trimmedPrompt,
    sendableTerminalContexts,
    expiredTerminalContextCount,
    hasSendableContent:
      trimmedPrompt.length > 0 ||
      options.imageCount > 0 ||
      sendableTerminalContexts.length > 0 ||
      elementContextCount > 0,
  };
}

export function buildExpiredTerminalContextToastCopy(
  expiredTerminalContextCount: number,
  variant: "omitted" | "empty",
): { title: string; description: string } {
  const count = Math.max(1, Math.floor(expiredTerminalContextCount));
  const noun = count === 1 ? "Expired terminal context" : "Expired terminal contexts";
  if (variant === "empty") {
    return {
      title: `${noun} won't be sent`,
      description: "Remove it or re-add it to include terminal output.",
    };
  }
  return {
    title: `${noun} omitted from message`,
    description: "Re-add it if you want that terminal output included.",
  };
}

export function branchMismatchKey(
  threadId: string | null,
  mismatch: { threadBranch: string; currentBranch: string } | null,
): string | null {
  if (!threadId || !mismatch) {
    return null;
  }
  return `${threadId}:${mismatch.threadBranch}:${mismatch.currentBranch}`;
}

// The mismatch banner only matters when the user is about to send: passive
// reading of an old thread carries no risk (the branch picker tint already
// covers ambient awareness). Draft content is the intent signal — composer
// focus is useless here because ChatView autofocuses the composer on every
// thread open. `wasShownForCurrentMismatch` keeps the banner mounted once
// revealed so it doesn't flicker away when the draft is cleared.
export function shouldShowBranchMismatchBanner(input: {
  hasMismatch: boolean;
  isDismissed: boolean;
  composerHasContent: boolean;
  wasShownForCurrentMismatch: boolean;
}): boolean {
  if (!input.hasMismatch || input.isDismissed) {
    return false;
  }
  return input.composerHasContent || input.wasShownForCurrentMismatch;
}

// Session-scoped (module-level so it survives ChatView remounts, e.g. route
// changes). Durable cross-device dismissal is planned as a server-side ack.
const sessionDismissedBranchMismatchKeys = new Set<string>();

export function dismissBranchMismatchForSession(key: string): void {
  sessionDismissedBranchMismatchKeys.add(key);
}

export function isBranchMismatchDismissedForSession(key: string | null): boolean {
  return key !== null && sessionDismissedBranchMismatchKeys.has(key);
}

export function threadHasStarted(thread: Thread | null | undefined): boolean {
  return Boolean(
    thread && (thread.latestTurn !== null || thread.messages.length > 0 || thread.session !== null),
  );
}

export function shouldCreateServerThreadForTerminalStart(input: {
  readonly isLocalDraftThread: boolean;
  readonly isServerThread: boolean;
}): boolean {
  return input.isLocalDraftThread && !input.isServerThread;
}

export function isThreadAlreadyExistsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("already exists") && /thread/i.test(message);
}

export function resolveDraftThreadCreateModelSelection(input: {
  readonly composerModelSelection: ModelSelection | null | undefined;
  readonly projectDefaultModelSelection: ModelSelection | null | undefined;
}): ModelSelection | null {
  const composer = input.composerModelSelection;
  if (composer && composer.model.length > 0) {
    return composer;
  }
  const projectDefault = input.projectDefaultModelSelection;
  if (projectDefault && projectDefault.model.length > 0) {
    return projectDefault;
  }
  return null;
}

// Provider selection controls the next composer submission. A currently
// active turn keeps running on the provider that started it, but must not lock
// the picker: users can choose a different provider for their queued follow-up.
export function deriveLockedProvider(_input: {
  thread: Thread | null | undefined;
  selectedProvider: string | null;
  threadProvider: string | null;
}): ProviderDriverKind | null {
  return null;
}

/**
 * Resolve the provider that owns the live session, independently of the
 * composer's unlocked next-turn selection.
 *
 * A running turn may keep using Grok while the user changes the next provider.
 * Conversely, {@link deriveLockedProvider} deliberately always returns null so
 * the picker stays unlocked. Runtime controls such as Grok queue promotion must
 * therefore read the session owner rather than the picker lock.
 */
export function deriveActiveSessionProviderDriver(input: {
  readonly thread: Thread | null | undefined;
  readonly providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver">>;
}): ProviderDriverKind | null {
  const session = input.thread?.session;
  if (!session) return null;
  const configured = input.providers.find(
    (provider) => provider.instanceId === session.providerInstanceId,
  );
  if (configured) return configured.driver;
  return isProviderDriverKind(session.providerName) ? session.providerName : null;
}

export async function waitForStartedServerThread(
  threadRef: ScopedThreadRef,
  timeoutMs = 1_000,
): Promise<boolean> {
  const threadAtom = environmentThreadDetails.detailAtom(threadRef);
  const getThread = () => appAtomRegistry.get(threadAtom);
  const thread = getThread();

  if (threadHasStarted(thread)) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      unsubscribe();
      resolve(result);
    };

    const unsubscribe = appAtomRegistry.subscribe(threadAtom, (thread) => {
      if (!threadHasStarted(thread)) {
        return;
      }
      finish(true);
    });

    if (threadHasStarted(getThread())) {
      finish(true);
      return;
    }

    timeoutId = globalThis.setTimeout(() => {
      finish(false);
    }, timeoutMs);
  });
}

export interface LocalDispatchSnapshot {
  startedAt: string;
  preparingWorktree: boolean;
  latestUserMessageId: ChatMessage["id"] | null;
  latestTurnTurnId: TurnId | null;
  latestTurnRequestedAt: string | null;
  latestTurnStartedAt: string | null;
  latestTurnCompletedAt: string | null;
  sessionStatus: NonNullable<Thread["session"]>["status"] | null;
  sessionUpdatedAt: string | null;
}

export function createLocalDispatchSnapshot(
  activeThread: Thread | undefined,
  options?: { preparingWorktree?: boolean },
): LocalDispatchSnapshot {
  const latestTurn = activeThread?.latestTurn ?? null;
  const session = activeThread?.session ?? null;
  const latestUserMessage = activeThread?.messages.findLast((message) => message.role === "user");
  return {
    startedAt: new Date().toISOString(),
    preparingWorktree: Boolean(options?.preparingWorktree),
    latestUserMessageId: latestUserMessage?.id ?? null,
    latestTurnTurnId: latestTurn?.turnId ?? null,
    latestTurnRequestedAt: latestTurn?.requestedAt ?? null,
    latestTurnStartedAt: latestTurn?.startedAt ?? null,
    latestTurnCompletedAt: latestTurn?.completedAt ?? null,
    sessionStatus: session?.status ?? null,
    sessionUpdatedAt: session?.updatedAt ?? null,
  };
}

export function hasServerAcknowledgedLocalDispatch(input: {
  localDispatch: LocalDispatchSnapshot | null;
  phase: SessionPhase;
  latestTurn: Thread["latestTurn"] | null;
  latestUserMessageId: ChatMessage["id"] | null;
  session: Thread["session"] | null;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  threadError: string | null | undefined;
}): boolean {
  if (!input.localDispatch) {
    return false;
  }
  if (input.hasPendingApproval || input.hasPendingUserInput || Boolean(input.threadError)) {
    return true;
  }

  const latestTurn = input.latestTurn ?? null;
  const session = input.session ?? null;
  const latestUserMessageChanged =
    input.localDispatch.latestUserMessageId !== input.latestUserMessageId;
  const latestTurnChanged =
    input.localDispatch.latestTurnTurnId !== (latestTurn?.turnId ?? null) ||
    input.localDispatch.latestTurnRequestedAt !== (latestTurn?.requestedAt ?? null) ||
    input.localDispatch.latestTurnStartedAt !== (latestTurn?.startedAt ?? null) ||
    input.localDispatch.latestTurnCompletedAt !== (latestTurn?.completedAt ?? null);

  if (input.phase === "running") {
    // Steering adds a user message to the current running turn without
    // necessarily changing any of the turn timestamps. Treat that projected
    // message as the server acknowledgment so the composer does not remain
    // stuck in its local "Sending" state until the turn settles.
    if (latestUserMessageChanged) {
      return true;
    }
    if (!latestTurnChanged) {
      return false;
    }
    if (latestTurn?.startedAt === null || latestTurn === null) {
      return false;
    }
    if (
      session?.activeTurnId !== null &&
      session?.activeTurnId !== undefined &&
      latestTurn?.turnId !== session.activeTurnId
    ) {
      return false;
    }
    return true;
  }

  return (
    latestTurnChanged ||
    input.localDispatch.sessionStatus !== (session?.status ?? null) ||
    input.localDispatch.sessionUpdatedAt !== (session?.updatedAt ?? null)
  );
}

/**
 * Whether opening a thread should put the caret in the composer.
 *
 * With a real keyboard this is pure convenience — the thread opens and you can
 * type. With an on-screen one it is not: a programmatic focus summons the
 * keyboard, which covers half the viewport and pushes the conversation you
 * just opened out of view, before you have said you want to write anything.
 * Opening a thread is navigation; typing is a separate decision the user makes
 * by tapping the composer.
 *
 * Keyed on the pointer being coarse, not on a phone-sized portrait viewport.
 * Every device with a soft keyboard has the former; the latter also has to be
 * narrow and upright, so it silently let tablets and landscape phones through
 * — which is how this reached someone in the first place.
 */
export function shouldAutoFocusComposerOnThreadOpen(input: {
  hasThread: boolean;
  terminalSurfaceActive: boolean;
  previewFocused: boolean;
  usesOnScreenKeyboard: boolean;
}): boolean {
  if (!input.hasThread) return false;
  // The terminal owns the caret while it is the active surface.
  if (input.terminalSurfaceActive) return false;
  // So does the preview browser once the user has clicked into the page.
  if (input.previewFocused) return false;
  return !input.usesOnScreenKeyboard;
}

/**
 * Whether to put the caret back in the composer after a UI action.
 *
 * The app restores composer focus after all sorts of things settle — a mode
 * or model change, picking a branch, dropping files, leaving the terminal
 * surface, closing the command palette, opening a thread. With a hardware
 * keyboard that is a courtesy: the menu closes and you can keep typing.
 *
 * With an on-screen one it is an interruption. Dismissing a menu makes the
 * keyboard slide up over the conversation, and nothing the user did asked for
 * it. Focus the user requested outright — tapping the composer, quoting a
 * message, typing a character — does not come through here.
 */
export function shouldRestoreComposerFocus(input: {
  previewFocused: boolean;
  usesOnScreenKeyboard: boolean;
}): boolean {
  // The preview browser is a real focus owner, not a panel. Once the caret is
  // in the guest page, restoring it here sends the user's next keystroke or
  // paste to the composer instead of the page they are looking at — which is
  // indistinguishable from the browser ignoring their input.
  if (input.previewFocused) return false;
  return !input.usesOnScreenKeyboard;
}

/**
 * What to do about a send that cannot go through right now.
 *
 * Every one of these used to be a bare `return` at the top of `onSend`. The
 * button depressed, the message stayed in the box, and nothing said why —
 * reported from mobile Safari as "I pressed send and nothing happened", which
 * took killing the browser to clear. A dead control is worse than a refusal:
 * the user cannot tell a broken app from a busy one.
 *
 * The three outcomes are deliberate:
 *
 * - `"queue"` for blockers that clear on their own. Catching a conversation up
 *   can take ten seconds or more, and making someone watch a spinner before
 *   they may even start typing is the wrong trade — hold the message and send
 *   it the moment the wait ends.
 * - `"explain"` for blockers that need the user to do something, or that no
 *   amount of waiting will fix.
 * - `"silent"` for a send genuinely in flight. That state has a spinner and a
 *   disabled button, so repeating it on every impatient second tap is noise.
 */
export type BlockedSendOutcome =
  | { readonly kind: "silent" }
  | { readonly kind: "queue"; readonly message: string }
  | { readonly kind: "explain"; readonly message: string };

/**
 * Why the send button itself is disabled, or `null` to leave it pressable.
 *
 * Catching up is deliberately not a reason. A disabled button swallows the
 * press outright, so gating on catch-up meant tapping send during a ten-second
 * fast-forward did nothing and said nothing. Left pressable, the press reaches
 * the send path, which queues it via {@link resolveBlockedSend} and replays it
 * the moment the thread is live. Only a blocker the user must clear themselves
 * belongs here.
 */
export function resolveSendDisabledReason(input: {
  readonly providerAuthenticationPaused: boolean;
  readonly threadCatchingUp: boolean;
}): string | null {
  return input.providerAuthenticationPaused ? "Sign in to continue" : null;
}

export function resolveBlockedSend(input: {
  readonly hasThread: boolean;
  readonly sendInFlight: boolean;
  readonly providerAuthenticationPaused: boolean;
  readonly connecting: boolean;
  readonly threadCatchingUp: boolean;
  readonly environmentUnavailable: boolean;
  readonly canQueueLocalMessage: boolean;
  readonly environmentLabel: string | null;
}): BlockedSendOutcome {
  if (input.sendInFlight) return { kind: "silent" };
  if (input.providerAuthenticationPaused) {
    return {
      kind: "explain",
      message: "This provider needs you to sign in again before it can take a message.",
    };
  }
  if (input.environmentUnavailable && !input.canQueueLocalMessage) {
    const where = input.environmentLabel === null ? "That host" : input.environmentLabel;
    return {
      kind: "explain",
      message: `${where} is unreachable, so this message cannot be delivered or queued yet.`,
    };
  }
  if (input.connecting) {
    const where = input.environmentLabel === null ? "the host" : input.environmentLabel;
    return { kind: "queue", message: `Waiting to reconnect to ${where} — this will send itself.` };
  }
  if (input.threadCatchingUp) {
    return {
      kind: "queue",
      message: "Waiting for this conversation to finish catching up — this will send itself.",
    };
  }
  if (!input.hasThread) {
    return { kind: "explain", message: "There is no conversation to send to yet." };
  }
  return { kind: "silent" };
}
