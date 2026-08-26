import {
  type ChatAttachment,
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  ProviderDriverKind,
  type ProjectId,
  type OrchestrationSession,
  ThreadId,
  type ProviderSession,
  type ServerProvider,
  type RuntimeMode,
  type TurnId,
  type ProviderInteractionMode,
  RuntimeTaskId,
} from "@t3tools/contracts";
import {
  AGENT_CONTINUE_PROMPT,
  emittedAgentStop,
  isProviderAuthenticationFailure,
  isTerminalProviderRefusal,
  sessionNeedsProviderReset,
  shouldAgentContinueAfterReply,
} from "@t3tools/shared/agentMode";
import { isTemporaryWorktreeBranch, WORKTREE_BRANCH_PREFIX } from "@t3tools/shared/git";
import { RESUME_PROMPT } from "@t3tools/shared/resumePrompt";
import { SETTINGS_UPDATE_MESSAGE_PREFIX } from "@t3tools/shared/settingsPrompt";
import { buildPlanRefreshTranscript, derivePlanRefreshCurrentSteps } from "../planRefresh.ts";
import { buildVoiceTranscriptTurnInput } from "../voiceTranscriptContext.ts";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeDrainableWorker, type DrainableWorker } from "@t3tools/shared/DrainableWorker";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { increment, orchestrationEventsProcessedTotal } from "../../observability/Metrics.ts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
import { formatProviderFailureDetail } from "../../provider/providerFailureMessage.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import {
  ACTIVE_TURN_STEER_DELIVERY_UNCONFIRMED_REASON,
  ThreadWorkObligationRepository,
  type ThreadWorkObligation,
} from "../../persistence/Services/ThreadWorkObligations.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionPersistedTurnStartContext,
} from "../Services/ProjectionSnapshotQuery.ts";
import { THREAD_DETAIL_SNAPSHOT_ACTIVITY_LIMIT } from "./ProjectionSnapshotQuery.ts";
import {
  ThreadWorkScheduler,
  type ThreadWorkExecutionOutcome,
  type ThreadWorkHandler,
} from "../Services/ThreadWorkScheduler.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import {
  resolveSourceControlWriterModelSelection,
  ServerSettingsService,
} from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { ActionApprovalBroker } from "../../mcp/toolkits/actionApproval/ActionApprovalBroker.ts";
import {
  buildProviderHandoffSummary,
  buildProviderHandoffTurnInput,
  deriveProviderHandoffContinuity,
} from "../ProviderUsageLimitFailover.ts";
import {
  activeTurnMessageIdFromSourceTurnId,
  activeTurnWorkSourceId,
  agentAutoResumeIds,
  agentContinuationShouldAwaitBackgroundTask,
  isAgentAutoResumeMessageId,
  isControlOnlyAgentTurn,
  isVmAgentTaskPromptMessageId,
  shouldAutoContinueCompletedAgentTurn,
  startupAutoResumeIds,
  STARTUP_RESUME_SIGNED_OFF_REASON,
} from "../agentModeContinuation.ts";
import { isBrowserTabCleanupMessageId } from "@t3tools/shared/browserTabCleanup";
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderDriverKind = Schema.is(ProviderDriverKind);

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.runtime-mode-set"
      | "thread.meta-updated"
      | "thread.forked"
      | "thread.message-sent"
      | "thread.session-set"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.queued-turn-promote-requested"
      | "thread.task-stop-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested"
      | "thread.plan-refresh-requested";
  }
>;

type AssistantMessageSentEvent = Extract<ProviderIntentEvent, { type: "thread.message-sent" }>;
type TurnStartRequestedPayload = Extract<
  OrchestrationEvent,
  { type: "thread.turn-start-requested" }
>["payload"];

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function modelSelectionStatusDetail(
  selection: ModelSelection,
  interactionMode: ProviderInteractionMode,
  runtimeMode: RuntimeMode,
): string {
  const effort = selection.options?.find(
    (option) => option.id === "effort" || option.id === "reasoningEffort",
  )?.value;
  return [
    selection.model,
    typeof effort === "string" ? `${effort} effort` : null,
    interactionMode === "plan" ? "Plan" : interactionMode === "agent" ? "Agent" : "Build",
    runtimeMode === "full-access" ? "Full access" : "Approval required",
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
const DEFAULT_THREAD_TITLE = "New thread";
/** Baseline (pre-server-loop) runaway budget: continuations without any real user input. */
const AGENT_LOOP_MAX_CONSECUTIVE_CONTINUATIONS = 50;

export function providerErrorLabel(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : "unknown";
}

export function providerErrorLabelFromInstanceHint(input: {
  readonly instanceId?: string | undefined;
  readonly modelSelectionInstanceId?: string | undefined;
  readonly sessionProvider?: string | undefined;
}): string {
  return providerErrorLabel(
    input.instanceId ?? input.modelSelectionInstanceId ?? input.sessionProvider,
  );
}

function canReplaceThreadTitle(currentTitle: string, titleSeed?: string): boolean {
  const trimmedCurrentTitle = currentTitle.trim();
  if (trimmedCurrentTitle === DEFAULT_THREAD_TITLE) {
    return true;
  }

  const trimmedTitleSeed = titleSeed?.trim();
  return trimmedTitleSeed !== undefined && trimmedTitleSeed.length > 0
    ? trimmedCurrentTitle === trimmedTitleSeed
    : false;
}

function findProviderAdapterRequestError(
  cause: Cause.Cause<unknown>,
): ProviderAdapterRequestError | undefined {
  const failReason = cause.reasons.find(
    (reason) => Cause.isFailReason(reason) && isProviderAdapterRequestError(reason.error),
  );
  return failReason &&
    Cause.isFailReason(failReason) &&
    isProviderAdapterRequestError(failReason.error)
    ? failReason.error
    : undefined;
}

const isRetryableUpstreamFailure = (cause: Cause.Cause<unknown>): boolean =>
  findProviderAdapterRequestError(cause)?.failureKind === "retryable-upstream";

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request")
    );
  }
  const message = Cause.pretty(cause);
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request")
  );
}

function isUnknownPendingUserInputRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending user-input request") ||
      detail.includes("unknown pending user input request") ||
      detail.includes("unknown pending codex user input request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending user-input request") ||
    message.includes("unknown pending user input request") ||
    message.includes("unknown pending codex user input request")
  );
}

function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

function hasResolvedProviderRequest(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
  input: {
    readonly requestId: string;
    readonly resolvedKind: "user-input.resolved" | "approval.resolved";
  },
): boolean {
  return activities.some(
    (activity) =>
      activity.kind === input.resolvedKind &&
      typeof activity.payload === "object" &&
      activity.payload !== null &&
      (activity.payload as Record<string, unknown>).requestId === input.requestId,
  );
}

function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.startsWith(`${WORKTREE_BRANCH_PREFIX}/`)
    ? normalized.slice(`${WORKTREE_BRANCH_PREFIX}/`.length)
    : normalized;

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

/**
 * What a queued turn-start delivery should do about its source message.
 *
 * `awaiting-projection` is the case worth naming: the handler reads the thread
 * and the turn-start context as separate queries, so a dispatch landing
 * between them is visible to one and not the other. An absent message means
 * the projections have not caught up — never that the user moved on. Treating
 * absence as supersession cancelled resumes that had just been requested, and
 * because the projector declines to enqueue when a row for that key already
 * exists, killing the row left nothing at all to drive the resume.
 */
export type TurnStartRecoveryVerdict = "proceed" | "superseded" | "awaiting-projection";

export const classifyTurnStartRecovery = (input: {
  readonly sourceMessage:
    | { readonly role: string; readonly inputOrigin?: string | null | undefined }
    | undefined;
  readonly messageId: string;
  readonly hasLaterRealUserTurn: boolean;
}): TurnStartRecoveryVerdict => {
  if (input.sourceMessage === undefined) return "awaiting-projection";
  // A delivery whose message turned out not to be a real user send has been
  // overtaken for good; so has one with an actual later user turn behind it.
  if (input.sourceMessage.role !== "user") return "superseded";
  // Only continuation auto-resume prompts own their launch elsewhere. Judging
  // by the raw `inputOrigin === "agent-loop"` tag instead swept up scheduled
  // VM-agent task prompts, whose obligation is their *only* launcher — every
  // scheduled turn was cancelled as superseded ~50ms after being requested,
  // and the prompt sat at "Queued" forever. Same narrowing as the projection
  // pipeline applies when it creates the obligation.
  if (isAgentAutoResumeMessageId(input.messageId)) return "superseded";
  return input.hasLaterRealUserTurn ? "superseded" : "proceed";
};

/**
 * Consecutive synthetic continuations since the last message carrying real
 * user intent — the input to the runaway budget.
 *
 * Scheduled VM-agent task prompts arrive tagged `inputOrigin: "agent-loop"`
 * (no human typed them), but each one is the user's own schedule firing:
 * fresh intent that resets the budget exactly as a typed message would.
 * Counting them as continuations instead starved purely scheduled agent
 * threads — with no human message ever present, every run's prompt
 * accumulated toward the cap until continuation shut off for good.
 */
export const countContinuationsSinceUserIntent = (
  messages: ReadonlyArray<{
    readonly id: string;
    readonly role: string;
    readonly inputOrigin?: string | null | undefined;
  }>,
): number => {
  const lastUserIntentIndex = messages.findLastIndex(
    (message) =>
      message.role === "user" &&
      (message.inputOrigin !== "agent-loop" || isVmAgentTaskPromptMessageId(message.id)),
  );
  return messages
    .slice(lastUserIntentIndex + 1)
    .filter(
      (message) =>
        message.role === "user" &&
        message.inputOrigin === "agent-loop" &&
        !isBrowserTabCleanupMessageId(message.id),
    ).length;
};

/**
 * providerTurnProducedOutput - did this provider turn actually do anything?
 *
 * A turn that emitted no message and no activity produced literally nothing.
 * Real work always leaves one or the other behind — even a turn that only ran
 * tools records activities. An upstream request that times out ends the turn
 * "successfully" with an empty body, and that is indistinguishable from a
 * finished resume unless someone checks.
 */
export const providerTurnProducedOutput = (thread: OrchestrationThread, turnId: TurnId): boolean =>
  thread.messages.some((message) => message.turnId === turnId) ||
  thread.activities.some((activity) => activity.turnId === turnId);

/**
 * ProviderCommandReactorLiveOptions - test seams for the reactor's timers.
 */
export interface ProviderCommandReactorLiveOptions {
  /**
   * How long a turn's thread shell may sit unchanged before the reactor treats
   * the provider feed as dead and restarts the session. Production uses four
   * minutes; tests shorten it so the watchdog is reachable without burning
   * real wall-clock time.
   */
  readonly providerSilenceRestartMs?: number;
  /**
   * The longer leash used while the awaited turn is actively running: a
   * reasoning model can think for minutes while streaming nothing, and the
   * fast window above must not execute it. Production uses fifteen minutes.
   */
  readonly providerMidTurnSilenceRestartMs?: number;
}

const make = (options?: ProviderCommandReactorLiveOptions) =>
  Effect.gen(function* () {
    // Stamped once at construction so the background-task gate can tell a task
    // this process is actually supervising from one stranded by a restart.
    const processStartedAtEpochMs = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
    const crypto = yield* Crypto.Crypto;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const providerService = yield* ProviderService;
    const actionApprovalBroker = yield* ActionApprovalBroker;
    const providerRegistry = yield* ProviderRegistry;
    const threadWorkObligations = yield* ThreadWorkObligationRepository;
    const threadWorkScheduler = yield* ThreadWorkScheduler;
    const gitWorkflow = yield* GitWorkflowService;
    const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
    const textGeneration = yield* TextGeneration;
    const serverSettingsService = yield* ServerSettingsService;
    const serverCommandId = (tag: string) =>
      crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
    const serverEventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));
    const handledTurnStartKeys = yield* Cache.make<string, true>({
      capacity: HANDLED_TURN_START_KEY_MAX,
      timeToLive: HANDLED_TURN_START_KEY_TTL,
      lookup: () => Effect.succeed(true),
    });

    const hasHandledTurnStartRecently = (key: string) =>
      Cache.getOption(handledTurnStartKeys, key).pipe(
        Effect.flatMap((cached) =>
          Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
        ),
      );

    const threadModelSelections = new Map<string, ModelSelection>();
    // Desired thread metadata can advance before the provider has applied it.
    // Keep the selection used to configure the live session separately so a
    // metadata update cannot make a stale Claude session look current.
    const providerSessionModelSelections = new Map<string, ModelSelection>();
    const appendProviderFailureActivity = (input: {
      readonly threadId: ThreadId;
      readonly kind:
        | "provider.turn.start.failed"
        | "provider.turn.interrupt.failed"
        | "provider.approval.respond.failed"
        | "provider.user-input.respond.failed"
        | "provider.session.stop.failed"
        | "provider.task.stop.failed"
        | "provider.queue.promote.failed";
      readonly summary: string;
      readonly detail: string;
      readonly turnId: TurnId | null;
      readonly createdAt: string;
      readonly requestId?: string;
    }) =>
      Effect.all({
        commandId: serverCommandId("provider-failure-activity"),
        eventId: serverEventId(),
      }).pipe(
        Effect.flatMap(({ commandId, eventId }) =>
          orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId,
            threadId: input.threadId,
            activity: {
              id: eventId,
              tone: "error",
              kind: input.kind,
              summary: input.summary,
              payload: {
                detail: input.detail,
                ...(input.requestId ? { requestId: input.requestId } : {}),
              },
              turnId: input.turnId,
              createdAt: input.createdAt,
            },
            createdAt: input.createdAt,
          }),
        ),
      );

    const appendQueuedTurnPromotionActivity = (input: {
      readonly threadId: ThreadId;
      readonly turnId: TurnId | null;
      readonly messageIds: ReadonlyArray<MessageId>;
      readonly createdAt: string;
    }) =>
      Effect.all({
        commandId: serverCommandId("provider-queue-promoted-activity"),
        eventId: serverEventId(),
      }).pipe(
        Effect.flatMap(({ commandId, eventId }) =>
          orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId,
            threadId: input.threadId,
            activity: {
              id: eventId,
              tone: "info",
              kind: "provider.queue.promoted",
              summary: "Queued messages sent now",
              payload: { messageIds: input.messageIds },
              turnId: input.turnId,
              createdAt: input.createdAt,
            },
            createdAt: input.createdAt,
          }),
        ),
      );

    const formatFailureDetail = (cause: Cause.Cause<unknown>): string =>
      formatProviderFailureDetail(cause);

    const setThreadSession = (input: {
      readonly threadId: ThreadId;
      readonly session: OrchestrationSession;
      readonly createdAt: string;
    }) =>
      serverCommandId("provider-session-set").pipe(
        Effect.flatMap((commandId) =>
          orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId,
            threadId: input.threadId,
            session: input.session,
            createdAt: input.createdAt,
          }),
        ),
      );

    const setThreadSessionErrorOnTurnStartFailure = Effect.fnUntraced(function* (input: {
      readonly threadId: ThreadId;
      readonly detail: string;
      readonly createdAt: string;
    }) {
      const thread = yield* resolveThread(input.threadId);
      if (!thread) {
        return;
      }
      const session = thread.session;
      yield* setThreadSession({
        threadId: input.threadId,
        session: {
          ...(session ?? {
            threadId: input.threadId,
            providerName: null,
            providerInstanceId: thread.modelSelection.instanceId,
            runtimeMode: thread.runtimeMode,
          }),
          status: session?.status === "stopped" ? "stopped" : "error",
          activeTurnId: null,
          lastError: input.detail,
          updatedAt: input.createdAt,
        },
        createdAt: input.createdAt,
      });
    });

    const resolveProject = Effect.fnUntraced(function* (projectId: ProjectId) {
      return yield* projectionSnapshotQuery
        .getProjectShellById(projectId)
        .pipe(Effect.map(Option.getOrUndefined));
    });

    const resolveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
      return yield* projectionSnapshotQuery
        .getThreadDetailById(threadId, {
          activityLimit: THREAD_DETAIL_SNAPSHOT_ACTIVITY_LIMIT,
        })
        .pipe(Effect.map(Option.getOrUndefined));
    });

    const ensureSessionForThread = Effect.fn("ensureSessionForThread")(function* (
      threadId: ThreadId,
      createdAt: string,
      options?: {
        readonly modelSelection?: ModelSelection;
        readonly pendingTurnStart?: boolean;
      },
    ) {
      const thread = yield* resolveThread(threadId);
      if (!thread) {
        return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
      }

      const desiredRuntimeMode = thread.runtimeMode;
      const requestedModelSelection = options?.modelSelection;
      const resolveActiveSession = (threadId: ThreadId) =>
        providerService
          .listSessions()
          .pipe(
            Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)),
          );

      const activeSession = yield* resolveActiveSession(threadId);
      const resetTrippedProvider = sessionNeedsProviderReset(thread.session);
      const activeThreadSession =
        thread.session !== null &&
        thread.session.status !== "stopped" &&
        !resetTrippedProvider &&
        activeSession
          ? thread.session
          : null;
      if (
        activeThreadSession !== null &&
        activeSession !== undefined &&
        (activeThreadSession.providerInstanceId === undefined ||
          activeSession.providerInstanceId === undefined)
      ) {
        return yield* new ProviderAdapterRequestError({
          provider: providerErrorLabel(activeThreadSession.providerName ?? undefined),
          method: "thread.turn.start",
          detail: `Thread '${threadId}' has an active provider session without a provider instance id.`,
        });
      }
      const currentInstanceId =
        activeThreadSession !== null &&
        activeSession !== undefined &&
        activeSession.providerInstanceId !== undefined
          ? activeSession.providerInstanceId
          : (thread.session?.providerInstanceId ??
            threadModelSelections.get(threadId)?.instanceId ??
            thread.modelSelection.instanceId);
      const desiredModelSelection = requestedModelSelection ?? thread.modelSelection;
      const desiredInstanceId = desiredModelSelection.instanceId;
      yield* providerService.getInstanceInfo(currentInstanceId).pipe(
        Effect.mapError(
          () =>
            new ProviderAdapterRequestError({
              provider: providerErrorLabelFromInstanceHint({
                instanceId: String(currentInstanceId),
                modelSelectionInstanceId: String(thread.modelSelection.instanceId),
                sessionProvider: thread.session?.providerName ?? undefined,
              }),
              method: "thread.turn.start",
              detail: `Thread '${threadId}' references unknown provider instance '${currentInstanceId}'. The instance is not configured in this build.`,
            }),
        ),
      );
      const desiredInfo = yield* providerService.getInstanceInfo(desiredInstanceId).pipe(
        Effect.mapError(
          () =>
            new ProviderAdapterRequestError({
              provider: providerErrorLabelFromInstanceHint({
                instanceId: String(desiredModelSelection.instanceId),
              }),
              method: "thread.turn.start",
              detail: `Requested provider instance '${desiredInstanceId}' is not configured in this build.`,
            }),
        ),
      );
      const desiredDriverKind = desiredInfo.driverKind;
      if (!isProviderDriverKind(desiredDriverKind)) {
        return yield* new ProviderAdapterRequestError({
          provider: providerErrorLabel(String(desiredDriverKind)),
          method: "thread.turn.start",
          detail: `Requested provider instance '${desiredInstanceId}' uses unknown provider driver '${desiredDriverKind}'. The driver is not installed in this build.`,
        });
      }
      const preferredProvider: ProviderDriverKind = desiredDriverKind;
      if (options?.pendingTurnStart === true && thread.session?.status !== "running") {
        yield* setThreadSession({
          threadId,
          session: {
            threadId,
            status: "starting",
            providerName: activeSession?.provider ?? preferredProvider,
            providerInstanceId: activeSession?.providerInstanceId ?? desiredInstanceId,
            runtimeMode: desiredRuntimeMode,
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        });
      }
      const switchingProviderDuringActiveTurn =
        activeThreadSession !== null &&
        requestedModelSelection !== undefined &&
        requestedModelSelection.instanceId !== currentInstanceId &&
        activeThreadSession.activeTurnId !== null;
      if (switchingProviderDuringActiveTurn) {
        // A provider change is an explicit handoff, not a validation error. Stop
        // the source turn before rebinding the shared thread id so stale output
        // cannot continue racing the replacement provider.
        yield* providerService.interruptTurn({
          threadId,
          ...(activeThreadSession.activeTurnId !== null
            ? { turnId: activeThreadSession.activeTurnId }
            : {}),
        });
      }
      const project = yield* resolveProject(thread.projectId);
      const effectiveCwd = resolveThreadWorkspaceCwd({
        thread,
        projects: project ? [project] : [],
      });
      const { autoCompactionThresholdPercentage, claudeTokenOptimizerEnabled } =
        yield* serverSettingsService.getSettings;

      const startProviderSession = (input?: {
        readonly resumeCursor?: unknown;
        readonly provider?: ProviderDriverKind;
      }) =>
        providerService.startSession(threadId, {
          threadId,
          ...(preferredProvider ? { provider: preferredProvider } : {}),
          providerInstanceId: desiredInstanceId,
          ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
          modelSelection: desiredModelSelection,
          ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
          autoCompactionThresholdPercentage,
          tokenOptimizerEnabled: claudeTokenOptimizerEnabled,
          runtimeMode: desiredRuntimeMode,
        });

      const bindSessionToThread = (session: ProviderSession) =>
        Effect.gen(function* () {
          if (session.providerInstanceId === undefined) {
            return yield* new ProviderAdapterRequestError({
              provider: providerErrorLabel(session.provider),
              method: "thread.turn.start",
              detail: `Provider session '${session.threadId}' started without a provider instance id.`,
            });
          }
          providerSessionModelSelections.set(threadId, desiredModelSelection);
          yield* setThreadSession({
            threadId,
            session: {
              threadId,
              status:
                options?.pendingTurnStart === true && session.status === "ready"
                  ? "starting"
                  : mapProviderSessionStatusToOrchestrationStatus(session.status),
              providerName: session.provider,
              providerInstanceId: session.providerInstanceId,
              runtimeMode: desiredRuntimeMode,
              // Provider turn ids are not orchestration turn ids.
              activeTurnId: null,
              lastError: session.lastError ?? null,
              updatedAt: session.updatedAt,
            },
            createdAt,
          });
        });

      const existingSessionThreadId =
        thread.session &&
        thread.session.status !== "stopped" &&
        !resetTrippedProvider &&
        activeSession
          ? thread.id
          : null;
      if (resetTrippedProvider && activeSession) {
        // The process is still alive and has already said it will not accept
        // another turn. Reusing it is why dismissing the banner is futile —
        // the next send hits the same breaker. Kill it so startSession below
        // is a real restart.
        yield* providerService.stopSession({ threadId }).pipe(Effect.ignore);
      }
      if (existingSessionThreadId) {
        const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
        const cwdChanged = effectiveCwd !== activeSession?.cwd;
        const sessionModelSwitch = (yield* providerService.getCapabilities(desiredInstanceId))
          .sessionModelSwitch;
        const modelChanged =
          requestedModelSelection !== undefined &&
          requestedModelSelection.model !== activeSession?.model;
        const instanceChanged =
          requestedModelSelection !== undefined &&
          activeSession?.providerInstanceId !== requestedModelSelection.instanceId;
        const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "unsupported";
        const previousModelSelection = providerSessionModelSelections.get(threadId);
        const shouldRestartForModelSelectionChange =
          preferredProvider === "claudeAgent" &&
          requestedModelSelection !== undefined &&
          !Equal.equals(previousModelSelection, requestedModelSelection);

        if (
          !runtimeModeChanged &&
          !cwdChanged &&
          !instanceChanged &&
          !shouldRestartForModelChange &&
          !shouldRestartForModelSelectionChange
        ) {
          return existingSessionThreadId;
        }

        const resumeCursor =
          shouldRestartForModelChange || instanceChanged
            ? undefined
            : (activeSession?.resumeCursor ?? undefined);
        yield* Effect.logInfo("provider command reactor restarting provider session", {
          threadId,
          existingSessionThreadId,
          currentProvider: activeSession?.provider,
          currentInstanceId,
          desiredInstanceId,
          desiredProvider: desiredModelSelection.instanceId,
          currentRuntimeMode: thread.session?.runtimeMode,
          desiredRuntimeMode: thread.runtimeMode,
          runtimeModeChanged,
          previousCwd: activeSession?.cwd,
          desiredCwd: effectiveCwd,
          cwdChanged,
          modelChanged,
          instanceChanged,
          shouldRestartForModelChange,
          shouldRestartForModelSelectionChange,
          hasResumeCursor: resumeCursor !== undefined,
        });
        const restartedSession = yield* startProviderSession(
          resumeCursor !== undefined ? { resumeCursor } : undefined,
        );
        yield* Effect.logInfo("provider command reactor restarted provider session", {
          threadId,
          previousSessionId: existingSessionThreadId,
          restartedSessionThreadId: restartedSession.threadId,
          provider: restartedSession.provider,
          runtimeMode: restartedSession.runtimeMode,
          cwd: restartedSession.cwd,
        });
        yield* bindSessionToThread(restartedSession);
        return restartedSession.threadId;
      }

      const startedSession = yield* startProviderSession(undefined);
      yield* bindSessionToThread(startedSession);
      return startedSession.threadId;
    });

    const buildSendTurnRequestForThread = Effect.fnUntraced(function* (input: {
      readonly threadId: ThreadId;
      /** Forwarded so the adapter can report when the provider consumes this prompt. */
      readonly messageId?: MessageId;
      readonly messageText: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly modelSelection?: ModelSelection;
      readonly interactionMode?: "default" | "plan";
      readonly createdAt: string;
    }) {
      const thread = yield* resolveThread(input.threadId);
      if (!thread) {
        return yield* Effect.die(
          new Error(`Thread '${input.threadId}' was not found in read model.`),
        );
      }
      const activeSessionBeforeStart = yield* providerService
        .listSessions()
        .pipe(
          Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
        );
      const currentInstanceId =
        activeSessionBeforeStart?.providerInstanceId ??
        thread.session?.providerInstanceId ??
        thread.modelSelection.instanceId;
      const requestedInstanceId = input.modelSelection?.instanceId;
      const instanceChanged =
        requestedInstanceId !== undefined && requestedInstanceId !== currentInstanceId;
      const modelChangedOnSameInstance =
        input.modelSelection !== undefined &&
        !instanceChanged &&
        input.modelSelection.model !==
          (activeSessionBeforeStart?.model ?? thread.modelSelection.model);
      const sessionModelSwitchBeforeStart =
        activeSessionBeforeStart === undefined
          ? "in-session"
          : (yield* providerService.getCapabilities(currentInstanceId)).sessionModelSwitch;
      const shouldHandoffForModelRestart =
        modelChangedOnSameInstance && sessionModelSwitchBeforeStart === "unsupported";
      const settingsUpdateRequested = input.messageText.startsWith(SETTINGS_UPDATE_MESSAGE_PREFIX);
      if (
        settingsUpdateRequested &&
        thread.session?.status === "running" &&
        thread.session.activeTurnId !== null &&
        (requestedInstanceId === undefined || requestedInstanceId === currentInstanceId)
      ) {
        // Applying effort/mode/access changes is an immediate control action.
        // Stop the in-flight turn first so the update is not merely queued
        // behind work that is still using the previous settings.
        yield* providerService.interruptTurn({
          threadId: input.threadId,
          turnId: thread.session.activeTurnId,
        });
      }
      let providerInput = input.messageText;
      if (instanceChanged || shouldHandoffForModelRestart) {
        const requestedModelSelection = input.modelSelection;
        if (requestedModelSelection === undefined) {
          return yield* Effect.die(
            new Error("Provider switch was requested without a model selection."),
          );
        }
        const currentInfo = yield* providerService.getInstanceInfo(currentInstanceId);
        const desiredInfo = yield* providerService.getInstanceInfo(
          requestedInstanceId ?? currentInstanceId,
        );
        const lastMessage = thread.messages.at(-1);
        const historyMessages =
          lastMessage?.role === "user" &&
          lastMessage.text === input.messageText &&
          lastMessage.createdAt === input.createdAt
            ? thread.messages.slice(0, -1)
            : thread.messages;
        const summary = buildProviderHandoffSummary({
          threadId: thread.id,
          threadTitle: thread.title,
          messages: historyMessages,
          from: {
            instanceId: currentInstanceId,
            driver: currentInfo.driverKind,
          },
          to: {
            instanceId: requestedInstanceId ?? currentInstanceId,
            driver: desiredInfo.driverKind,
            modelSelection: requestedModelSelection,
          },
          exhaustion: {
            reason: instanceChanged ? "manual_provider_switch" : "manual_model_switch",
            resetsAt: null,
          },
          generatedAt: input.createdAt,
          immediateRequirement: input.messageText.startsWith(SETTINGS_UPDATE_MESSAGE_PREFIX)
            ? deriveProviderHandoffContinuity(historyMessages).immediateRequirement
            : input.messageText,
          inProgressWork: deriveProviderHandoffContinuity(historyMessages).inProgressWork,
        });
        providerInput = buildProviderHandoffTurnInput({
          summary,
          currentRequest: input.messageText,
        });
      } else {
        // Orchestrator thread only: fold spoken conversation the provider has
        // never seen into this prompt. Skipped on provider and model-session
        // handoffs — the digest above already carries the full projected
        // history, voice rows included.
        const voiceInput = buildVoiceTranscriptTurnInput({
          threadId: input.threadId,
          messages: thread.messages,
          outgoingMessageId: input.messageId,
          outgoingText: input.messageText,
        });
        if (voiceInput !== null) {
          providerInput = voiceInput;
        }
      }
      yield* ensureSessionForThread(input.threadId, input.createdAt, {
        ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
        pendingTurnStart: true,
      });
      if (input.modelSelection !== undefined) {
        threadModelSelections.set(input.threadId, input.modelSelection);
      }
      const normalizedInput = toNonEmptyProviderInput(providerInput);
      const normalizedAttachments = input.attachments ?? [];
      const activeSession = yield* providerService
        .listSessions()
        .pipe(
          Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
        );
      const sessionModelSwitch =
        activeSession === undefined
          ? "in-session"
          : activeSession.providerInstanceId === undefined
            ? yield* new ProviderAdapterRequestError({
                provider: providerErrorLabel(activeSession.provider),
                method: "thread.turn.start",
                detail: `Active provider session '${activeSession.threadId}' is missing a provider instance id.`,
              })
            : (yield* providerService.getCapabilities(activeSession.providerInstanceId))
                .sessionModelSwitch;
      const requestedModelSelection =
        input.modelSelection ?? threadModelSelections.get(input.threadId) ?? thread.modelSelection;
      const modelForTurn =
        sessionModelSwitch === "unsupported" && input.modelSelection === undefined
          ? activeSession?.model !== undefined
            ? {
                ...requestedModelSelection,
                model: activeSession.model,
              }
            : requestedModelSelection
          : input.modelSelection;
      const { autoCompactionThresholdPercentage, claudeTokenOptimizerEnabled } =
        yield* serverSettingsService.getSettings;

      return {
        threadId: input.threadId,
        ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
        ...(normalizedInput ? { input: normalizedInput } : {}),
        ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
        ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
        ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
        ...(thread.isSideChat === true ? { isSideChat: true } : {}),
        autoCompactionThresholdPercentage,
        tokenOptimizerEnabled: claudeTokenOptimizerEnabled,
      };
    });

    const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fn(
      "maybeGenerateAndRenameWorktreeBranchForFirstTurn",
    )(function* (input: {
      readonly threadId: ThreadId;
      readonly branch: string | null;
      readonly worktreePath: string | null;
      readonly messageText: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
    }) {
      if (!input.branch || !input.worktreePath) {
        return;
      }
      if (!isTemporaryWorktreeBranch(input.branch)) {
        return;
      }

      const oldBranch = input.branch;
      const cwd = input.worktreePath;
      const attachments = input.attachments ?? [];
      yield* Effect.gen(function* () {
        const settings = yield* serverSettingsService.getSettings;
        const modelSelection =
          settings.sourceControlWriterModelSelection === null
            ? settings.textGenerationModelSelection
            : resolveSourceControlWriterModelSelection(
                settings,
                yield* providerRegistry.getProviders,
              );

        const generated = yield* textGeneration.generateBranchName({
          cwd,
          message: input.messageText,
          ...(attachments.length > 0 ? { attachments } : {}),
          modelSelection,
        });
        if (!generated) return;

        const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
        if (targetBranch === oldBranch) return;

        const renamed = yield* gitWorkflow.renameBranch({
          cwd,
          oldBranch,
          newBranch: targetBranch,
        });
        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: yield* serverCommandId("worktree-branch-rename"),
          threadId: input.threadId,
          branch: renamed.branch,
          worktreePath: cwd,
        });
        yield* vcsStatusBroadcaster.refreshStatus(cwd).pipe(Effect.ignoreCause({ log: true }));
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "provider command reactor failed to generate or rename worktree branch",
            {
              threadId: input.threadId,
              cwd,
              oldBranch,
              cause: Cause.pretty(cause),
            },
          ),
        ),
      );
    });

    const maybeGenerateThreadTitleForFirstTurn = Effect.fn("maybeGenerateThreadTitleForFirstTurn")(
      function* (input: {
        readonly threadId: ThreadId;
        readonly cwd: string;
        readonly messageText: string;
        readonly attachments?: ReadonlyArray<ChatAttachment>;
        readonly titleSeed?: string;
      }) {
        const attachments = input.attachments ?? [];
        yield* Effect.gen(function* () {
          const { textGenerationModelSelection: modelSelection } =
            yield* serverSettingsService.getSettings;

          const generated = yield* textGeneration.generateThreadTitle({
            cwd: input.cwd,
            message: input.messageText,
            ...(attachments.length > 0 ? { attachments } : {}),
            modelSelection,
          });
          if (!generated) return;

          const thread = yield* resolveThread(input.threadId);
          if (!thread) return;
          if (!canReplaceThreadTitle(thread.title, input.titleSeed)) {
            return;
          }

          yield* orchestrationEngine.dispatch({
            type: "thread.meta.update",
            commandId: yield* serverCommandId("thread-title-rename"),
            threadId: input.threadId,
            title: generated.title,
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              "provider command reactor failed to generate or rename thread title",
              {
                threadId: input.threadId,
                cwd: input.cwd,
                cause: Cause.pretty(cause),
              },
            ),
          ),
        );
      },
    );

    // Supersede-collapse used to eat message bursts: when several user messages
    // arrived while no turn could start (dead CLI, restart churn), every message
    // except the newest was cancelled as "turn-start was superseded" — and
    // because an attached CLI session never re-reads thread history, the
    // superseded texts were never delivered anywhere. The winning turn therefore
    // carries every recent, still-undelivered predecessor along with it.
    const UNDELIVERED_CARRY_WINDOW_MS = 45 * 60 * 1000;
    const collectUndeliveredPredecessors = Effect.fnUntraced(function* (
      thread: OrchestrationThread,
      source: OrchestrationThread["messages"][number],
    ) {
      const sourceIndex = thread.messages.findIndex((message) => message.id === source.id);
      if (sourceIndex <= 0) return [] as ReadonlyArray<OrchestrationThread["messages"][number]>;
      const sourceCreatedAt = Date.parse(source.createdAt);
      const carried: Array<OrchestrationThread["messages"][number]> = [];
      for (let index = sourceIndex - 1; index >= 0; index -= 1) {
        const candidate = thread.messages[index];
        if (candidate === undefined) break;
        if (candidate.role !== "user") continue;
        if (candidate.inputOrigin === "agent-loop") continue;
        if (candidate.text.startsWith(SETTINGS_UPDATE_MESSAGE_PREFIX)) continue;
        const candidateCreatedAt = Date.parse(candidate.createdAt);
        if (
          Number.isFinite(sourceCreatedAt) &&
          Number.isFinite(candidateCreatedAt) &&
          sourceCreatedAt - candidateCreatedAt > UNDELIVERED_CARRY_WINDOW_MS
        ) {
          break;
        }
        // Whether a message reached the provider is decided by its turn, not by
        // a delivery activity: only the claudeAgent driver emits those, and
        // absence would make every predecessor look stranded and get re-sent.
        // A turn-start that produced a real provider turn was delivered; one
        // that produced none was cancelled as superseded and reached nobody.
        const predecessorContext = yield* getPersistedTurnStartContext(
          thread.id,
          candidate.id,
        ).pipe(Effect.map(Option.getOrUndefined));
        if (predecessorContext === undefined) break;
        if (predecessorContext.providerTurnId !== null) break;
        carried.unshift(candidate);
      }
      return carried as ReadonlyArray<OrchestrationThread["messages"][number]>;
    });

    const sendProjectedUserTurn = Effect.fn("sendProjectedUserTurn")(function* (input: {
      readonly thread: OrchestrationThread;
      readonly message: OrchestrationThread["messages"][number];
      readonly context: TurnStartRequestedPayload;
    }) {
      // Delivery records only exist for the claudeAgent driver; other drivers
      // would treat the whole recent history as "undelivered" and re-send it.
      const carryInstanceId =
        input.context.modelSelection?.instanceId ??
        input.thread.session?.providerInstanceId ??
        input.thread.modelSelection.instanceId;
      const undeliveredPredecessors =
        carryInstanceId === "claudeAgent"
          ? yield* collectUndeliveredPredecessors(input.thread, input.message)
          : [];
      const outgoingText =
        undeliveredPredecessors.length === 0
          ? input.message.text
          : [...undeliveredPredecessors.map((message) => message.text), input.message.text].join(
              "\n\n",
            );
      const carriedAttachments = [
        ...undeliveredPredecessors.flatMap((message) => message.attachments ?? []),
        ...(input.message.attachments ?? []),
      ];
      if (undeliveredPredecessors.length > 0) {
        yield* Effect.logInfo("sendProjectedUserTurn carrying undelivered predecessors").pipe(
          Effect.annotateLogs({
            threadId: input.context.threadId,
            messageId: input.message.id,
            carriedMessageIds: undeliveredPredecessors.map((message) => message.id).join(","),
          }),
        );
      }
      const sendTurnRequest = yield* buildSendTurnRequestForThread({
        threadId: input.context.threadId,
        messageId: input.message.id,
        messageText: outgoingText,
        ...(carriedAttachments.length > 0 ? { attachments: carriedAttachments } : {}),
        ...(input.context.modelSelection !== undefined
          ? { modelSelection: input.context.modelSelection }
          : {}),
        // Agent mode is a server-owned turn loop; providers still receive the
        // normal interactive mode until the next continuation is scheduled.
        interactionMode: providerInteractionMode(input.context.interactionMode),
        createdAt: input.context.createdAt,
      });

      const requestedModelSelection = input.context.modelSelection;
      const sourceInstanceId =
        input.thread.session?.providerInstanceId ?? input.thread.modelSelection.instanceId;
      const providerSwitched =
        requestedModelSelection !== undefined &&
        requestedModelSelection.instanceId !== sourceInstanceId;
      const settingsUpdateRequested = input.message.text.startsWith(SETTINGS_UPDATE_MESSAGE_PREFIX);
      return yield* providerService.sendTurn(sendTurnRequest).pipe(
        Effect.flatMap((turn) => {
          if (requestedModelSelection === undefined) {
            return Effect.succeed(turn);
          }
          return Effect.gen(function* () {
            yield* orchestrationEngine.dispatch({
              type: "thread.meta.update",
              commandId: yield* serverCommandId("provider-selection-accepted"),
              threadId: input.thread.id,
              modelSelection: requestedModelSelection,
            });
            if (providerSwitched) {
              const sourceInfo = yield* providerService.getInstanceInfo(sourceInstanceId);
              const targetInfo = yield* providerService.getInstanceInfo(
                requestedModelSelection.instanceId,
              );
              const lastAssistantMessage = input.thread.messages
                .toReversed()
                .find((entry) => entry.role === "assistant" && entry.text.trim().length > 0);
              const sourceLabel = sourceInfo.displayName?.trim() || String(sourceInfo.driverKind);
              const targetLabel = targetInfo.displayName?.trim() || String(targetInfo.driverKind);
              const { commandId, eventId } = yield* Effect.all({
                commandId: serverCommandId("provider-manual-handoff-activity"),
                eventId: serverEventId(),
              });
              yield* orchestrationEngine.dispatch({
                type: "thread.activity.append",
                commandId,
                threadId: input.thread.id,
                activity: {
                  id: eventId,
                  tone: "info",
                  kind: "provider.handoff.completed",
                  summary: `Switched from ${sourceLabel} to ${targetLabel}`,
                  payload: {
                    detail: modelSelectionStatusDetail(
                      requestedModelSelection,
                      input.context.interactionMode,
                      input.thread.runtimeMode,
                    ),
                    sourceInstanceId,
                    sourceProvider: sourceInfo.driverKind,
                    sourceLabel,
                    targetInstanceId: requestedModelSelection.instanceId,
                    targetProvider: targetInfo.driverKind,
                    targetLabel,
                    targetModel: requestedModelSelection.model,
                    targetOptions: requestedModelSelection.options ?? null,
                    runtimeMode: input.thread.runtimeMode,
                    interactionMode: input.context.interactionMode,
                    immediateRequirement: input.message.text,
                    inProgressWork: lastAssistantMessage?.text.trim() || null,
                  },
                  turnId: turn.turnId,
                  createdAt: input.context.createdAt,
                },
                createdAt: input.context.createdAt,
              });
            } else if (settingsUpdateRequested) {
              const { commandId, eventId } = yield* Effect.all({
                commandId: serverCommandId("thread-settings-applied-activity"),
                eventId: serverEventId(),
              });
              yield* orchestrationEngine.dispatch({
                type: "thread.activity.append",
                commandId,
                threadId: input.thread.id,
                activity: {
                  id: eventId,
                  tone: "info",
                  kind: "thread.settings.applied",
                  summary: "Conversation settings updated",
                  payload: {
                    detail: modelSelectionStatusDetail(
                      requestedModelSelection,
                      input.context.interactionMode,
                      input.thread.runtimeMode,
                    ),
                    targetInstanceId: requestedModelSelection.instanceId,
                    targetModel: requestedModelSelection.model,
                    targetOptions: requestedModelSelection.options ?? null,
                    runtimeMode: input.thread.runtimeMode,
                    interactionMode: input.context.interactionMode,
                  },
                  turnId: turn.turnId,
                  createdAt: input.context.createdAt,
                },
                createdAt: input.context.createdAt,
              });
            }
            return turn;
          });
        }),
      );
    });

    const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (
      event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
    ) {
      const key = turnStartKeyForEvent(event);
      if (yield* hasHandledTurnStartRecently(key)) {
        return;
      }

      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread) {
        return;
      }

      const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
      if (!message || message.role !== "user") {
        yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.turn.start.failed",
          summary: "Provider turn start failed",
          detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
          turnId: null,
          createdAt: event.payload.createdAt,
        });
        return;
      }

      // Durable Agent continuation owns delivery of this synthetic prompt. The
      // command still projects the collapsed UI chip, but replaying the command
      // must never launch a second provider turn through the hot event reactor.
      if (message.inputOrigin === "agent-loop" && isAgentAutoResumeMessageId(String(message.id))) {
        yield* threadWorkScheduler.wake(
          thread.session?.providerInstanceId ?? thread.modelSelection.instanceId,
        );
        return;
      }

      const isFirstUserMessageTurn =
        thread.messages.filter((entry) => entry.role === "user").length === 1;
      if (isFirstUserMessageTurn) {
        const project = yield* resolveProject(thread.projectId);
        const generationCwd =
          resolveThreadWorkspaceCwd({
            thread,
            projects: project ? [project] : [],
          }) ?? process.cwd();
        const generationInput = {
          messageText: message.text,
          ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
          ...(event.payload.titleSeed !== undefined ? { titleSeed: event.payload.titleSeed } : {}),
        };

        yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
          threadId: event.payload.threadId,
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          ...generationInput,
        }).pipe(Effect.forkScoped);

        if (canReplaceThreadTitle(thread.title, event.payload.titleSeed)) {
          yield* maybeGenerateThreadTitleForFirstTurn({
            threadId: event.payload.threadId,
            cwd: generationCwd,
            ...generationInput,
          }).pipe(Effect.forkScoped);
        }
      }

      // A message sent while this thread's turn is running is a steer. Try to
      // inject it into the live turn immediately (Claude queues it in its prompt
      // stream; Codex accepts it via turn/steer). On success the durable
      // delivery obligation is resolved so the parked path cannot re-deliver it;
      // on any failure the obligation simply stays parked and delivers when the
      // turn ends — the pre-steer behavior. Forked so a slow provider can never
      // stall event processing.
      const currentProviderInstanceId =
        thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
      const requestedProviderInstanceId = event.payload.modelSelection?.instanceId;
      const switchesProviderInstance =
        requestedProviderInstanceId !== undefined &&
        requestedProviderInstanceId !== currentProviderInstanceId;
      const steerTargetsLiveSession =
        requestedProviderInstanceId === undefined ||
        requestedProviderInstanceId === currentProviderInstanceId;
      // A user message arriving mid-turn has exactly one visible fate on
      // success (it steers) and THREE silent exits on failure: a session gate
      // that is not running, a provider-instance mismatch, and a parked row a
      // scheduler already claimed. Observed live: a queued message sat
      // undelivered for the whole turn with nothing in any log to say which
      // gate ate it. One line per mid-turn send is cheap; a silent steer path
      // has already cost a diagnosis.
      if (thread.session?.status === "running" && thread.session.activeTurnId !== null) {
        yield* Effect.logInfo("provider.steer.decision", {
          threadId: event.payload.threadId,
          messageId: event.payload.messageId,
          sessionStatus: thread.session.status,
          activeTurnId: thread.session.activeTurnId,
          requestedProviderInstanceId: requestedProviderInstanceId ?? null,
          currentProviderInstanceId: currentProviderInstanceId ?? null,
          steerTargetsLiveSession,
          switchesProviderInstance,
        });
      }
      // Settings updates and provider handoffs are immediate control actions.
      // The current turn is still running with the old settings/provider, so
      // stop it and leave the new message parked for a fresh turn. Letting a
      // provider handoff merely enter the parked queue deadlocks the switch:
      // that queue waits for the very source turn the switch is meant to
      // replace. Keeping the obligation pending also guarantees the target
      // provider receives the message exactly once after the source settles.
      if (
        thread.session?.status === "running" &&
        thread.session.activeTurnId !== null &&
        (switchesProviderInstance || message.text.startsWith(SETTINGS_UPDATE_MESSAGE_PREFIX))
      ) {
        const interruptedTurnId = thread.session.activeTurnId;
        yield* providerService
          .interruptTurn({
            threadId: event.payload.threadId,
            turnId: interruptedTurnId,
          })
          .pipe(
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
              // The parked delivery still runs at the turn boundary either
              // way; a failed interrupt only means the replacement waits for
              // the turn to end on its own.
              return Effect.logWarning("provider.turn-replacement.interrupt-failed", {
                threadId: event.payload.threadId,
                turnId: interruptedTurnId,
                cause: Cause.pretty(cause),
              });
            }),
            Effect.forkScoped,
          );
        yield* threadWorkScheduler.wake(
          event.payload.modelSelection?.instanceId ??
            thread.session?.providerInstanceId ??
            thread.modelSelection.instanceId,
        );
        return;
      }

      if (
        thread.session?.status === "running" &&
        thread.session.activeTurnId &&
        // A send that requests a different provider is a handoff, not a steer —
        // it must go through the parked path so the switch machinery runs.
        steerTargetsLiveSession
      ) {
        const steerObligationKey = {
          threadId: event.payload.threadId,
          sourceTurnId: activeTurnWorkSourceId(event.payload.messageId),
          kind: "active-turn-recovery",
        } as const;
        yield* Effect.gen(function* () {
          // Claim the parked delivery BEFORE dispatching the steer. Completing
          // it afterwards left a race: the running turn could end between our
          // send succeeding and the transition landing, letting the scheduler
          // claim the still-pending row and deliver the message a second time —
          // observed as duplicate receipts and a desynced provider turn. If the
          // steer then fails, the row is put back and the parked path delivers
          // it at the turn boundary as before.
          const parked = yield* threadWorkObligations.getByKey(steerObligationKey);
          if (Option.isNone(parked) || parked.value.state !== "pending") {
            // The scheduler claims queued deliveries on supervisor-less
            // threads and supervises the blocking turn while holding the row
            // "executing" for the turn's whole lifetime — which makes this
            // exit permanent for that send, not a race. Say so, loudly.
            yield* Effect.logInfo("provider.steer.parked-row-unavailable", {
              threadId: event.payload.threadId,
              messageId: event.payload.messageId,
              rowState: Option.isNone(parked) ? "missing" : parked.value.state,
              rowAttempt: Option.isNone(parked) ? null : parked.value.attempt,
            });
            return;
          }
          const claimedForSteer = yield* threadWorkObligations.transition({
            obligationId: parked.value.obligationId,
            expectedState: "pending",
            expectedAttempt: parked.value.attempt,
            state: "completed",
            nextAttemptAt: null,
            claimedAt: null,
            leaseExpiresAt: null,
            // `completed` temporarily claims this parked row without creating
            // a second active scheduler owner for the already-running thread.
            // The provider's acceptance boundary clears the marker; if the
            // process dies first, startup re-arms the message only when no
            // exact durable delivery receipt exists.
            blockedReason: ACTIVE_TURN_STEER_DELIVERY_UNCONFIRMED_REASON,
            updatedAt: yield* nowIso,
          });
          if (!claimedForSteer) return;
          const steerAccepted = yield* buildSendTurnRequestForThread({
            threadId: event.payload.threadId,
            messageId: event.payload.messageId,
            messageText: message.text,
            ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
            interactionMode: providerInteractionMode(event.payload.interactionMode),
            createdAt: event.payload.createdAt,
          }).pipe(
            Effect.flatMap(providerService.sendTurn),
            // Claude's send resolves when its prompt is queued, so wait for the
            // prompt iterator's durable receipt. Every other adapter resolves
            // at or after its own acceptance boundary and can finalize here;
            // any later receipt is an idempotent second proof.
            Effect.tap(() =>
              waitForClaudeMessageDelivery({
                threadId: event.payload.threadId,
                messageId: event.payload.messageId,
                providerInstanceId: currentProviderInstanceId,
              }),
            ),
            Effect.as(true),
            // Only provider delivery belongs in this fallback. A later metadata
            // write must never re-arm a steer the provider already accepted.
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                if (Cause.hasInterruptsOnly(cause)) return yield* Effect.failCause(cause);
                yield* Effect.logInfo("provider.steer.deferred-to-parked-delivery", {
                  threadId: event.payload.threadId,
                  messageId: event.payload.messageId,
                  cause: Cause.pretty(cause),
                });
                yield* threadWorkObligations
                  .transition({
                    obligationId: parked.value.obligationId,
                    expectedState: "completed",
                    expectedAttempt: parked.value.attempt,
                    expectedBlockedReason: ACTIVE_TURN_STEER_DELIVERY_UNCONFIRMED_REASON,
                    state: "pending",
                    nextAttemptAt: null,
                    claimedAt: null,
                    leaseExpiresAt: null,
                    blockedReason: null,
                    updatedAt: yield* nowIso,
                  })
                  .pipe(Effect.ignore);
                yield* threadWorkScheduler.wake(
                  event.payload.modelSelection?.instanceId ??
                    thread.session?.providerInstanceId ??
                    thread.modelSelection.instanceId,
                );
                return false;
              }),
            ),
          );
          if (!steerAccepted) return;

          const acceptedOwner = yield* threadWorkObligations.getByKey(steerObligationKey);
          if (
            Option.isSome(acceptedOwner) &&
            acceptedOwner.value.state === "completed" &&
            acceptedOwner.value.blockedReason === ACTIVE_TURN_STEER_DELIVERY_UNCONFIRMED_REASON
          ) {
            yield* threadWorkObligations.transition({
              obligationId: acceptedOwner.value.obligationId,
              expectedState: "completed",
              expectedAttempt: acceptedOwner.value.attempt,
              expectedBlockedReason: ACTIVE_TURN_STEER_DELIVERY_UNCONFIRMED_REASON,
              state: "completed",
              nextAttemptAt: null,
              claimedAt: null,
              leaseExpiresAt: null,
              blockedReason: null,
              updatedAt: yield* nowIso,
            });
          }

          // A steer cannot change the model of the turn it joins, but the
          // switch must still land on the thread for the next turn. This is a
          // post-accept bookkeeping action: failure is logged and can never
          // turn an accepted prompt back into queued work.
          const requestedModelSelection = event.payload.modelSelection;
          if (requestedModelSelection !== undefined) {
            threadModelSelections.set(event.payload.threadId, requestedModelSelection);
            yield* serverCommandId("provider-selection-accepted").pipe(
              Effect.flatMap((commandId) =>
                orchestrationEngine.dispatch({
                  type: "thread.meta.update",
                  commandId,
                  threadId: event.payload.threadId,
                  modelSelection: requestedModelSelection,
                }),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("provider.steer.model-selection-update-failed", {
                  threadId: event.payload.threadId,
                  messageId: event.payload.messageId,
                  cause: Cause.pretty(cause),
                }),
              ),
            );
          }
        }).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
            return Effect.logWarning("provider.steer.dispatch-failed", {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            });
          }),
          Effect.forkScoped,
        );
        return;
      }

      yield* threadWorkScheduler.wake(
        event.payload.modelSelection?.instanceId ??
          thread.session?.providerInstanceId ??
          thread.modelSelection.instanceId,
      );
    });

    const appendTaskStoppedActivity = (input: {
      readonly threadId: ThreadId;
      readonly taskId: RuntimeTaskId;
      readonly createdAt: string;
    }) =>
      Effect.all({
        commandId: serverCommandId("provider-task-stopped"),
        eventId: serverEventId(),
      }).pipe(
        Effect.flatMap(({ commandId, eventId }) =>
          orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId,
            threadId: input.threadId,
            activity: {
              id: eventId,
              tone: "info",
              kind: "task.completed",
              summary: "Task stopped",
              payload: {
                taskId: input.taskId,
                status: "stopped",
                summary: "Stopped by the user",
              },
              turnId: null,
              createdAt: input.createdAt,
            },
            createdAt: input.createdAt,
          }),
        ),
      );

    /**
     * Kill one background task or sub-agent, leaving the turn running.
     *
     * Deliberately never touches the session: the whole point of a per-task
     * stop is that the rest of the turn survives. The panel folds its rows
     * from `task.*` activities and only leaves `running` on a `task.completed`,
     * so a successful stop synthesises one — providers that emit their own
     * terminal notification simply re-fold the same row, and providers that do
     * not would otherwise leave the killed task claiming to run forever.
     */
    const processTaskStopRequested = Effect.fn("processTaskStopRequested")(function* (
      event: Extract<ProviderIntentEvent, { type: "thread.task-stop-requested" }>,
    ) {
      const { threadId, taskId, createdAt } = event.payload;
      const thread = yield* resolveThread(threadId);
      if (!thread) return;

      const hasSession = thread.session && thread.session.status !== "stopped";
      if (!hasSession) {
        // Nothing is left to kill, but the row still claims to run — settle it
        // rather than reporting a failure the user cannot act on.
        yield* appendTaskStoppedActivity({ threadId, taskId, createdAt });
        return;
      }

      yield* providerService.stopTask({ threadId, taskId }).pipe(
        // A provider task RPC is advisory and must not monopolize the ordinary
        // event worker forever. The task remains visible with a failure if the
        // provider does not acknowledge it in time.
        Effect.timeout("5 seconds"),
        Effect.flatMap(() => appendTaskStoppedActivity({ threadId, taskId, createdAt })),
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId,
            kind: "provider.task.stop.failed",
            summary: "Could not stop the task",
            detail: formatFailureDetail(cause),
            turnId: thread.session?.activeTurnId ?? null,
            createdAt,
          }),
        ),
      );
    });

    const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
      event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
    ) {
      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread) {
        return;
      }
      const session = thread.session;
      if (!session) {
        // No session row at all, so nothing claims to be running and there is
        // nothing to release. `derivePhase(null)` is already "disconnected".
        return;
      }
      const interruptedAt = event.payload.createdAt;
      const alreadyIdle = session.status === "stopped" && session.activeTurnId === null;

      /**
       * Stop is authoritative over T3's own state, and only best-effort over the
       * provider's. Those two must never be conflated.
       *
       * The session row is what the composer reads to decide it is "working", so
       * leaving it on `running` because a dead CLI could not be reached is the
       * one outcome the user cannot recover from: the spinner keeps turning, the
       * Stop button re-arms against a turn nobody can kill, and the silence
       * watchdog keeps re-dispatching the turn behind it. Observed 2026-08-06,
       * when a usage-limited Codex session pinned a thread in `running` for
       * three hours across five watchdog restarts.
       *
       * So the row is cleared unconditionally at the end of this handler. A
       * provider that refuses to die still gets its failure surfaced as an
       * activity, but it no longer holds the thread hostage.
       */
      if (session.status === "stopped") {
        // Nothing to kill upstream, but the row may still claim an active turn.
        // Fall through to the terminalization below rather than reporting a
        // failure the user cannot act on.
        yield* Effect.logDebug("provider turn interrupt on an already-stopped session", {
          threadId: event.payload.threadId,
          activeTurnId: session.activeTurnId,
        });
      } else {
        // Orchestration turn ids are not provider turn ids, so interrupt by session.
        // A provider interrupt is cooperative and can acknowledge before its CLI or
        // an in-flight tool actually exits. Explicit Stop is stronger: try the
        // cooperative path briefly, then close the provider session so no orphaned
        // process can continue emitting work. The next message restores the
        // provider from its persisted resume cursor.
        let cooperativeInterruptFailure: string | null = null;
        yield* providerService.interruptTurn({ threadId: event.payload.threadId }).pipe(
          Effect.timeout("2 seconds"),
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              cooperativeInterruptFailure = formatFailureDetail(cause);
            }),
          ),
        );
        // A wedged adapter can hang here as easily as it hung mid-turn — an
        // unbounded stop would strand the whole interrupt and never reach the
        // terminalization below, which is precisely the state Stop exists to
        // escape. Bound it, and treat the timeout as a provider failure.
        const stopFailure = yield* providerService
          .stopSession({ threadId: event.payload.threadId })
          .pipe(
            Effect.timeout("10 seconds"),
            Effect.as(null),
            Effect.catchCause((cause) => Effect.succeed(formatFailureDetail(cause))),
          );
        if (stopFailure !== null) {
          yield* appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.turn.interrupt.failed",
            summary: "Stopped locally; the provider session may still be running",
            detail: [
              cooperativeInterruptFailure
                ? `The provider did not acknowledge the cooperative interrupt: ${cooperativeInterruptFailure}`
                : null,
              `The provider session could not be stopped: ${stopFailure}`,
              "This thread was released anyway, so it is safe to send again. A stale provider process, if any, is reaped separately.",
            ]
              .filter((entry): entry is string => entry !== null)
              .join("\n"),
            turnId: event.payload.turnId ?? session.activeTurnId ?? null,
            createdAt: interruptedAt,
          });
        } else if (cooperativeInterruptFailure) {
          yield* Effect.logWarning(
            "provider cooperative interrupt required a forced session stop",
            {
              threadId: event.payload.threadId,
              detail: cooperativeInterruptFailure,
            },
          );
        }
      }

      if (alreadyIdle) return;
      yield* setThreadSession({
        threadId: event.payload.threadId,
        session: {
          ...session,
          status: "stopped",
          activeTurnId: null,
          lastError: null,
          updatedAt: interruptedAt,
        },
        createdAt: interruptedAt,
      });
    });

    const processQueuedTurnPromoteRequested = Effect.fn("processQueuedTurnPromoteRequested")(
      function* (
        event: Extract<ProviderIntentEvent, { type: "thread.queued-turn-promote-requested" }>,
      ) {
        const thread = yield* resolveThread(event.payload.threadId);
        if (!thread?.session || thread.session.status === "stopped") return;
        yield* providerService.promoteQueuedTurn({ threadId: event.payload.threadId }).pipe(
          Effect.flatMap((messageIds) =>
            appendQueuedTurnPromotionActivity({
              threadId: event.payload.threadId,
              turnId: thread.session?.activeTurnId ?? null,
              messageIds,
              createdAt: event.payload.createdAt,
            }),
          ),
          Effect.catchCause((cause) =>
            appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.queue.promote.failed",
              summary: "Could not send the queued messages now",
              detail: formatFailureDetail(cause),
              turnId: thread.session?.activeTurnId ?? null,
              createdAt: event.payload.createdAt,
            }),
          ),
        );
      },
    );

    /**
     * Settle a thread whose provider callback is gone.
     *
     * A stale approval/user-input request means the provider's in-memory
     * callback map has no entry for it — the process behind the session died,
     * restarted, or was recovered. The session row still says "running", and
     * because turns only settle when the session leaves that status, the turn
     * the request belonged to stayed `running` forever: the composer stayed
     * disabled, the thread read as busy, and the answer could never be
     * delivered or retried. The only way out was restarting the app, which
     * settles running turns on the way up.
     *
     * `stopped` rather than `error`: nothing failed, the callback is simply
     * gone. That settles the turn as `incomplete` — the same state the restart
     * path uses for exactly this situation — which leaves the thread resumable
     * instead of latched terminal by the continuation gate.
     */
    const settleThreadAfterStaleRequest = Effect.fnUntraced(function* (input: {
      readonly threadId: ThreadId;
      readonly requestId: string;
      readonly resolvedKind: "user-input.resolved" | "approval.resolved";
      readonly createdAt: string;
    }) {
      const thread = yield* resolveThread(input.threadId);
      if (!thread) return;
      const session = thread.session;
      if (!session || session.status === "stopped") return;

      // "Unknown pending request" has a second, entirely healthy cause: the
      // request was already answered and the adapter dropped it from its map,
      // so a double submit — two clicks, or the same prompt answered from two
      // windows — lands here with a live session mid-turn. Stopping that would
      // kill working work. Only a request that was never resolved is evidence
      // the callbacks themselves are gone.
      const alreadyResolved = hasResolvedProviderRequest(thread.activities, input);
      if (alreadyResolved) return;

      // Best-effort: the point is to release the thread, so a provider that
      // cannot be stopped (already gone — the usual case here) must not stop
      // the projection update that actually unblocks the user.
      yield* providerService
        .stopSession({ threadId: input.threadId })
        .pipe(Effect.catchCause(() => Effect.void));

      yield* setThreadSession({
        threadId: input.threadId,
        session: {
          ...session,
          status: "stopped",
          activeTurnId: null,
          lastError: null,
          updatedAt: input.createdAt,
        },
        createdAt: input.createdAt,
      });
    });

    const processApprovalResponseRequested = Effect.fn("processApprovalResponseRequested")(
      function* (
        event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
      ) {
        const thread = yield* resolveThread(event.payload.threadId);
        if (!thread) {
          return;
        }
        const resolvedRequest = {
          requestId: event.payload.requestId,
          resolvedKind: "approval.resolved" as const,
        };
        if (hasResolvedProviderRequest(thread.activities, resolvedRequest)) {
          return;
        }
        const hasSession = thread.session && thread.session.status !== "stopped";
        if (!hasSession) {
          return yield* appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            detail: "No active provider session is bound to this thread.",
            turnId: null,
            createdAt: event.payload.createdAt,
            requestId: event.payload.requestId,
          });
        }

        yield* providerService
          .respondToRequest({
            threadId: event.payload.threadId,
            requestId: event.payload.requestId,
            decision: event.payload.decision,
          })
          .pipe(
            Effect.catchCause((cause) => {
              const stale = isUnknownPendingApprovalRequestError(cause);
              if (!stale) {
                return appendProviderFailureActivity({
                  threadId: event.payload.threadId,
                  kind: "provider.approval.respond.failed",
                  summary: "Provider approval response failed",
                  detail: Cause.pretty(cause),
                  turnId: null,
                  createdAt: event.payload.createdAt,
                  requestId: event.payload.requestId,
                });
              }
              return Effect.gen(function* () {
                const refreshed = yield* resolveThread(event.payload.threadId);
                if (
                  refreshed &&
                  hasResolvedProviderRequest(refreshed.activities, resolvedRequest)
                ) {
                  return;
                }
                yield* appendProviderFailureActivity({
                  threadId: event.payload.threadId,
                  kind: "provider.approval.respond.failed",
                  summary: "Provider approval response failed",
                  detail: stalePendingRequestDetail("approval", event.payload.requestId),
                  turnId: null,
                  createdAt: event.payload.createdAt,
                  requestId: event.payload.requestId,
                });
                yield* settleThreadAfterStaleRequest({
                  threadId: event.payload.threadId,
                  ...resolvedRequest,
                  createdAt: event.payload.createdAt,
                });
              });
            }),
          );
      },
    );

    const processUserInputResponseRequested = Effect.fn("processUserInputResponseRequested")(
      function* (
        event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
      ) {
        const brokerResolution = yield* actionApprovalBroker.resolve({
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
          answers: event.payload.answers,
        });
        if (brokerResolution !== "not_owned") {
          return;
        }

        const thread = yield* resolveThread(event.payload.threadId);
        if (!thread) {
          return;
        }
        const resolvedRequest = {
          requestId: event.payload.requestId,
          resolvedKind: "user-input.resolved" as const,
        };
        if (hasResolvedProviderRequest(thread.activities, resolvedRequest)) {
          return;
        }
        const hasSession = thread.session && thread.session.status !== "stopped";
        if (!hasSession) {
          return yield* appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.user-input.respond.failed",
            summary: "Provider user input response failed",
            detail: "No active provider session is bound to this thread.",
            turnId: null,
            createdAt: event.payload.createdAt,
            requestId: event.payload.requestId,
          });
        }

        yield* providerService
          .respondToUserInput({
            threadId: event.payload.threadId,
            requestId: event.payload.requestId,
            answers: event.payload.answers,
          })
          .pipe(
            Effect.catchCause((cause) => {
              const stale = isUnknownPendingUserInputRequestError(cause);
              if (!stale) {
                return appendProviderFailureActivity({
                  threadId: event.payload.threadId,
                  kind: "provider.user-input.respond.failed",
                  summary: "Provider user input response failed",
                  detail: Cause.pretty(cause),
                  turnId: null,
                  createdAt: event.payload.createdAt,
                  requestId: event.payload.requestId,
                });
              }
              return Effect.gen(function* () {
                const refreshed = yield* resolveThread(event.payload.threadId);
                if (
                  refreshed &&
                  hasResolvedProviderRequest(refreshed.activities, resolvedRequest)
                ) {
                  return;
                }
                yield* appendProviderFailureActivity({
                  threadId: event.payload.threadId,
                  kind: "provider.user-input.respond.failed",
                  summary: "Provider user input response failed",
                  detail: stalePendingRequestDetail("user-input", event.payload.requestId),
                  turnId: null,
                  createdAt: event.payload.createdAt,
                  requestId: event.payload.requestId,
                });
                yield* settleThreadAfterStaleRequest({
                  threadId: event.payload.threadId,
                  ...resolvedRequest,
                  createdAt: event.payload.createdAt,
                });
              });
            }),
          );
      },
    );

    /**
     * Re-derive the plan's task list from the conversation.
     *
     * Runs entirely outside the turn stream: nothing is sent to the provider
     * session and no message is added to the thread, so this is safe to trigger
     * while a turn is in flight. Progress is reported through the same
     * `task.started` / `task.completed` activities the background-tasks panel
     * already renders, so a refresh is visible while it runs and a failure is
     * visible rather than silent.
     */
    const processPlanRefreshRequested = Effect.fn("processPlanRefreshRequested")(function* (
      event: Extract<ProviderIntentEvent, { type: "thread.plan-refresh-requested" }>,
    ) {
      const threadId = event.payload.threadId;
      const thread = yield* resolveThread(threadId);
      if (!thread) return;

      const taskId = RuntimeTaskId.make(`plan-refresh:${event.eventId}`);
      const startedAt = event.payload.createdAt;

      const appendActivity = (input: {
        readonly kind: string;
        readonly tone: "info" | "error";
        readonly summary: string;
        readonly payload: Readonly<Record<string, unknown>>;
        readonly createdAt: string;
      }) =>
        Effect.gen(function* () {
          yield* orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: yield* serverCommandId(`plan-refresh-${input.kind}`),
            threadId,
            activity: {
              id: EventId.make(`${event.eventId}:${input.kind}`),
              tone: input.tone,
              kind: input.kind,
              summary: input.summary,
              payload: input.payload,
              turnId: null,
              createdAt: input.createdAt,
            },
            createdAt: input.createdAt,
          });
        });

      yield* appendActivity({
        kind: "task.started",
        tone: "info",
        summary: "Refreshing plan",
        payload: {
          taskId,
          taskType: "plan-refresh",
          detail: "Re-reading the conversation to update the task list",
        },
        createdAt: startedAt,
      });

      yield* Effect.gen(function* () {
        const { textGenerationModelSelection: modelSelection } =
          yield* serverSettingsService.getSettings;

        const currentSteps = derivePlanRefreshCurrentSteps(thread.activities);
        const transcript = buildPlanRefreshTranscript(thread.messages);
        if (transcript.trim().length === 0) {
          // Nothing to read yet — refreshing would only invent work.
          yield* appendActivity({
            kind: "task.completed",
            tone: "info",
            summary: "Plan refresh skipped",
            payload: { taskId, status: "completed", summary: "No conversation to read yet" },
            createdAt: yield* nowIso,
          });
          return;
        }

        const project = yield* resolveProject(thread.projectId);
        const generated = yield* textGeneration.generatePlanRefresh({
          cwd:
            resolveThreadWorkspaceCwd({ thread, projects: project ? [project] : [] }) ??
            process.cwd(),
          transcript,
          currentSteps,
          modelSelection,
        });

        const completedAt = yield* nowIso;
        if (generated.steps.length > 0) {
          // Written as the same activity a provider emits, so the plan panel picks
          // it up through the existing derivation with no special-casing.
          yield* appendActivity({
            kind: "turn.plan.updated",
            tone: "info",
            summary: "Plan updated",
            payload: {
              plan: generated.steps.map((entry) => ({ step: entry.step, status: entry.status })),
              explanation: "Refreshed from the conversation.",
            },
            createdAt: completedAt,
          });
        }

        yield* appendActivity({
          kind: "task.completed",
          tone: "info",
          summary: "Plan refreshed",
          payload: {
            taskId,
            status: "completed",
            summary:
              generated.steps.length > 0
                ? `Updated ${generated.steps.length} step${generated.steps.length === 1 ? "" : "s"}`
                : "No changes",
          },
          createdAt: completedAt,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("provider command reactor failed to refresh plan", {
              threadId,
              cause: Cause.pretty(cause),
            });
            yield* appendActivity({
              kind: "task.completed",
              tone: "error",
              summary: "Plan refresh failed",
              payload: { taskId, status: "failed", summary: "Could not refresh the plan" },
              createdAt: yield* nowIso,
            }).pipe(Effect.ignoreCause({ log: true }));
          }),
        ),
      );
    });

    const processSessionStopRequested = Effect.fn("processSessionStopRequested")(function* (
      event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
    ) {
      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread) {
        return;
      }

      const now = event.payload.createdAt;
      // The session projector applies this request before the async reactor
      // handles it, so the read model already says `stopped` here. Presence of
      // a session—not its projected status—is the signal that the provider
      // process still needs the requested stop side effect.
      if (thread.session) {
        yield* providerService.stopSession({ threadId: thread.id }).pipe(
          // A provider stop is best-effort from this reactor: the projection
          // has already made the session locally stopped. Never let a provider
          // that ignores cancellation pin this thread's control lane forever.
          Effect.timeout("5 seconds"),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider session stop did not settle before the deadline", {
              threadId: thread.id,
              cause: Cause.pretty(cause),
            }),
          ),
        );
      }

      yield* setThreadSession({
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: "stopped",
          providerName: thread.session?.providerName ?? null,
          ...(thread.session?.providerInstanceId !== undefined
            ? { providerInstanceId: thread.session.providerInstanceId }
            : {}),
          runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });
    });

    const processThreadForked = Effect.fn("processThreadForked")(function* (
      event: Extract<ProviderIntentEvent, { type: "thread.forked" }>,
    ) {
      if (!providerService.forkSessionBinding) {
        yield* Effect.logWarning("provider service does not support conversation forking", {
          threadId: event.payload.threadId,
          sourceThreadId: event.payload.sourceThreadId,
        });
        return;
      }
      const sourceThread = yield* resolveThread(event.payload.sourceThreadId);
      if (!sourceThread) {
        yield* Effect.logWarning("thread fork source is unavailable for provider session cloning", {
          threadId: event.payload.threadId,
          sourceThreadId: event.payload.sourceThreadId,
        });
        return;
      }
      if (sourceThread.modelSelection.instanceId !== event.payload.modelSelection.instanceId) {
        // Provider-native conversation ids are scoped to a configured provider
        // instance. A side chat that selects another provider must start fresh;
        // copying the source binding would make (for example) Claude try to
        // resume a Codex conversation id and can race the target turn startup.
        yield* Effect.logInfo("skipping provider session clone across provider instances", {
          threadId: event.payload.threadId,
          sourceThreadId: event.payload.sourceThreadId,
          sourceProviderInstanceId: sourceThread.modelSelection.instanceId,
          targetProviderInstanceId: event.payload.modelSelection.instanceId,
        });
        return;
      }
      const forkedSession = yield* providerService.forkSessionBinding({
        sourceThreadId: event.payload.sourceThreadId,
        targetThreadId: event.payload.threadId,
        runtimeMode: event.payload.runtimeMode,
      });
      if (!forkedSession) {
        yield* Effect.logWarning("thread fork has no forkable persisted provider session", {
          threadId: event.payload.threadId,
          sourceThreadId: event.payload.sourceThreadId,
        });
        return;
      }
      if (forkedSession.providerInstanceId === undefined) {
        return yield* new ProviderAdapterRequestError({
          provider: providerErrorLabel(forkedSession.provider),
          method: "thread.fork",
          detail: `Forked provider session '${forkedSession.threadId}' is missing a provider instance id.`,
        });
      }
      yield* setThreadSession({
        threadId: event.payload.threadId,
        session: {
          threadId: event.payload.threadId,
          status: mapProviderSessionStatusToOrchestrationStatus(forkedSession.status),
          providerName: forkedSession.provider,
          providerInstanceId: forkedSession.providerInstanceId,
          runtimeMode: forkedSession.runtimeMode,
          activeTurnId: null,
          lastError: forkedSession.lastError ?? null,
          updatedAt: forkedSession.updatedAt,
        },
        createdAt: event.occurredAt,
      });
    });

    const pauseThreadForProviderAuthenticationFailure = Effect.fn(
      "pauseThreadForProviderAuthenticationFailure",
    )(function* (input: {
      readonly thread: OrchestrationThreadShell;
      readonly detail: string;
      readonly createdAt: string;
    }) {
      const providerInstanceId =
        input.thread.session?.providerInstanceId ?? input.thread.modelSelection.instanceId;
      // Stopped settles a running source turn as incomplete. The subsequent
      // error describes the pause without rewriting that turn to terminal error.
      yield* setThreadSession({
        threadId: input.thread.id,
        session: {
          ...(input.thread.session ?? {
            threadId: input.thread.id,
            providerName: null,
            providerInstanceId,
            runtimeMode: input.thread.runtimeMode,
          }),
          status: "stopped",
          activeTurnId: null,
          lastError: input.detail,
          updatedAt: input.createdAt,
        },
        createdAt: input.createdAt,
      });
      yield* providerService.stopSession({ threadId: input.thread.id }).pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("provider auth pause found no live session to stop", {
            threadId: input.thread.id,
            cause: Cause.pretty(cause),
          }),
        ),
      );
      yield* setThreadSession({
        threadId: input.thread.id,
        session: {
          ...(input.thread.session ?? {
            threadId: input.thread.id,
            providerName: null,
            providerInstanceId,
            runtimeMode: input.thread.runtimeMode,
          }),
          status: "error",
          activeTurnId: null,
          lastError: input.detail,
          updatedAt: input.createdAt,
        },
        createdAt: input.createdAt,
      });
      // Replace any cached authenticated snapshot with a fresh health probe so
      // usage disappears immediately and the post-login transition is real.
      yield* providerRegistry.refreshInstance(providerInstanceId).pipe(Effect.asVoid);
    });

    const messageDeliveryRecorded = (
      thread: OrchestrationThread | undefined,
      messageId: MessageId,
    ): boolean =>
      thread?.activities.some((activity) => {
        if (activity.kind !== "message.delivered") return false;
        const payload = activity.payload;
        return (
          typeof payload === "object" &&
          payload !== null &&
          "messageId" in payload &&
          payload.messageId === messageId
        );
      }) ?? false;

    const waitForClaudeMessageDelivery = Effect.fn("waitForClaudeMessageDelivery")(
      function* (input: {
        readonly threadId: ThreadId;
        readonly messageId: MessageId;
        readonly providerInstanceId: ServerProvider["instanceId"];
      }) {
        const info = yield* providerService.getInstanceInfo(input.providerInstanceId);
        if (info.driverKind !== ProviderDriverKind.make("claudeAgent")) return;
        while (true) {
          const thread = yield* resolveThread(input.threadId);
          if (!thread) return;
          if (messageDeliveryRecorded(thread, input.messageId)) return;
          if (thread.session?.status === "error") {
            const detail = thread.session.lastError ?? "provider delivery failed";
            return yield* new ProviderAdapterRequestError({
              provider: providerErrorLabelFromInstanceHint({
                instanceId: String(input.providerInstanceId),
              }),
              method: "thread.turn.start",
              detail,
            });
          }
          yield* Effect.sleep(Duration.millis(100));
        }
      },
    );

    /**
     * Dead-feed ceiling. Every projected message and activity bumps the thread
     * row's updatedAt, so a supervised turn whose shell fingerprint has not
     * moved at all in four minutes has a dead notification stream — providers
     * emit tool activity, deltas, and token counts far more often than that
     * while genuinely working.
     */
    const PROVIDER_SILENCE_RESTART_MS = options?.providerSilenceRestartMs ?? 240_000;
    // A turn that is actively running gets a much longer leash: a reasoning
    // model at high effort can think for many minutes while streaming nothing
    // at all — no deltas, no heartbeats — and killing that is executing a
    // healthy turn (observed live: a 12m33s turn died 4m01s after its last
    // tool event, mid-think, with zero assistant text to show for it). The
    // fast window continues to cover the state it was built for: a session
    // wedged in ready/idle with no active turn, which never thinks.
    const PROVIDER_MID_TURN_SILENCE_RESTART_MS =
      options?.providerMidTurnSilenceRestartMs ?? 900_000;

    const retryWorkAfter15Seconds = (reason: string) =>
      DateTime.now.pipe(
        Effect.map((now) => ({
          state: "sleeping" as const,
          nextAttemptAt: DateTime.formatIso(DateTime.add(now, { seconds: 15 })),
          reason,
        })),
      );

    /**
     * Failure-driven retry, as opposed to the uncapped progress-waits above.
     *
     * Deterministic failures — a broken build, a config that can never load —
     * fail identically on every attempt, and without a ceiling this loop
     * re-dispatched one dead turn every 15 seconds indefinitely, flapping the
     * session and stacking error activities the whole time. The obligation's
     * durable attempt counter survives restarts, so the cap holds across them.
     * Structured transient upstream failures take the separate unbounded path
     * below. Anything on this path still failing after that many round trips is
     * deterministic or unclassified and needs a human, not another retry.
     */
    const MAX_FAILURE_RETRY_ATTEMPTS = 8;
    const retryFailureWork = (
      reason: string,
      attempt: number,
    ): Effect.Effect<ThreadWorkExecutionOutcome> =>
      attempt >= MAX_FAILURE_RETRY_ATTEMPTS
        ? Effect.succeed({
            state: "cancelled" as const,
            reason: `Gave up after ${attempt} failed attempts: ${reason}`,
          })
        : retryWorkAfter15Seconds(reason);

    const retryTransientUpstreamWork = (
      reason: string,
      attempt: number,
    ): Effect.Effect<ThreadWorkExecutionOutcome> => {
      const delayMs = Math.min(15_000, 1_000 * 2 ** Math.max(0, attempt - 1));
      return DateTime.now.pipe(
        Effect.map((now) => ({
          state: "sleeping" as const,
          nextAttemptAt: DateTime.formatIso(DateTime.add(now, { milliseconds: delayMs })),
          reason,
          retainedRuntimePhase: "provider-retrying" as const,
        })),
      );
    };

    const recoverThreadWorkFailure = (
      cause: Cause.Cause<unknown>,
      attempt: number,
    ): Effect.Effect<ThreadWorkExecutionOutcome, never> => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
      const detail = formatFailureDetail(cause);
      if (isProviderAuthenticationFailure(detail)) {
        return Effect.succeed({ state: "blocked-authentication" as const, reason: detail });
      }
      // The provider has tripped its own breaker and says retrying cannot work
      // until a human intervenes. Re-attempting it every 15s just republished
      // "Provider turn start failed" under a permanent "Auto-resuming thread…",
      // with nothing for the user to cancel. Retire the obligation instead: the
      // error stays visible and the next real message starts a turn normally.
      if (isTerminalProviderRefusal(detail)) {
        return Effect.succeed({ state: "cancelled" as const, reason: detail });
      }
      return isRetryableUpstreamFailure(cause)
        ? retryTransientUpstreamWork(detail, attempt)
        : retryFailureWork(detail, attempt);
    };

    const getPersistedTurnStartContext = (threadId: ThreadId, messageId: MessageId) =>
      projectionSnapshotQuery.getThreadTurnStartContext === undefined
        ? Effect.succeed(Option.none<ProjectionPersistedTurnStartContext>())
        : projectionSnapshotQuery.getThreadTurnStartContext(threadId, messageId);

    const getPersistedProviderTurnForMessage = (threadId: ThreadId, messageId: MessageId) =>
      projectionSnapshotQuery.getThreadProviderTurnForMessage === undefined
        ? Effect.succeed(Option.none())
        : projectionSnapshotQuery.getThreadProviderTurnForMessage(threadId, messageId);

    const getPersistedProviderTurnById = (threadId: ThreadId, turnId: TurnId) =>
      projectionSnapshotQuery.getThreadProviderTurnById === undefined
        ? Effect.succeed(Option.none())
        : projectionSnapshotQuery.getThreadProviderTurnById(threadId, turnId);

    const waitForProviderTurnTerminal = Effect.fn("waitForProviderTurnTerminal")(function* (input: {
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly attempt: number;
      /**
       * Require the turn to have produced output before accepting it as done.
       * Set for resumes: an upstream request that times out ends the turn
       * "successfully" with nothing in it, and accepting that retires the
       * obligation for a resume that never happened.
       */
      readonly requireTurnOutput?: boolean;
    }) {
      let lastShellFingerprint = "";
      let lastShellChangeAtMs = Number.NaN;
      // Whether this wait has handed its provider slot back while a person
      // answers. Released on every exit below, so a turn that ends while the
      // prompt is still up cannot leak the parked state.
      let admissionParked = false;
      while (true) {
        const shell = yield* projectionSnapshotQuery
          .getThreadShellById(input.threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        if (!shell) {
          return { state: "cancelled" as const, reason: "thread disappeared" };
        }

        const latestTurn = shell.latestTurn;
        // Failover can start a successor before the obligation supervising the
        // original turn observes its completion. Once that happens
        // `shell.latestTurn` points at the successor forever. Read the exact
        // awaited row only on that uncommon mismatch path; the normal 100ms
        // poll remains a single lightweight shell query.
        const awaitedTurn =
          latestTurn?.turnId === input.turnId
            ? latestTurn
            : yield* getPersistedProviderTurnById(input.threadId, input.turnId).pipe(
                Effect.map(Option.getOrUndefined),
              );
        if (awaitedTurn !== undefined) {
          if (awaitedTurn.state === "completed") {
            if (input.requireTurnOutput === true) {
              // Runs once, when the turn settles — not on every 100ms poll.
              const settledThread = yield* resolveThread(input.threadId);
              if (settledThread && !providerTurnProducedOutput(settledThread, input.turnId)) {
                return yield* retryFailureWork(
                  "resume turn completed without producing any output",
                  input.attempt,
                );
              }
            }
            return { state: "completed" as const };
          }
          if (awaitedTurn.state === "interrupted") {
            return { state: "cancelled" as const, reason: "turn was interrupted" };
          }
          if (awaitedTurn.state === "incomplete" || awaitedTurn.state === "error") {
            // A mismatched latest turn belongs to a successor session. Do not
            // attribute that successor's error text to the turn being awaited.
            const detail =
              latestTurn?.turnId === input.turnId
                ? (shell.session?.lastError ?? `provider turn became ${awaitedTurn.state}`)
                : `provider turn became ${awaitedTurn.state}`;
            if (isProviderAuthenticationFailure(detail)) {
              return { state: "blocked-authentication" as const, reason: detail };
            }
            return yield* retryFailureWork(detail, input.attempt);
          }
        }

        if (shell.session?.failureKind === "retryable-upstream") {
          return yield* retryTransientUpstreamWork(
            shell.session.lastError ?? "retryable upstream provider failure",
            input.attempt,
          );
        }

        if (shell.session?.status === "error") {
          const detail = shell.session.lastError ?? "provider turn failed";
          if (isProviderAuthenticationFailure(detail)) {
            return { state: "blocked-authentication" as const, reason: detail };
          }
          return yield* retryFailureWork(detail, input.attempt);
        }
        if (
          shell.session?.activeTurnId === null &&
          (shell.session.status === "stopped" || shell.session.status === "interrupted")
        ) {
          return {
            state: "cancelled" as const,
            reason: `provider session ${shell.session.status}`,
          };
        }

        // Watchdog: a provider that stops emitting entirely mid-turn (dropped
        // notification stream, wedged emitter) leaves this loop waiting forever
        // while the claim heartbeat keeps the thread locked. Every projected
        // message and activity bumps the shell's timestamps, so a frozen shell
        // fingerprint on a "running" session is a dead feed, not a thinking
        // model — restart the session and let resume reconcile from the
        // provider's own record. (An earlier version watched the directory's
        // lastSeenAt, which does NOT move during streaming, and executed
        // healthy four-minute turns.)
        const shellFingerprint = [
          shell.updatedAt,
          shell.session?.updatedAt ?? "",
          shell.session?.status ?? "",
          shell.session?.activeTurnId ?? "",
          latestTurn?.state ?? "",
        ].join("|");
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        // A question on the screen is not a dead feed. While a turn waits on
        // a person, the provider emits nothing by design: Claude's
        // `canUseTool` promise is parked inside the SDK, so no messages, no
        // heartbeats, and a frozen shell. The watchdog read that as death and
        // stopped the session out from under the prompt — which threw away
        // the in-memory callback, so the answer came back "Stale pending
        // user-input request", the card vanished mid-read, and the resumed
        // turn eventually died as "Request timed out".
        //
        // Parking also hands the concurrency slot back: the obligation stays
        // `executing` for however long the person takes (the durable
        // waiting-user-input state needs a callback the Claude adapter cannot
        // rebuild), and holding the per-provider budget that whole time
        // starved every other thread on that provider.
        const awaitingHuman = shell.hasPendingUserInput || shell.hasPendingApprovals;
        if (awaitingHuman !== admissionParked) {
          admissionParked = awaitingHuman;
          yield* threadWorkScheduler.setAdmissionParked({
            threadId: input.threadId,
            parked: awaitingHuman,
          });
        }
        if (awaitingHuman) {
          // Keep the silence clock from accruing across the wait, so an
          // answer at minute 30 does not land on an already-doomed turn.
          lastShellChangeAtMs = nowMs;
          yield* Effect.sleep(Duration.millis(100));
          continue;
        }
        const midTurn =
          shell.session?.status === "running" && shell.session.activeTurnId === input.turnId;
        const silenceRestartMs = midTurn
          ? PROVIDER_MID_TURN_SILENCE_RESTART_MS
          : PROVIDER_SILENCE_RESTART_MS;
        if (shellFingerprint !== lastShellFingerprint || !Number.isFinite(lastShellChangeAtMs)) {
          lastShellFingerprint = shellFingerprint;
          lastShellChangeAtMs = nowMs;
        } else if (nowMs - lastShellChangeAtMs > silenceRestartMs) {
          // Deliberately NOT gated on a "running" session. A session that settles
          // to "ready"/"idle" with no active turn, while this turn never reached
          // a terminal latestTurn, matches none of the exits above: not an error,
          // not stopped/interrupted. Gating the watchdog on "running" left that
          // state spinning here at 10Hz forever while the claim heartbeat renewed
          // the lease, and — because the scheduler admits one active obligation
          // per thread — every later send on the thread starved in "pending" with
          // no error anywhere. Every terminal status already returns earlier, so
          // anything still here is non-terminal and a frozen fingerprint means a
          // dead feed regardless of which non-terminal status it froze in.
          //
          // A frozen SHELL is not a dead FEED, though: a long-running tool call
          // emits only 30-second provider heartbeats, none of which touch the
          // projected shell. Killing the session on shell silence alone
          // executed an 11-minute APK build mid-flight ("Session stopped",
          // command failed, turn interrupted). Consult the in-memory runtime
          // liveness the scheduler keeps from ingestion's observations, and
          // only declare death when the provider itself has also gone quiet.
          const livenessAt = yield* threadWorkScheduler
            .runtimeLivenessAt(input.threadId)
            .pipe(Effect.map(Option.getOrUndefined));
          if (livenessAt !== undefined && nowMs - livenessAt <= silenceRestartMs) {
            lastShellChangeAtMs = livenessAt;
          } else {
            yield* Effect.logWarning("thread-work.turn-wait.provider-silent", {
              threadId: input.threadId,
              turnId: input.turnId,
              silentForMs: nowMs - lastShellChangeAtMs,
              lastRuntimeEventAgoMs: livenessAt === undefined ? null : nowMs - livenessAt,
            });
            yield* providerService.stopSession({ threadId: input.threadId }).pipe(Effect.ignore);
            return yield* retryWorkAfter15Seconds(
              "provider went silent mid-turn; restarting the session",
            );
          }
        }

        yield* Effect.sleep(Duration.millis(100));
      }
    });

    const recoverActiveTurnFailure = (input: {
      readonly context: TurnStartRequestedPayload;
      readonly cause: Cause.Cause<unknown>;
      readonly attempt: number;
    }): Effect.Effect<ThreadWorkExecutionOutcome, never> =>
      Effect.gen(function* () {
        if (Cause.hasInterruptsOnly(input.cause)) return yield* Effect.interrupt;
        const detail = formatFailureDetail(input.cause);
        const thread = yield* resolveThread(input.context.threadId).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        const requestedInstanceId = input.context.modelSelection?.instanceId;
        // The accepted provider selection is persisted only after sendTurn
        // succeeds. Until then, a different instance in the turn-start context
        // is an attempted handoff. Retrying a rejected handoff cannot repair
        // validation, credentials, or a failed target process; it only leaves
        // the original user's message permanently queued and stacks identical
        // failure activities. A switch failure is therefore terminal after its
        // first durable error, while ordinary same-provider recovery keeps its
        // existing retry policy.
        const manualProviderSwitchFailed =
          requestedInstanceId !== undefined &&
          thread !== undefined &&
          requestedInstanceId !== thread.modelSelection.instanceId;
        if (isRetryableUpstreamFailure(input.cause) && !manualProviderSwitchFailed) {
          return yield* retryTransientUpstreamWork(detail, input.attempt);
        }
        yield* setThreadSessionErrorOnTurnStartFailure({
          threadId: input.context.threadId,
          detail,
          createdAt: input.context.createdAt,
        }).pipe(
          Effect.flatMap(() =>
            appendProviderFailureActivity({
              threadId: input.context.threadId,
              kind: "provider.turn.start.failed",
              summary: "Provider turn start failed",
              detail,
              turnId: null,
              createdAt: input.context.createdAt,
            }),
          ),
          Effect.catchCause((recoveryCause) =>
            Effect.logWarning("provider command reactor failed to record durable turn failure", {
              threadId: input.context.threadId,
              cause: Cause.pretty(recoveryCause),
              originalCause: Cause.pretty(input.cause),
            }),
          ),
        );
        if (manualProviderSwitchFailed) {
          return {
            state: "cancelled" as const,
            reason: `Provider switch failed: ${detail}`,
          };
        }
        return yield* recoverThreadWorkFailure(input.cause, input.attempt);
      });

    const executeActiveTurnRecovery: ThreadWorkHandler = (obligation) =>
      Effect.gen(function* () {
        yield* Effect.logDebug("thread-work.active-turn.begin", {
          obligationId: obligation.obligationId,
          threadId: obligation.threadId,
          attempt: obligation.attempt,
        });
        const messageId = activeTurnMessageIdFromSourceTurnId(obligation.sourceTurnId);
        if (messageId === null) {
          return { state: "cancelled" as const, reason: "invalid turn-start work identity" };
        }

        const [thread, context] = yield* Effect.all([
          resolveThread(obligation.threadId),
          getPersistedTurnStartContext(obligation.threadId, messageId).pipe(
            Effect.map(Option.getOrUndefined),
          ),
        ]);
        if (!thread) {
          return { state: "cancelled" as const, reason: "turn-start context disappeared" };
        }
        if (!context || context.payload.messageId !== messageId) {
          // The boot backfill creates a startup-resume obligation from the
          // settled turn alone; its synthetic message and turn-start land a
          // moment later, when the resume coordinator dispatches them. Claiming
          // inside that window used to cancel the obligation outright — and the
          // projector then swallowed the incoming turn-start as a duplicate of
          // the row we had just killed (it only checks that a row exists, not
          // that it is still live). Both sides deferred to each other, the
          // resume never ran, and the thread sat dead until someone typed.
          // Retry instead; the attempt cap still terminates a context that
          // genuinely vanished.
          return yield* retryFailureWork(
            "turn-start context has not been projected yet",
            obligation.attempt,
          );
        }
        if (thread.settledOverride === "settled") {
          return { state: "cancelled" as const, reason: "thread was settled" };
        }

        const sourceMessage = thread.messages.find((message) => message.id === messageId);
        const recoveryVerdict = classifyTurnStartRecovery({
          sourceMessage,
          messageId,
          hasLaterRealUserTurn: context.hasLaterRealUserTurn,
        });
        if (recoveryVerdict === "superseded") {
          return { state: "cancelled" as const, reason: "turn-start was superseded" };
        }
        // `sourceMessage === undefined` is exactly the `awaiting-projection`
        // case; it is repeated here only so the compiler can narrow below.
        if (recoveryVerdict === "awaiting-projection" || sourceMessage === undefined) {
          return yield* retryFailureWork(
            "source message has not been projected yet",
            obligation.attempt,
          );
        }

        const provider = (yield* providerRegistry.getProviders).find(
          (candidate) => candidate.instanceId === obligation.providerInstanceId,
        );
        if (provider?.auth.status === "unauthenticated") {
          return {
            state: "blocked-authentication" as const,
            reason: "provider authentication required",
          };
        }

        const sessionsBeforeSend = yield* providerService.listSessions();
        const runningBeforeSend = sessionsBeforeSend.find(
          (session) =>
            session.threadId === obligation.threadId &&
            session.status === "running" &&
            session.activeTurnId !== undefined,
        );
        const sourceTurnAlreadyStarted = context.providerTurnId !== null;
        // Resumes are the case where an empty provider turn is indistinguishable
        // from success: nobody is watching the screen to notice that "resumed"
        // produced no words. A real user send does not need this — the person
        // who typed it can see that nothing came back and press enter again.
        const isResumeWork = obligation.kind === "startup-resume";
        if (runningBeforeSend?.activeTurnId !== undefined) {
          // Waiting to terminal is only a valid *outcome* for this obligation
          // when the running turn is our own message's turn (recovery found it
          // already live). For a queued delivery blocked behind someone else's
          // turn, adopting that turn's completion used to mark the delivery
          // "completed" without ever sending the message — a silent drop. Park
          // it as an uncapped progress-wait instead; normally the claim guard
          // keeps queued deliveries unclaimed while a supervisor row is active,
          // so this branch is a backstop for supervisor-less running turns.
          if (!sourceTurnAlreadyStarted) {
            // Supervise the blocking turn instead of blind-polling behind it.
            // A bare 15-second re-poll has no silence detection, so a provider
            // that wedges mid-turn parks this delivery forever: the loop below
            // is the only place the silence watchdog runs, and never entering it
            // means a hung upstream request is never noticed, never restarted,
            // and — because the scheduler admits one active obligation per
            // thread — every later send on the thread starves behind it.
            const blocking = yield* waitForProviderTurnTerminal({
              threadId: obligation.threadId,
              turnId: runningBeforeSend.activeTurnId,
              attempt: obligation.attempt,
            });
            // Never adopt the blocking turn's completion as our own — our
            // message still has not been sent. Re-attempt the delivery, but
            // propagate anything non-completed (auth block, watchdog restart)
            // unchanged so those signals are not swallowed.
            if (blocking.state !== "completed") return blocking;
            return yield* retryWorkAfter15Seconds(
              "waiting for the active turn to finish before delivering the queued message",
            );
          }
          return yield* waitForProviderTurnTerminal({
            threadId: obligation.threadId,
            turnId: runningBeforeSend.activeTurnId,
            attempt: obligation.attempt,
            requireTurnOutput: isResumeWork,
          });
        }

        // A resume whose provider turn "completed" while emitting nothing at
        // all did not resume anything — an upstream request that times out
        // ends the turn successfully with an empty body. Accepting that here
        // retires the obligation, and the one-resume-per-source-turn key then
        // blocks any further attempt, so the thread sits dead wearing a resume
        // badge it never earned. Fall through and re-nudge the provider
        // instead; `retryFailureWork`'s cap still stops this eventually.
        const completedTurnWasEmpty =
          isResumeWork &&
          context.providerTurnId !== null &&
          !providerTurnProducedOutput(thread, context.providerTurnId);
        if (context.providerTurnState === "completed" && !completedTurnWasEmpty) {
          return { state: "completed" as const };
        }

        yield* Effect.logDebug("thread-work.active-turn.dispatch", {
          obligationId: obligation.obligationId,
          threadId: obligation.threadId,
          recovery: sourceTurnAlreadyStarted,
        });

        const providerTurn = sourceTurnAlreadyStarted
          ? yield* buildSendTurnRequestForThread({
              threadId: obligation.threadId,
              messageId: MessageId.make(
                `active-turn-recovery-delivery:${obligation.threadId}:${messageId}`,
              ),
              // Browser providers type this nudge as a visible user message.
              // The autonomous-continue wall (AGENT_STOP contract) belongs to
              // Agent mode only; a Default-mode thread recovering a crashed
              // turn gets the plain resume sentence (observed live 2026-08-14:
              // a Default chat received the Agent prompt and kept looping).
              messageText:
                thread.interactionMode === "agent" ? AGENT_CONTINUE_PROMPT : RESUME_PROMPT,
              modelSelection: thread.modelSelection,
              interactionMode: providerInteractionMode(thread.interactionMode),
              createdAt: yield* nowIso,
            }).pipe(Effect.flatMap(providerService.sendTurn))
          : yield* sendProjectedUserTurn({
              thread,
              message: sourceMessage,
              context: context.payload,
            });

        const sessionsAfterSend = yield* providerService.listSessions();
        const liveAfterSend = sessionsAfterSend.find(
          (session) => session.threadId === obligation.threadId,
        );
        // Production adapters hold the session in running while the provider,
        // tools, subagents, or compaction are live. Lightweight test adapters
        // may only acknowledge dispatch; in that case the durable send is done.
        //
        // "connecting" is neither of those: the provider session is still coming
        // up (a real CLI spawn takes ~10s) and has not accepted the turn yet.
        // Retiring the obligation here as "completed" abandons the turn that is
        // about to start — it runs for the rest of its life with no supervisor
        // and no silence watchdog, so a hung upstream request just spins the UI
        // forever. Fall through to the supervised wait, which handles the
        // startup window and every terminal session status on its own.
        if (
          liveAfterSend === undefined ||
          (liveAfterSend.status !== "running" && liveAfterSend.status !== "connecting")
        ) {
          return { state: "completed" as const };
        }
        return yield* waitForProviderTurnTerminal({
          threadId: obligation.threadId,
          turnId: liveAfterSend.activeTurnId ?? providerTurn.turnId,
          attempt: obligation.attempt,
          requireTurnOutput: isResumeWork,
        });
      }).pipe(
        Effect.catchCause((cause) => {
          const messageId = activeTurnMessageIdFromSourceTurnId(obligation.sourceTurnId);
          if (messageId === null) return recoverThreadWorkFailure(cause, obligation.attempt);
          return getPersistedTurnStartContext(obligation.threadId, messageId).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.flatMap((context) =>
              context === undefined
                ? recoverThreadWorkFailure(cause, obligation.attempt)
                : recoverActiveTurnFailure({
                    context: context.payload,
                    cause,
                    attempt: obligation.attempt,
                  }),
            ),
            Effect.catchCause(() => recoverThreadWorkFailure(cause, obligation.attempt)),
          );
        }),
      );

    const executeStartupResume: ThreadWorkHandler = (obligation) =>
      Effect.gen(function* () {
        const { commandId, messageId } = startupAutoResumeIds({
          threadId: obligation.threadId,
          incompleteTurnId: obligation.sourceTurnId,
        });
        // The boot obligation used to be a pure supervisor: it waited for a
        // client to arrive and dispatch the resume turn with these ids, and
        // hard-cancelled after the retry cap (~2 minutes) when none did —
        // headless servers and closed laptops never resumed at all. Dispatch
        // the resume turn ourselves, exactly like executeAgentContinuation;
        // the stable command id keeps a racing client dispatch idempotent.
        const thread = yield* resolveThread(obligation.threadId);
        if (!thread) {
          return { state: "cancelled" as const, reason: "thread disappeared" };
        }
        if (thread.settledOverride === "settled") {
          return { state: "cancelled" as const, reason: "thread was settled" };
        }
        const syntheticMessage = thread.messages.find((message) => message.id === messageId);
        const context = yield* getPersistedTurnStartContext(obligation.threadId, messageId).pipe(
          Effect.map(Option.getOrUndefined),
        );
        if (syntheticMessage === undefined && context === undefined) {
          // Last line of defense against a self-inflicted resume: if the
          // thread's newest settled assistant message signed off with
          // AGENT_STOP and no real user message has landed since, the agent
          // deliberately ended its loop — a synthetic RESUME_PROMPT here is
          // the system contradicting the user-facing stop contract (observed
          // in production 2026-08-05). Only the not-yet-dispatched branch is
          // gated: once the resume turn exists we must keep supervising it.
          const newestAssistant = thread.messages
            .toReversed()
            .find((message) => message.role === "assistant" && !message.streaming);
          if (
            newestAssistant !== undefined &&
            emittedAgentStop(newestAssistant.text) &&
            !hasLaterRealUserMessage({
              thread,
              assistantMessageId: newestAssistant.id,
              syntheticMessageId: messageId,
            })
          ) {
            return { state: "cancelled" as const, reason: STARTUP_RESUME_SIGNED_OFF_REASON };
          }
          yield* orchestrationEngine.dispatch({
            type: "thread.turn.start",
            commandId,
            threadId: obligation.threadId,
            message: {
              messageId,
              role: "user",
              text: RESUME_PROMPT,
              attachments: [],
            },
            modelSelection: threadModelSelections.get(obligation.threadId) ?? thread.modelSelection,
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            createdAt: yield* nowIso,
          });
        }
        return yield* executeActiveTurnRecovery({
          ...obligation,
          sourceTurnId: activeTurnWorkSourceId(messageId),
        });
      }).pipe(Effect.catchCause((cause) => recoverThreadWorkFailure(cause, obligation.attempt)));

    const hasLaterRealUserMessage = (input: {
      readonly thread: OrchestrationThread;
      readonly assistantMessageId: MessageId;
      readonly syntheticMessageId?: MessageId;
    }): boolean => {
      const assistantIndex = input.thread.messages.findIndex(
        (message) => message.id === input.assistantMessageId,
      );
      if (assistantIndex < 0) return true;
      return input.thread.messages
        .slice(assistantIndex + 1)
        .some(
          (message) =>
            message.role === "user" &&
            (input.syntheticMessageId === undefined || message.id !== input.syntheticMessageId),
        );
    };

    const executeAgentContinuation: ThreadWorkHandler = (obligation) =>
      Effect.gen(function* () {
        if (projectionSnapshotQuery.getThreadTurnStartContext === undefined) {
          return { state: "cancelled" as const, reason: "source turn context unavailable" };
        }
        const { commandId, messageId } = agentAutoResumeIds({
          threadId: obligation.threadId,
          completedTurnId: obligation.sourceTurnId,
        });
        const recoveryMessageId = MessageId.make(
          `agent-continuation-recovery-delivery:${obligation.threadId}:${obligation.sourceTurnId}`,
        );
        const [thread, threadShell] = yield* Effect.all([
          resolveThread(obligation.threadId),
          projectionSnapshotQuery
            .getThreadShellById(obligation.threadId)
            .pipe(Effect.map(Option.getOrUndefined)),
        ]);
        if (!thread || !threadShell || thread.settledOverride === "settled") {
          return {
            state: "cancelled" as const,
            reason: "continuation thread disappeared or settled",
          };
        }
        if (thread.interactionMode !== "agent" || threadShell.interactionMode !== "agent") {
          return {
            state: "cancelled" as const,
            reason: "continuation thread is no longer in Agent mode",
          };
        }

        const assistant = thread.messages
          .toReversed()
          .find(
            (message) =>
              message.role === "assistant" &&
              message.turnId === obligation.sourceTurnId &&
              !message.streaming,
          );
        const assistantIndex = assistant
          ? thread.messages.findIndex((message) => message.id === assistant.id)
          : -1;
        const sourceUserMessage =
          assistantIndex < 0
            ? undefined
            : thread.messages
                .slice(0, assistantIndex)
                .toReversed()
                .find((message) => message.role === "user");
        const turnStartContext = sourceUserMessage
          ? yield* getPersistedTurnStartContext(obligation.threadId, sourceUserMessage.id).pipe(
              Effect.map(Option.getOrUndefined),
            )
          : undefined;
        const syntheticMessage = thread.messages.find((message) => message.id === messageId);
        if (
          !assistant ||
          !sourceUserMessage ||
          turnStartContext?.payload.interactionMode !== "agent" ||
          isProviderAuthenticationFailure(assistant.text) ||
          !shouldAgentContinueAfterReply(assistant.text) ||
          hasLaterRealUserMessage({
            thread,
            assistantMessageId: assistant.id,
            syntheticMessageId: messageId,
          })
        ) {
          return { state: "cancelled" as const, reason: "continuation was superseded" };
        }

        if (
          isControlOnlyAgentTurn({
            activities: thread.activities,
            sourceTurnId: obligation.sourceTurnId,
            sourceUserMessageText: sourceUserMessage?.text,
          })
        ) {
          return { state: "cancelled" as const, reason: "control-only turn" };
        }

        // The turn signed off while work it launched is still running. The
        // agent is waiting on that result on purpose, and the harness re-invokes
        // it when the task exits, so resuming now just wakes it early into the
        // same wait. Defer instead of dispatching; the grace window inside
        // `agentContinuationShouldAwaitBackgroundTask` keeps a provider that
        // never reports the task terminal from parking the thread forever.
        const awaitedTask = agentContinuationShouldAwaitBackgroundTask({
          activities: thread.activities,
          nowEpochMs: yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis)),
          processStartedAtEpochMs,
        });
        if (awaitedTask !== null) {
          yield* Effect.logDebug("agent-continuation.awaiting-background-task", {
            threadId: obligation.threadId,
            taskId: awaitedTask.taskId,
          });
          return yield* retryWorkAfter15Seconds(
            `waiting for background task ${awaitedTask.taskId} to finish before resuming`,
          );
        }

        // Two baseline agent-mode brakes (62099dc3b) that were lost when the
        // loop moved server-side: a consecutive-continuation budget and an
        // identical-reply stop. Without them the server loop has strictly
        // fewer runaway defenses than the client loop it replaced.
        const continuationsSinceUser = countContinuationsSinceUserIntent(thread.messages);
        if (continuationsSinceUser >= AGENT_LOOP_MAX_CONSECUTIVE_CONTINUATIONS) {
          return {
            state: "cancelled" as const,
            reason: "agent continuation budget exhausted without user input",
          };
        }
        const previousAssistant = thread.messages
          .slice(0, assistantIndex)
          .toReversed()
          .find((message) => message.role === "assistant" && !message.streaming);
        if (previousAssistant !== undefined && previousAssistant.text === assistant.text) {
          return {
            state: "cancelled" as const,
            reason: "assistant reply identical to the previous turn",
          };
        }

        if (syntheticMessage === undefined) {
          const latestTurn = threadShell.latestTurn;
          if (
            latestTurn?.turnId !== obligation.sourceTurnId ||
            latestTurn.state !== "completed" ||
            latestTurn.assistantMessageId !== assistant.id ||
            threadShell.interactionMode !== "agent" ||
            threadShell.hasPendingApprovals ||
            threadShell.hasPendingUserInput ||
            !shouldAutoContinueCompletedAgentTurn(threadShell, {
              turnId: obligation.sourceTurnId,
              assistantText: assistant.text,
              turnInteractionMode: turnStartContext.payload.interactionMode,
            })
          ) {
            return { state: "cancelled" as const, reason: "source turn is no longer continuable" };
          }
        } else if (
          syntheticMessage.role !== "user" ||
          syntheticMessage.inputOrigin !== "agent-loop"
        ) {
          return { state: "cancelled" as const, reason: "continuation identity was reused" };
        }

        const provider = (yield* providerRegistry.getProviders).find(
          (candidate) => candidate.instanceId === obligation.providerInstanceId,
        );
        if (provider?.auth?.status === "unauthenticated") {
          return {
            state: "blocked-authentication" as const,
            reason: "provider authentication required",
          };
        }

        if (syntheticMessage === undefined) {
          yield* orchestrationEngine.dispatch({
            type: "thread.turn.start",
            commandId,
            threadId: obligation.threadId,
            message: {
              messageId,
              role: "user",
              text: AGENT_CONTINUE_PROMPT,
              inputOrigin: "agent-loop",
              attachments: [],
            },
            modelSelection: threadModelSelections.get(obligation.threadId) ?? thread.modelSelection,
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            createdAt: yield* nowIso,
          });
        }

        const [refreshed, refreshedShell] = yield* Effect.all([
          resolveThread(obligation.threadId),
          projectionSnapshotQuery
            .getThreadShellById(obligation.threadId)
            .pipe(Effect.map(Option.getOrUndefined)),
        ]);
        if (!refreshed || !refreshedShell) {
          return { state: "cancelled" as const, reason: "thread disappeared" };
        }
        if (refreshed.interactionMode !== "agent" || refreshedShell.interactionMode !== "agent") {
          return {
            state: "cancelled" as const,
            reason: "continuation thread is no longer in Agent mode",
          };
        }
        const deliveryAlreadyRecorded = messageDeliveryRecorded(refreshed, messageId);
        if (
          hasLaterRealUserMessage({
            thread: refreshed,
            assistantMessageId: assistant.id,
            syntheticMessageId: messageId,
          })
        ) {
          return { state: "cancelled" as const, reason: "user message won the continuation race" };
        }

        const [syntheticTurnContext, recoveryTurn] = yield* Effect.all([
          getPersistedTurnStartContext(obligation.threadId, messageId).pipe(
            Effect.map(Option.getOrUndefined),
          ),
          getPersistedProviderTurnForMessage(obligation.threadId, recoveryMessageId).pipe(
            Effect.map(Option.getOrUndefined),
          ),
        ]);
        if (!syntheticTurnContext) {
          return yield* retryWorkAfter15Seconds(
            "projected continuation context is not visible yet",
          );
        }
        if (syntheticTurnContext.hasLaterRealUserTurn) {
          return { state: "cancelled" as const, reason: "user message won the continuation race" };
        }

        const persistedWorkTurn =
          recoveryTurn ??
          (syntheticTurnContext.providerTurnId === null ||
          syntheticTurnContext.providerTurnState === null
            ? undefined
            : {
                turnId: syntheticTurnContext.providerTurnId,
                state: syntheticTurnContext.providerTurnState,
              });
        if (persistedWorkTurn?.state === "completed") {
          return { state: "completed" as const };
        }
        if (persistedWorkTurn?.state === "interrupted") {
          return { state: "cancelled" as const, reason: "continuation turn was interrupted" };
        }

        const sessions = yield* providerService.listSessions();
        const active = sessions.find((session) => session.threadId === obligation.threadId);
        if (active?.status === "running" && active.activeTurnId !== undefined) {
          return yield* waitForProviderTurnTerminal({
            threadId: obligation.threadId,
            turnId: active.activeTurnId,
            attempt: obligation.attempt,
          });
        }

        const deliveryMessageId =
          persistedWorkTurn === undefined && !deliveryAlreadyRecorded
            ? messageId
            : recoveryMessageId;
        const selectedDeliveryAlreadyRecorded = messageDeliveryRecorded(
          refreshed,
          deliveryMessageId,
        );
        let dispatchedTurnId: TurnId | undefined;
        if (!selectedDeliveryAlreadyRecorded || deliveryMessageId === recoveryMessageId) {
          const [deliveryThread, deliveryShell] = yield* Effect.all([
            resolveThread(obligation.threadId),
            projectionSnapshotQuery
              .getThreadShellById(obligation.threadId)
              .pipe(Effect.map(Option.getOrUndefined)),
          ]);
          if (
            !deliveryThread ||
            !deliveryShell ||
            deliveryThread.interactionMode !== "agent" ||
            deliveryShell.interactionMode !== "agent"
          ) {
            return {
              state: "cancelled" as const,
              reason: "continuation thread is no longer in Agent mode",
            };
          }
          const request = yield* buildSendTurnRequestForThread({
            threadId: obligation.threadId,
            messageId: deliveryMessageId,
            messageText: AGENT_CONTINUE_PROMPT,
            modelSelection:
              threadModelSelections.get(obligation.threadId) ?? deliveryThread.modelSelection,
            interactionMode: providerInteractionMode(deliveryThread.interactionMode),
            createdAt: yield* nowIso,
          });
          const [dispatchThread, dispatchShell] = yield* Effect.all([
            resolveThread(obligation.threadId),
            projectionSnapshotQuery
              .getThreadShellById(obligation.threadId)
              .pipe(Effect.map(Option.getOrUndefined)),
          ]);
          if (
            !dispatchThread ||
            !dispatchShell ||
            dispatchThread.interactionMode !== "agent" ||
            dispatchShell.interactionMode !== "agent"
          ) {
            return {
              state: "cancelled" as const,
              reason: "continuation thread is no longer in Agent mode",
            };
          }
          dispatchedTurnId = (yield* providerService.sendTurn(request)).turnId;
        }
        if (!selectedDeliveryAlreadyRecorded) {
          yield* waitForClaudeMessageDelivery({
            threadId: obligation.threadId,
            messageId: deliveryMessageId,
            providerInstanceId: obligation.providerInstanceId,
          });
        }
        const sessionsAfterDelivery = yield* providerService.listSessions();
        const liveAfterDelivery = sessionsAfterDelivery.find(
          (session) => session.threadId === obligation.threadId,
        );
        // A delivery receipt means the provider pulled the message; it does not
        // mean the provider turn, tool, subagent, or compaction work finished.
        if (liveAfterDelivery?.status !== "running") {
          return dispatchedTurnId === undefined
            ? yield* retryWorkAfter15Seconds("provider continuation is not running")
            : { state: "completed" as const };
        }
        const activeTurnId = liveAfterDelivery.activeTurnId ?? dispatchedTurnId;
        if (activeTurnId === undefined) {
          return yield* retryWorkAfter15Seconds("running provider session has no active turn id");
        }
        return yield* waitForProviderTurnTerminal({
          threadId: obligation.threadId,
          turnId: activeTurnId,
          attempt: obligation.attempt,
        });
      }).pipe(Effect.catchCause((cause) => recoverThreadWorkFailure(cause, obligation.attempt)));

    const executeAuthenticationResume: ThreadWorkHandler = (obligation) =>
      Effect.gen(function* () {
        const deliveryMessageId = MessageId.make(
          `provider-auth-resume-delivery:${obligation.threadId}:${obligation.sourceTurnId}`,
        );
        const [thread, threadShell] = yield* Effect.all([
          resolveThread(obligation.threadId),
          projectionSnapshotQuery
            .getThreadShellById(obligation.threadId)
            .pipe(Effect.map(Option.getOrUndefined)),
        ]);
        if (!thread || !threadShell || thread.settledOverride === "settled") {
          return { state: "cancelled" as const, reason: "authentication pause was superseded" };
        }
        const assistant = thread.messages
          .toReversed()
          .find(
            (message) =>
              message.role === "assistant" &&
              message.turnId === obligation.sourceTurnId &&
              !message.streaming,
          );
        if (
          !assistant ||
          !isProviderAuthenticationFailure(assistant.text) ||
          hasLaterRealUserMessage({ thread, assistantMessageId: assistant.id })
        ) {
          return { state: "cancelled" as const, reason: "authentication pause is stale" };
        }

        const deliveryTurn = yield* getPersistedProviderTurnForMessage(
          obligation.threadId,
          deliveryMessageId,
        ).pipe(Effect.map(Option.getOrUndefined));
        if (deliveryTurn === undefined) {
          const latestTurn = threadShell.latestTurn;
          if (
            latestTurn?.turnId !== obligation.sourceTurnId ||
            (latestTurn.state !== "completed" &&
              latestTurn.state !== "incomplete" &&
              latestTurn.state !== "error") ||
            latestTurn.assistantMessageId !== assistant.id ||
            threadShell.hasPendingApprovals ||
            threadShell.hasPendingUserInput
          ) {
            return { state: "cancelled" as const, reason: "authentication pause was superseded" };
          }
        } else if (deliveryTurn.state === "completed") {
          return { state: "completed" as const };
        } else if (deliveryTurn.state === "interrupted") {
          return { state: "cancelled" as const, reason: "authentication resume was interrupted" };
        }

        const provider = (yield* providerRegistry.getProviders).find(
          (candidate) => candidate.instanceId === obligation.providerInstanceId,
        );
        if (provider?.status !== "ready" || provider.auth?.status !== "authenticated") {
          return {
            state: "blocked-authentication" as const,
            reason: "provider authentication required",
          };
        }
        const deliveryAlreadyRecorded = messageDeliveryRecorded(thread, deliveryMessageId);
        const sessions = yield* providerService.listSessions();
        const active = sessions.find((session) => session.threadId === obligation.threadId);
        if (active?.status === "running" && active.activeTurnId !== undefined) {
          return yield* waitForProviderTurnTerminal({
            threadId: obligation.threadId,
            turnId: active.activeTurnId,
            attempt: obligation.attempt,
          });
        }
        let dispatchedTurnId: TurnId | undefined;
        if (!deliveryAlreadyRecorded || deliveryTurn !== undefined) {
          const createdAt = yield* nowIso;
          const request = yield* buildSendTurnRequestForThread({
            threadId: obligation.threadId,
            messageId: deliveryMessageId,
            // Same contract as active-turn recovery: the autonomous-continue
            // wall is Agent-mode-only; Default threads resume with the plain
            // resume sentence.
            messageText: thread.interactionMode === "agent" ? AGENT_CONTINUE_PROMPT : RESUME_PROMPT,
            modelSelection: thread.modelSelection,
            interactionMode: providerInteractionMode(thread.interactionMode),
            createdAt,
          });
          dispatchedTurnId = (yield* providerService.sendTurn(request)).turnId;
        }
        if (!deliveryAlreadyRecorded) {
          yield* waitForClaudeMessageDelivery({
            threadId: obligation.threadId,
            messageId: deliveryMessageId,
            providerInstanceId: obligation.providerInstanceId,
          });
        }
        const sessionsAfterDelivery = yield* providerService.listSessions();
        const liveAfterDelivery = sessionsAfterDelivery.find(
          (session) => session.threadId === obligation.threadId,
        );
        if (liveAfterDelivery?.status !== "running") {
          return dispatchedTurnId === undefined
            ? yield* retryWorkAfter15Seconds("provider authentication resume is not running")
            : { state: "completed" as const };
        }
        const activeTurnId = liveAfterDelivery.activeTurnId ?? dispatchedTurnId;
        if (activeTurnId === undefined) {
          return yield* retryWorkAfter15Seconds("running provider session has no active turn id");
        }
        return yield* waitForProviderTurnTerminal({
          threadId: obligation.threadId,
          turnId: activeTurnId,
          attempt: obligation.attempt,
        });
      }).pipe(Effect.catchCause((cause) => recoverThreadWorkFailure(cause, obligation.attempt)));

    const processAssistantMessageSent = Effect.fn("processAssistantMessageSent")(function* (
      event: AssistantMessageSentEvent,
    ) {
      if (
        event.payload.role !== "assistant" ||
        event.payload.turnId === null ||
        event.payload.streaming
      ) {
        return;
      }

      const thread = yield* projectionSnapshotQuery
        .getThreadShellById(event.payload.threadId)
        .pipe(Effect.map(Option.getOrUndefined));
      if (!thread) return;
      const projectedAssistant =
        projectionSnapshotQuery.getThreadAssetSource === undefined
          ? null
          : yield* projectionSnapshotQuery.getThreadAssetSource(event.payload.threadId, {
              messageId: event.payload.messageId,
            });
      const assistantText = projectedAssistant?.message?.text ?? event.payload.text;
      if (isProviderAuthenticationFailure(assistantText)) {
        yield* pauseThreadForProviderAuthenticationFailure({
          thread,
          detail: assistantText,
          createdAt: event.payload.updatedAt,
        });
        return;
      }
      yield* threadWorkScheduler.wake(
        thread.session?.providerInstanceId ?? thread.modelSelection.instanceId,
      );
    });

    const processThreadSessionSet = Effect.fn("processThreadSessionSet")(function* (
      event: Extract<ProviderIntentEvent, { type: "thread.session-set" }>,
    ) {
      if (event.payload.session.status !== "ready") {
        if (
          event.payload.session.status === "error" ||
          event.payload.session.status === "stopped"
        ) {
          providerSessionModelSelections.delete(event.payload.threadId);
        }
        return;
      }
      const thread = yield* projectionSnapshotQuery
        .getThreadShellById(event.payload.threadId)
        .pipe(Effect.map(Option.getOrUndefined));
      const turnId = thread?.latestTurn?.turnId;
      if (!thread || !turnId) return;
      const latestAssistantMessageId = thread.latestTurn?.assistantMessageId;
      const latestMessageSource =
        latestAssistantMessageId !== null &&
        latestAssistantMessageId !== undefined &&
        projectionSnapshotQuery.getThreadAssetSource
          ? yield* projectionSnapshotQuery.getThreadAssetSource(thread.id, {
              messageId: latestAssistantMessageId,
            })
          : null;
      const latestAssistantMessage = latestMessageSource?.message;
      if (
        latestAssistantMessage !== undefined &&
        latestAssistantMessage !== null &&
        (latestAssistantMessage.role !== "assistant" ||
          latestAssistantMessage.streaming ||
          latestAssistantMessage.turnId !== turnId)
      ) {
        return;
      }
      if (
        latestAssistantMessage?.role === "assistant" &&
        isProviderAuthenticationFailure(latestAssistantMessage.text)
      ) {
        yield* pauseThreadForProviderAuthenticationFailure({
          thread,
          detail: latestAssistantMessage.text,
          createdAt: latestAssistantMessage.updatedAt,
        });
        return;
      }
      yield* threadWorkScheduler.wake(
        event.payload.session.providerInstanceId ?? thread.modelSelection.instanceId,
      );
    });

    const reconcileProviderAuthenticationPauses = Effect.fn(
      "reconcileProviderAuthenticationPauses",
    )(function* (providers: ReadonlyArray<ServerProvider>) {
      for (const provider of providers) {
        if (provider.status !== "ready" || provider.auth?.status !== "authenticated") continue;
        let afterUpdatedAt: string | null = null;
        let afterObligationId: string | null = null;
        let transitioned = 0;
        while (true) {
          const page: ReadonlyArray<ThreadWorkObligation> =
            yield* threadWorkObligations.listByState({
              providerInstanceId: provider.instanceId,
              state: "blocked-authentication",
              afterUpdatedAt,
              afterObligationId,
              limit: 128,
            });
          if (page.length === 0) break;
          for (const obligation of page) {
            if (
              yield* threadWorkObligations.transition({
                obligationId: obligation.obligationId,
                expectedState: "blocked-authentication",
                expectedAttempt: obligation.attempt,
                state: "pending",
                nextAttemptAt: null,
                claimedAt: null,
                leaseExpiresAt: null,
                blockedReason: null,
                updatedAt: provider.checkedAt,
              })
            ) {
              transitioned += 1;
            }
          }
          const last: ThreadWorkObligation = page.at(-1)!;
          afterUpdatedAt = last.updatedAt;
          afterObligationId = last.obligationId;
          if (page.length < 128) break;
        }
        if (transitioned > 0) yield* threadWorkScheduler.wake(provider.instanceId);
      }
    });

    const reconcileProviderAuthenticationPausesSafely = (
      providers: ReadonlyArray<ServerProvider>,
    ) =>
      reconcileProviderAuthenticationPauses(providers).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider authentication recovery sweep failed", {
            cause: Cause.pretty(cause),
          }),
        ),
      );

    const processDomainEvent = Effect.fn("processDomainEvent")(function* (
      event: ProviderIntentEvent,
    ) {
      yield* Effect.annotateCurrentSpan({
        "orchestration.event_type": event.type,
        "orchestration.thread_id": event.payload.threadId,
        ...(event.commandId ? { "orchestration.command_id": event.commandId } : {}),
      });
      yield* increment(orchestrationEventsProcessedTotal, {
        eventType: event.type,
      });
      switch (event.type) {
        case "thread.message-sent":
          yield* processAssistantMessageSent(event);
          if (
            event.payload.role === "assistant" &&
            !event.payload.streaming &&
            isProviderAuthenticationFailure(event.payload.text)
          ) {
            // The projection pipeline records an authentication-resume
            // obligation before publishing this event. Wake the durable worker
            // immediately instead of making it wait for the fallback poll.
            yield* threadWorkScheduler.wake();
          }
          return;
        case "thread.session-set":
          yield* processThreadSessionSet(event);
          if (
            event.payload.session.status === "ready" &&
            event.payload.session.activeTurnId === null
          ) {
            // A ready session is the authoritative end of a provider turn. The
            // projection pipeline may have just created an Agent continuation
            // obligation, so notify the scheduler as part of the same event.
            yield* threadWorkScheduler.wake(event.payload.session.providerInstanceId);
          }
          return;
        case "thread.forked":
          yield* processThreadForked(event);
          return;
        case "thread.meta-updated":
          if (event.payload.modelSelection !== undefined) {
            threadModelSelections.set(event.payload.threadId, event.payload.modelSelection);
          }
          return;
        case "thread.runtime-mode-set": {
          const thread = yield* resolveThread(event.payload.threadId);
          if (!thread?.session || thread.session.status === "stopped") {
            return;
          }
          const cachedModelSelection = threadModelSelections.get(event.payload.threadId);
          yield* ensureSessionForThread(
            event.payload.threadId,
            event.occurredAt,
            cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {},
          );
          return;
        }
        case "thread.turn-start-requested":
          yield* processTurnStartRequested(event);
          return;
        case "thread.turn-interrupt-requested":
          yield* processTurnInterruptRequested(event);
          return;
        case "thread.queued-turn-promote-requested":
          yield* processQueuedTurnPromoteRequested(event);
          return;
        case "thread.task-stop-requested":
          yield* processTaskStopRequested(event);
          return;
        case "thread.approval-response-requested":
          yield* processApprovalResponseRequested(event);
          return;
        case "thread.user-input-response-requested":
          yield* processUserInputResponseRequested(event);
          return;
        case "thread.session-stop-requested":
          yield* processSessionStopRequested(event);
          return;
        case "thread.plan-refresh-requested":
          yield* processPlanRefreshRequested(event);
          return;
      }
    });

    const processDomainEventSafely = (event: ProviderIntentEvent) =>
      processDomainEvent(event).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning("provider command reactor failed to process event", {
            eventType: event.type,
            cause: Cause.pretty(cause),
          });
        }),
      );

    const worker = yield* makeDrainableWorker(processDomainEventSafely);
    // Cancellation is a control plane. It must not sit behind ordinary work,
    // and one provider/thread that ignores Stop must not block every other
    // thread's interrupt. A small serial lane per thread preserves local event
    // order while allowing independent threads to cancel concurrently.
    const controlWorkers = new Map<string, DrainableWorker<ProviderIntentEvent>>();
    const controlWorkerForThread = Effect.fn("controlWorkerForThread")(function* (
      threadId: ThreadId,
    ) {
      const key = String(threadId);
      const existing = controlWorkers.get(key);
      if (existing) return existing;
      const created = yield* makeDrainableWorker(processDomainEventSafely);
      controlWorkers.set(key, created);
      return created;
    });
    const controlDispatcher = yield* makeDrainableWorker(
      Effect.fn("dispatchControlEvent")(function* (event: ProviderIntentEvent) {
        const controlWorker = yield* controlWorkerForThread(event.payload.threadId);
        yield* controlWorker.enqueue(event);
      }),
    );

    const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
      yield* threadWorkScheduler.registerHandler("active-turn-recovery", executeActiveTurnRecovery);
      yield* threadWorkScheduler.registerHandler("startup-resume", executeStartupResume);
      yield* threadWorkScheduler.registerHandler("agent-continuation", executeAgentContinuation);
      yield* threadWorkScheduler.registerHandler(
        "authentication-resume",
        executeAuthenticationResume,
      );
      yield* Effect.addFinalizer(() =>
        Effect.all([
          threadWorkScheduler.unregisterHandler("active-turn-recovery"),
          threadWorkScheduler.unregisterHandler("startup-resume"),
          threadWorkScheduler.unregisterHandler("agent-continuation"),
          threadWorkScheduler.unregisterHandler("authentication-resume"),
        ]).pipe(Effect.asVoid),
      );

      const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
        if (
          event.type === "thread.turn-interrupt-requested" ||
          event.type === "thread.queued-turn-promote-requested" ||
          event.type === "thread.session-stop-requested"
        ) {
          return yield* controlDispatcher.enqueue(event);
        }
        if (
          event.type === "thread.runtime-mode-set" ||
          event.type === "thread.meta-updated" ||
          event.type === "thread.forked" ||
          event.type === "thread.message-sent" ||
          event.type === "thread.session-set" ||
          event.type === "thread.turn-start-requested" ||
          event.type === "thread.task-stop-requested" ||
          event.type === "thread.approval-response-requested" ||
          event.type === "thread.user-input-response-requested" ||
          event.type === "thread.plan-refresh-requested"
        ) {
          return yield* worker.enqueue(event);
        }
      });

      yield* Effect.forkScoped(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, processEvent),
      );
      const providerChanges = yield* providerRegistry.subscribeChanges;
      yield* Effect.forkScoped(
        Stream.runForEach(providerChanges, (providers) =>
          reconcileProviderAuthenticationPausesSafely(providers),
        ),
      );
      yield* providerRegistry.getProviders.pipe(
        Effect.flatMap(reconcileProviderAuthenticationPausesSafely),
      );
      yield* threadWorkScheduler.start();
      yield* threadWorkScheduler.wake();
    });

    return {
      start,
      drain: Effect.gen(function* () {
        yield* Effect.all([worker.drain, controlDispatcher.drain], {
          concurrency: "unbounded",
        });
        yield* Effect.forEach(
          Array.from(controlWorkers.values()),
          (controlWorker) => controlWorker.drain,
          { concurrency: "unbounded", discard: true },
        );
      }),
    } satisfies ProviderCommandReactorShape;
  });

export const makeProviderCommandReactorLive = (options?: ProviderCommandReactorLiveOptions) =>
  Layer.effect(ProviderCommandReactor, make(options));

export const ProviderCommandReactorLive = makeProviderCommandReactorLive();

/**
 * Collapses the client-only "agent" mode onto the provider-visible set. Agent
 * mode changes how the app drives turns, not how the provider behaves.
 */
function providerInteractionMode(mode: ProviderInteractionMode): "default" | "plan" {
  return mode === "plan" ? "plan" : "default";
}
