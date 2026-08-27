import {
  ApprovalRequestId,
  MessageId,
  type GrokSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  RuntimeTaskId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { mapKnownProviderFailure } from "../providerFailureMessage.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpReasoningItemEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { applyAcpRequestedSessionMode } from "../acp/AcpSessionModes.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  applyGrokAcpModelSelection,
  currentGrokModelIdFromSessionSetup,
  makeGrokAcpRuntime,
  resolveGrokAcpBaseModelId,
} from "../acp/GrokAcpSupport.ts";
import {
  GROK_BACKGROUND_TASK_NOTIFICATION_METHODS,
  GROK_TASK_KILL_METHODS,
  grokTaskKillPayload,
  parseGrokBackgroundTaskNotification,
} from "../acp/GrokBackgroundTasks.ts";
import {
  GROK_BILLING_METHOD,
  GROK_SESSION_INFO_METHOD,
  grokTokenUsageFromSessionInfo,
  grokTokenUsageFromUsageUpdate,
} from "../acp/GrokUsage.ts";
import {
  extractXAiAskUserQuestions,
  makeXAiAskUserQuestionCancelledResponse,
  makeXAiAskUserQuestionResponse,
  promptResponseHasMissingXAiStopReason,
  XAiAskUserQuestionRequest,
  XAiQueueChangedNotification,
  xAiQueueInterjectPayloads,
} from "../acp/XAiAcpExtension.ts";
import {
  extractCompletedProposedPlans,
  grokCollaborationPromptBlock,
  resolveGrokPermissionAction,
} from "../GrokCollaboration.ts";
import { type GrokAdapterShape } from "../Services/GrokAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.UnknownFromJsonString);

const PROVIDER = ProviderDriverKind.make("grok");
const GROK_RESUME_VERSION = 1 as const;

/**
 * Once ACP accepts a prompt, local state reconciliation must not turn that
 * delivery into a retry. Interruptions still propagate so shutdown and an
 * explicit stop retain their cancellation semantics.
 */
export function preserveAcceptedGrokTurn<A, E, R>(
  finalization: Effect.Effect<A, E, R>,
  fallback: A,
  diagnostics: { readonly threadId: ThreadId; readonly turnId: TurnId },
): Effect.Effect<A, E, R> {
  return finalization.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("grok.sendTurn.finalization-failed-after-acceptance", {
            ...diagnostics,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(fallback)),
    ),
  );
}

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export interface GrokAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

type PendingUserInputResolution =
  | { readonly _tag: "answered"; readonly answers: ProviderUserInputAnswers }
  | { readonly _tag: "cancelled" };

interface PendingUserInput {
  readonly resolution: Deferred.Deferred<PendingUserInputResolution>;
}

interface GrokSessionContext {
  readonly threadId: ThreadId;
  readonly acpSessionId: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  /** Turns already interrupted; late prompt RPCs must not resurrect them. */
  interruptedTurnIds: Set<TurnId>;
  /** Number of sendTurn prompts currently in flight or being prepared.
   * >0 means a turn is actively running, so a new sendTurn is a steer that
   * continues it, and only the last remaining prompt settles the turn. */
  promptsInFlight: number;
  /** Messages admitted to Grok's native queue but not yet receipted to T3. */
  pendingMessageDeliveries: Map<string, TurnId>;
  /** Latest native queue versions, used by Grok's compare-and-promote operation. */
  queuedPromptVersions: Map<string, number>;
  /** Completes whenever Grok publishes a fresh native queue snapshot. */
  queueChangedSignal: Deferred.Deferred<void>;
  currentModelId: string | undefined;
  /** Last reasoning effort applied via session/set_model metadata. */
  currentEffort: string | undefined;
  interactionMode: ProviderInteractionMode | undefined;
  assistantTextByTurn: string;
  /** One "Thinking" activity per turn — Grok can emit thousands of thought chunks. */
  reasoningAnnounced: boolean;
  capturedProposedPlanKeys: Set<string>;
  sessionSetupResult: AcpSessionRuntime.AcpSessionRuntimeStartResult["sessionSetupResult"];
  stopped: boolean;
  stopCompletion: Deferred.Deferred<void> | undefined;
  /** Dedupes task.started/task.completed if Grok emits both session/update and dedicated methods. */
  seenBackgroundTaskKeys: Set<string>;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function settlePendingUserInputsAsCancelled(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingUserInputs.values()),
    (pending) => Deferred.succeed(pending.resolution, { _tag: "cancelled" }).pipe(Effect.ignore),
    { discard: true },
  );
}

function appendPromptResultToTurn(
  ctx: GrokSessionContext,
  turnId: TurnId,
  promptParts: ReadonlyArray<EffectAcpSchema.ContentBlock>,
  result: EffectAcpSchema.PromptResponse,
): void {
  const existingTurnRecord = ctx.turns.find((turn) => turn.id === turnId);
  ctx.turns = existingTurnRecord
    ? ctx.turns.map((turn) =>
        turn.id === turnId
          ? { ...turn, items: [...turn.items, { prompt: promptParts, result }] }
          : turn,
      )
    : [...ctx.turns, { id: turnId, items: [{ prompt: promptParts, result }] }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const resolveNotificationTurnId = (ctx: GrokSessionContext): TurnId | undefined => ctx.activeTurnId;

const resolveCallbackTurnId = (ctx: GrokSessionContext): TurnId | undefined => ctx.activeTurnId;

const resolveSessionCallbackTurnId = (
  sessions: ReadonlyMap<ThreadId, GrokSessionContext>,
  threadId: ThreadId,
): TurnId | undefined => {
  const ctx = sessions.get(threadId);
  return ctx ? resolveCallbackTurnId(ctx) : undefined;
};

function parseGrokResume(raw: unknown): { sessionId: string; fork: boolean } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== GROK_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim(), fork: raw.fork === true };
}

function selectPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const kind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  const option = request.options.find((entry) => entry.kind === kind);
  return option?.optionId.trim() || undefined;
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    selectPermissionOptionId(request, "acceptForSession") ??
    selectPermissionOptionId(request, "accept")
  );
}

function completedStopReasonFromPromptResponse(
  response: EffectAcpSchema.PromptResponse | undefined,
): EffectAcpSchema.StopReason | null {
  if (response === undefined || promptResponseHasMissingXAiStopReason(response)) {
    return null;
  }
  return response.stopReason;
}

export function grokPromptSettlementBelongsToContext(input: {
  readonly liveAcpSessionId: string;
  readonly expectedAcpSessionId: string;
  readonly liveActiveTurnId: TurnId | undefined;
  readonly liveSessionActiveTurnId: TurnId | undefined;
  readonly turnId: TurnId;
}): boolean {
  return (
    input.liveAcpSessionId === input.expectedAcpSessionId &&
    (input.liveActiveTurnId === input.turnId || input.liveSessionActiveTurnId === input.turnId)
  );
}

export function makeGrokAdapter(grokSettings: GrokSettings, options?: GrokAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("grok");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, GrokSessionContext>();
    // Session teardown must outlive an interrupted Stop caller. This dedicated
    // scope stays open until the adapter finalizer has awaited stopAll.
    const sessionTeardownScope = yield* Scope.make("sequential");
    yield* Effect.addFinalizer(() => Scope.close(sessionTeardownScope, Exit.void));
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Grok runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const mapAcpCallbackFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "Failed to process Grok ACP callback.",
              cause,
            }),
        ),
      );

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const requestGrokExt = (
      acp: AcpSessionRuntime.AcpSessionRuntime["Service"],
      method: string,
      payload: unknown = {},
    ) =>
      acp.request(method, payload).pipe(
        Effect.option,
        Effect.map((result) => (Option.isSome(result) ? result.value : undefined)),
      );

    const emitGrokAccountUsage = (
      acp: AcpSessionRuntime.AcpSessionRuntime["Service"],
      threadId: ThreadId,
      turnId?: TurnId,
    ) =>
      Effect.gen(function* () {
        const billing = yield* requestGrokExt(acp, GROK_BILLING_METHOD);
        if (billing === undefined) return;
        yield* offerRuntimeEvent({
          type: "account.rate-limits.updated",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId,
          ...(turnId !== undefined ? { turnId } : {}),
          ...(boundInstanceId ? { providerInstanceId: boundInstanceId } : {}),
          payload: { rateLimits: billing },
        });
      }).pipe(Effect.ignore);

    const emitGrokTokenUsage = (
      acp: AcpSessionRuntime.AcpSessionRuntime["Service"],
      threadId: ThreadId,
      acpSessionId: string,
      turnId?: TurnId,
    ) =>
      Effect.gen(function* () {
        const sessionInfo = yield* requestGrokExt(acp, GROK_SESSION_INFO_METHOD, {
          sessionId: acpSessionId,
        });
        const usage = grokTokenUsageFromSessionInfo(sessionInfo);
        if (!usage) return;
        yield* offerRuntimeEvent({
          type: "thread.token-usage.updated",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId,
          ...(turnId !== undefined ? { turnId } : {}),
          ...(boundInstanceId ? { providerInstanceId: boundInstanceId } : {}),
          payload: { usage },
        });
      }).pipe(Effect.ignore);

    const emitGrokBackgroundTaskFromNotification = (
      ctx: GrokSessionContext,
      method: string,
      params: unknown,
    ) =>
      Effect.gen(function* () {
        const parsed = parseGrokBackgroundTaskNotification(params, method);
        if (!parsed) return;
        const seenKey = `${parsed.kind}:${parsed.taskId}`;
        if (ctx.seenBackgroundTaskKeys.has(seenKey)) return;
        ctx.seenBackgroundTaskKeys.add(seenKey);
        const stamp = yield* makeEventStamp();
        const turnId = resolveNotificationTurnId(ctx);
        if (parsed.kind === "started") {
          yield* offerRuntimeEvent({
            type: "task.started",
            ...stamp,
            provider: PROVIDER,
            threadId: ctx.threadId,
            ...(turnId !== undefined ? { turnId } : {}),
            ...(boundInstanceId ? { providerInstanceId: boundInstanceId } : {}),
            payload: {
              taskId: RuntimeTaskId.make(parsed.taskId),
              ...(parsed.description ? { description: parsed.description } : {}),
              taskType: parsed.taskType,
            },
            raw: {
              source: "acp.grok.extension",
              method,
              payload: params,
            },
          });
          return;
        }
        yield* offerRuntimeEvent({
          type: "task.completed",
          ...stamp,
          provider: PROVIDER,
          threadId: ctx.threadId,
          ...(turnId !== undefined ? { turnId } : {}),
          ...(boundInstanceId ? { providerInstanceId: boundInstanceId } : {}),
          payload: {
            taskId: RuntimeTaskId.make(parsed.taskId),
            status: parsed.status,
            ...(parsed.summary ? { summary: parsed.summary } : {}),
          },
          raw: {
            source: "acp.grok.extension",
            method,
            payload: params,
          },
        });
      });

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const settlePromptInFlight = (
      threadId: ThreadId,
      turnId: TurnId,
      expectedAcpSessionId: string,
      options?: {
        readonly errorMessage?: string;
        readonly completedStopReason?: EffectAcpSchema.StopReason | null;
        readonly emitTurnCompletion?: boolean;
        /** Interrupt/cancel: drop every outstanding prompt slot and settle once. */
        readonly settleAllPrompts?: boolean;
      },
    ) =>
      Effect.gen(function* () {
        const liveCtx = sessions.get(threadId);
        if (!liveCtx) {
          return;
        }
        const settlementBelongsToLiveContext = grokPromptSettlementBelongsToContext({
          liveAcpSessionId: liveCtx.acpSessionId,
          expectedAcpSessionId,
          liveActiveTurnId: liveCtx.activeTurnId,
          liveSessionActiveTurnId: liveCtx.session.activeTurnId,
          turnId,
        });
        if (!settlementBelongsToLiveContext) {
          // interruptTurn already consumed every prompt slot for this turn. A
          // late prompt result must neither emit a second terminal event nor
          // consume a slot belonging to a newer turn on the same ACP session.
          if (
            liveCtx.acpSessionId !== expectedAcpSessionId ||
            liveCtx.interruptedTurnIds.has(turnId)
          ) {
            return;
          }
          if (options?.emitTurnCompletion !== false) {
            if (options?.errorMessage !== undefined) {
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId,
                turnId,
                payload: {
                  state: "failed",
                  errorMessage: options.errorMessage,
                },
              });
            } else if (options?.completedStopReason !== undefined) {
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId,
                turnId,
                payload: {
                  state: options.completedStopReason === "cancelled" ? "cancelled" : "completed",
                  stopReason: options.completedStopReason ?? null,
                },
              });
            }
          }
          return;
        }
        let settleTurnId = turnId;
        if (options?.settleAllPrompts) {
          liveCtx.promptsInFlight = 0;
          if (liveCtx.activeTurnId !== turnId && liveCtx.session.activeTurnId !== turnId) {
            const fallbackTurnId = liveCtx.activeTurnId ?? liveCtx.session.activeTurnId;
            if (!fallbackTurnId) {
              if (liveCtx.session.status === "running" || liveCtx.session.status === "connecting") {
                const updatedAt = yield* nowIso;
                const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session;
                liveCtx.activeTurnId = undefined;
                liveCtx.session = {
                  ...readySession,
                  status: "ready",
                  updatedAt,
                };
              }
              return;
            }
            settleTurnId = fallbackTurnId;
          }
        } else {
          const remainingPrompts = Math.max(0, liveCtx.promptsInFlight - 1);
          if (
            remainingPrompts > 0 ||
            liveCtx.activeTurnId !== settleTurnId ||
            liveCtx.session.activeTurnId !== settleTurnId
          ) {
            liveCtx.promptsInFlight = remainingPrompts;
            return;
          }
          liveCtx.promptsInFlight = remainingPrompts;
        }
        const updatedAt = yield* nowIso;
        const canEmitTurnCompletion =
          liveCtx.session.status === "running" || liveCtx.session.status === "connecting";
        const shouldEmitFailedTurn = options?.errorMessage !== undefined && canEmitTurnCompletion;
        const shouldEmitCompletedTurn =
          options?.completedStopReason !== undefined && canEmitTurnCompletion;
        const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session;
        liveCtx.activeTurnId = undefined;
        liveCtx.session = {
          ...readySession,
          status: "ready",
          updatedAt,
        };
        if (options?.emitTurnCompletion === false) {
          return;
        }
        if (shouldEmitFailedTurn) {
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId,
            turnId: settleTurnId,
            payload: {
              state: "failed",
              errorMessage: options.errorMessage,
            },
          });
        } else if (shouldEmitCompletedTurn) {
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId,
            turnId: settleTurnId,
            payload: {
              state: options.completedStopReason === "cancelled" ? "cancelled" : "completed",
              stopReason: options.completedStopReason ?? null,
            },
          });
        }
      });

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to write native Grok notification log.", {
            cause,
            threadId,
            method,
          }),
        ),
      );

    const emitPlanUpdate = (
      ctx: GrokSessionContext,
      turnId: TurnId | undefined,
      stamp: { readonly eventId: EventId; readonly createdAt: string },
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
      method: string,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${turnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp,
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload,
            source: "acp.jsonrpc",
            method,
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<GrokSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: GrokSessionContext) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const teardown = yield* Effect.sync(() => {
            if (ctx.stopCompletion !== undefined) {
              return { completion: ctx.stopCompletion, shouldStart: false } as const;
            }
            const completion = Deferred.makeUnsafe<void>();
            // This update is atomic, before the first yield: concurrent callers
            // all await the same teardown instead of returning early from a
            // half-stopped context.
            ctx.stopped = true;
            ctx.stopCompletion = completion;
            return { completion, shouldStart: true } as const;
          });
          if (teardown.shouldStart) {
            yield* Effect.gen(function* () {
              yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
              yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs);
              // `session/close` is the ACP-owned whole-session stop. When Grok
              // advertises it, the protocol requires all ongoing session work
              // to be cancelled, including tool shells in their own PGIDs.
              yield* ctx.acp.closeSession.pipe(Effect.timeout("2 seconds"), Effect.ignore);
              // Closing the protocol layers alone can wait behind their streams.
              // Kill the detached provider process group first so teardown is
              // bounded even when Grok or one of its children ignores SIGTERM.
              yield* ctx.acp.shutdown;
              if (ctx.notificationFiber) {
                yield* Fiber.interrupt(ctx.notificationFiber);
              }
              yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
              if (sessions.get(ctx.threadId) === ctx) {
                sessions.delete(ctx.threadId);
              }
              yield* offerRuntimeEvent({
                type: "session.exited",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: ctx.threadId,
                payload: { exitKind: "graceful" },
              });
            }).pipe(
              Effect.ensuring(Deferred.succeed(teardown.completion, undefined)),
              Effect.interruptible,
              Effect.forkIn(sessionTeardownScope),
            );
          }
          // Publishing `stopCompletion` and starting its teardown fiber are one
          // uninterruptible handoff. Only the caller's wait is interruptible;
          // otherwise a Stop cancelled between those steps strands every later
          // Stop/restart on a Deferred no fiber can complete.
          yield* restore(Deferred.await(teardown.completion));
        }),
      );

    const startSession: GrokAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const grokModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );

          const resumeState = parseGrokResume(input.resumeCursor);
          const resumeSessionId = resumeState?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });

          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const acp = yield* makeGrokAcpRuntime({
            grokSettings,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            ...(resumeSessionId && resumeState.fork
              ? { forkSessionId: resumeSessionId }
              : resumeSessionId
                ? { resumeSessionId }
                : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            ...(mcpSession
              ? {
                  mcpServers: [
                    {
                      type: "http" as const,
                      name: "t3-code",
                      url: mcpSession.endpoint,
                      headers: [
                        {
                          name: "Authorization",
                          value: mcpSession.authorizationHeader,
                        },
                      ],
                    },
                  ],
                }
              : {}),
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: mapKnownProviderFailure(cause.message) ?? cause.message,
                  cause,
                }),
            ),
          );
          const started = yield* Effect.gen(function* () {
            yield* Effect.forEach(
              GROK_BACKGROUND_TASK_NOTIFICATION_METHODS,
              (method) =>
                acp.handleExtNotification(method, Schema.Unknown, (params) =>
                  Effect.gen(function* () {
                    yield* logNative(input.threadId, method, params);
                    const liveCtx = sessions.get(input.threadId);
                    if (!liveCtx) return;
                    yield* emitGrokBackgroundTaskFromNotification(liveCtx, method, params);
                  }).pipe(
                    Effect.catch((cause) =>
                      Effect.logError("Failed to process Grok background-task notification.", {
                        cause,
                        method,
                      }),
                    ),
                  ),
                ),
              { discard: true },
            );
            yield* acp.handleExtNotification(
              "_x.ai/queue/changed",
              XAiQueueChangedNotification,
              (notification) =>
                Effect.gen(function* () {
                  yield* logNative(input.threadId, "_x.ai/queue/changed", notification);
                  const liveCtx = sessions.get(input.threadId);
                  if (!liveCtx || liveCtx.acpSessionId !== notification.sessionId) return;

                  liveCtx.queuedPromptVersions = new Map(
                    notification.entries.map((entry) => [entry.id, entry.version]),
                  );
                  const previousQueueChangedSignal = liveCtx.queueChangedSignal;
                  liveCtx.queueChangedSignal = yield* Deferred.make<void>();
                  // `entries` are only waiting in Grok's native queue. They have
                  // not entered the model's active context yet, so treating
                  // them as delivered drops T3's durable recovery obligation
                  // and can strand every follow-up behind a long-running turn.
                  // The running prompt is the only row this notification proves
                  // Grok has actually begun consuming.
                  const runningMessageId = notification.runningPromptId;
                  if (runningMessageId) {
                    const messageId = runningMessageId;
                    const turnId = liveCtx.pendingMessageDeliveries.get(messageId);
                    if (turnId !== undefined) {
                      liveCtx.pendingMessageDeliveries.delete(messageId);
                      yield* offerRuntimeEvent({
                        type: "message.delivered",
                        ...(yield* makeEventStamp()),
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId,
                        payload: { messageId: MessageId.make(messageId) },
                      });
                    }
                  }
                  yield* Deferred.succeed(previousQueueChangedSignal, undefined).pipe(
                    Effect.asVoid,
                  );
                }).pipe(
                  Effect.catch((cause) =>
                    Effect.logError("Failed to process Grok queue notification.", { cause }),
                  ),
                ),
            );
            yield* Effect.forEach(
              ["x.ai/ask_user_question", "_x.ai/ask_user_question"] as const,
              (method) =>
                acp.handleExtRequest(method, XAiAskUserQuestionRequest, (params) =>
                  mapAcpCallbackFailure(
                    Effect.gen(function* () {
                      yield* logNative(input.threadId, method, params);
                      const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                      const runtimeRequestId = RuntimeRequestId.make(requestId);
                      const resolution = yield* Deferred.make<PendingUserInputResolution>();
                      const turnId = resolveSessionCallbackTurnId(sessions, input.threadId);
                      pendingUserInputs.set(requestId, { resolution });
                      yield* offerRuntimeEvent({
                        type: "user-input.requested",
                        ...(yield* makeEventStamp()),
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId,
                        requestId: runtimeRequestId,
                        payload: { questions: extractXAiAskUserQuestions(params) },
                        raw: {
                          source: "acp.grok.extension",
                          method,
                          payload: params,
                        },
                      });
                      const resolved = yield* Deferred.await(resolution);
                      pendingUserInputs.delete(requestId);
                      const resolvedAnswers = resolved._tag === "answered" ? resolved.answers : {};
                      yield* offerRuntimeEvent({
                        type: "user-input.resolved",
                        ...(yield* makeEventStamp()),
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId,
                        requestId: runtimeRequestId,
                        payload: { answers: resolvedAnswers },
                        raw: {
                          source: "acp.grok.extension",
                          method,
                          payload: params,
                        },
                      });
                      switch (resolved._tag) {
                        case "answered":
                          return makeXAiAskUserQuestionResponse(params, resolved.answers);
                        case "cancelled":
                          return makeXAiAskUserQuestionCancelledResponse();
                      }
                    }),
                  ),
                ),
              { discard: true },
            );
            yield* acp.handleRequestPermission((params) =>
              mapAcpCallbackFailure(
                Effect.gen(function* () {
                  yield* logNative(input.threadId, "session/request_permission", params);
                  const liveCtx = sessions.get(input.threadId);
                  const permissionRequest = parsePermissionRequest(params);
                  const permissionAction = resolveGrokPermissionAction({
                    runtimeMode: liveCtx?.session.runtimeMode ?? input.runtimeMode,
                    interactionMode: liveCtx?.interactionMode,
                    kind: permissionRequest.kind,
                  });
                  if (permissionAction === "allow") {
                    const autoApprovedOptionId = selectAutoApprovedPermissionOption(params);
                    if (autoApprovedOptionId !== undefined) {
                      return {
                        outcome: {
                          outcome: "selected" as const,
                          optionId: autoApprovedOptionId,
                        },
                      };
                    }
                  }
                  if (permissionAction === "deny") {
                    const rejectedOptionId = selectPermissionOptionId(params, "decline");
                    return {
                      outcome: rejectedOptionId
                        ? {
                            outcome: "selected" as const,
                            optionId: rejectedOptionId,
                          }
                        : ({ outcome: "cancelled" } as const),
                    };
                  }
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const decision = yield* Deferred.make<ProviderApprovalDecision>();
                  const turnId = resolveSessionCallbackTurnId(sessions, input.threadId);
                  pendingApprovals.set(requestId, { decision });
                  yield* offerRuntimeEvent(
                    makeAcpRequestOpenedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      detail:
                        permissionRequest.detail ??
                        encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                        "[unserializable params]",
                      args: params,
                      source: "acp.jsonrpc",
                      method: "session/request_permission",
                      rawPayload: params,
                    }),
                  );
                  const resolved = yield* Deferred.await(decision);
                  pendingApprovals.delete(requestId);
                  yield* offerRuntimeEvent(
                    makeAcpRequestResolvedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      decision: resolved,
                    }),
                  );
                  const selectedOptionId =
                    resolved === "cancel" ? undefined : selectPermissionOptionId(params, resolved);
                  return {
                    outcome: selectedOptionId
                      ? {
                          outcome: "selected" as const,
                          optionId: selectedOptionId,
                        }
                      : ({ outcome: "cancelled" } as const),
                  };
                }),
              ),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          const requestedStartModelId = grokModelSelection?.model
            ? resolveGrokAcpBaseModelId(grokModelSelection.model)
            : undefined;
          const boundSelection = yield* applyGrokAcpModelSelection({
            runtime: acp,
            currentModelId: currentGrokModelIdFromSessionSetup(started.sessionSetupResult),
            requestedModelId: requestedStartModelId,
            requestedEffort: getModelSelectionStringOptionValue(grokModelSelection, "effort"),
            sessionSetupResult: started.sessionSetupResult,
            mapError: (cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", cause),
          });
          const boundModelId = boundSelection.modelId;
          yield* applyAcpRequestedSessionMode({
            runtime: acp,
            runtimeMode: input.runtimeMode,
            interactionMode: undefined,
            mapError: (cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_mode", cause),
          });

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(boundModelId ? { model: resolveGrokAcpBaseModelId(boundModelId) } : {}),
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: GROK_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          const queueChangedSignal = yield* Deferred.make<void>();
          const ctx: GrokSessionContext = {
            threadId: input.threadId,
            acpSessionId: started.sessionId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            interruptedTurnIds: new Set(),
            promptsInFlight: 0,
            pendingMessageDeliveries: new Map(),
            queuedPromptVersions: new Map(),
            queueChangedSignal,
            currentModelId: boundModelId,
            currentEffort: boundSelection.reasoningEffort,
            interactionMode: undefined,
            assistantTextByTurn: "",
            reasoningAnnounced: false,
            capturedProposedPlanKeys: new Set(),
            sessionSetupResult: started.sessionSetupResult,
            stopped: false,
            stopCompletion: undefined,
            seenBackgroundTaskKeys: new Set(),
          };

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                if (event._tag === "EventStreamBarrier") {
                  yield* Deferred.succeed(event.acknowledge, undefined);
                  return;
                }
                // Stop publishes `ctx.stopped` before its bounded ACP close and
                // process teardown. Do not let notifications already buffered
                // on that transport resurrect output or tasks during the gap,
                // or let an obsolete context write into a replacement thread.
                // Barriers stay above this gate so teardown drains can finish.
                const liveContext = sessions.get(ctx.threadId);
                if (ctx.stopped || (liveContext !== undefined && liveContext !== ctx)) {
                  return;
                }
                if (
                  event._tag === "PlanUpdated" ||
                  event._tag === "ToolCallUpdated" ||
                  event._tag === "ContentDelta"
                ) {
                  yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                }

                if (event._tag === "ModeChanged") {
                  return;
                }

                const notificationTurnId = resolveNotificationTurnId(ctx);
                if (
                  notificationTurnId === undefined ||
                  ctx.interruptedTurnIds.has(notificationTurnId)
                ) {
                  return;
                }
                const stamp = yield* makeEventStamp();

                switch (event._tag) {
                  case "AssistantItemStarted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* emitPlanUpdate(
                      ctx,
                      notificationTurnId,
                      stamp,
                      event.payload,
                      event.rawPayload,
                      "session/update",
                    );
                    return;
                  case "ToolCallUpdated":
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "UsageUpdated": {
                    const usage = grokTokenUsageFromUsageUpdate({
                      used: event.used,
                      size: event.size,
                    });
                    if (usage) {
                      yield* offerRuntimeEvent({
                        type: "thread.token-usage.updated",
                        ...stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        ...(boundInstanceId ? { providerInstanceId: boundInstanceId } : {}),
                        payload: { usage },
                        raw: {
                          source: "acp.jsonrpc",
                          method: "session/update",
                          payload: event.rawPayload,
                        },
                      });
                    }
                    return;
                  }
                  case "ContentDelta":
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        streamKind: event.streamKind,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    if (event.streamKind === "reasoning_text") {
                      if (!ctx.reasoningAnnounced) {
                        ctx.reasoningAnnounced = true;
                        yield* offerRuntimeEvent(
                          makeAcpReasoningItemEvent({
                            stamp: yield* makeEventStamp(),
                            provider: PROVIDER,
                            threadId: ctx.threadId,
                            turnId: notificationTurnId,
                            rawPayload: event.rawPayload,
                          }),
                        );
                      }
                      return;
                    }
                    ctx.assistantTextByTurn += event.text;
                    for (const planMarkdown of extractCompletedProposedPlans(
                      ctx.assistantTextByTurn,
                    )) {
                      if (ctx.capturedProposedPlanKeys.has(planMarkdown)) {
                        continue;
                      }
                      ctx.capturedProposedPlanKeys.add(planMarkdown);
                      const proposedStamp = yield* makeEventStamp();
                      yield* offerRuntimeEvent({
                        type: "turn.proposed.completed",
                        ...proposedStamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        payload: { planMarkdown },
                        raw: {
                          source: "acp.jsonrpc",
                          method: "session/update",
                          payload: event.rawPayload,
                        },
                      });
                    }
                    return;
                }
              }),
            ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to process Grok runtime notification.", { cause }),
            ),
            // Session-scoped, not caller-scoped: startSession may run inside a
            // short-lived obligation executor fiber, and a child fork dies
            // with its parent — leaving the session deaf to notifications.
            Effect.forkIn(sessionScope),
          );

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Grok ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });
          yield* emitGrokAccountUsage(acp, input.threadId).pipe(Effect.forkIn(sessionScope));
          yield* emitGrokTokenUsage(acp, input.threadId, started.sessionId).pipe(
            Effect.forkIn(sessionScope),
          );

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: GrokAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const prepared = yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(input.threadId);
            // A sendTurn while a prompt is in flight is a steer: the agent
            // folds the new prompt into the ongoing work, so the active turn
            // id is reused instead of opening a new turn.
            const steeringTurnId = ctx.promptsInFlight > 0 ? ctx.activeTurnId : undefined;
            const turnId = steeringTurnId ?? TurnId.make(yield* randomUUIDv4);
            // Count this prompt immediately so a superseded in-flight prompt
            // resolving from here on does not settle the turn; decremented on
            // preparation failure here, and after the prompt below otherwise.
            ctx.promptsInFlight += 1;
            // Bind the turn id before cooperative yields so interruptTurn can
            // settle this prompt even if stop arrives during preparation.
            ctx.activeTurnId = turnId;
            ctx.session = {
              ...ctx.session,
              status: steeringTurnId === undefined ? "connecting" : "running",
              activeTurnId: turnId,
              updatedAt: yield* nowIso,
            };

            return yield* Effect.gen(function* () {
              const turnModelSelection =
                input.modelSelection?.instanceId === boundInstanceId
                  ? input.modelSelection
                  : undefined;
              const requestedTurnModelId = turnModelSelection?.model
                ? resolveGrokAcpBaseModelId(turnModelSelection.model)
                : undefined;
              const appliedSelection = yield* applyGrokAcpModelSelection({
                runtime: ctx.acp,
                currentModelId: ctx.currentModelId,
                requestedModelId: requestedTurnModelId,
                currentEffort: ctx.currentEffort,
                requestedEffort: getModelSelectionStringOptionValue(turnModelSelection, "effort"),
                sessionSetupResult: ctx.sessionSetupResult,
                mapError: (cause) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", cause),
              });
              const currentModelId = appliedSelection.modelId;
              ctx.currentEffort = appliedSelection.reasoningEffort;
              yield* applyAcpRequestedSessionMode({
                runtime: ctx.acp,
                runtimeMode: ctx.session.runtimeMode,
                interactionMode: input.interactionMode,
                mapError: (cause) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_mode", cause),
              });
              if (input.interactionMode !== undefined) {
                ctx.interactionMode = input.interactionMode;
              }

              const text = input.input?.trim();
              const imagePromptParts = yield* Effect.forEach(
                input.attachments ?? [],
                (attachment) =>
                  Effect.gen(function* () {
                    const attachmentPath = resolveAttachmentPath({
                      attachmentsDir: serverConfig.attachmentsDir,
                      attachment,
                    });
                    if (!attachmentPath) {
                      return yield* new ProviderAdapterRequestError({
                        provider: PROVIDER,
                        method: "session/prompt",
                        detail: `Invalid attachment id '${attachment.id}'.`,
                      });
                    }
                    const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                      Effect.mapError(
                        (cause) =>
                          new ProviderAdapterRequestError({
                            provider: PROVIDER,
                            method: "session/prompt",
                            detail: cause.message,
                            cause,
                          }),
                      ),
                    );
                    return {
                      type: "image",
                      data: Buffer.from(bytes).toString("base64"),
                      mimeType: attachment.mimeType,
                    } satisfies EffectAcpSchema.ContentBlock;
                  }),
              );
              const collaborationBlock = grokCollaborationPromptBlock(input.interactionMode);
              const promptParts: Array<EffectAcpSchema.ContentBlock> = [
                ...(collaborationBlock ? [collaborationBlock] : []),
                ...(text ? [{ type: "text" as const, text }] : []),
                ...imagePromptParts,
              ];

              if (promptParts.length === 0) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue: "Turn requires non-empty text or attachments.",
                });
              }

              ctx.currentModelId = currentModelId;
              const displayModel = currentModelId
                ? resolveGrokAcpBaseModelId(currentModelId)
                : undefined;
              for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
                yield* Effect.yieldNow;
              }
              if (ctx.interruptedTurnIds.has(turnId)) {
                yield* settlePromptInFlight(input.threadId, turnId, ctx.acpSessionId, {
                  completedStopReason: "cancelled",
                  emitTurnCompletion: false,
                  settleAllPrompts: true,
                });
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: "Grok prompt was interrupted during preparation.",
                });
              }
              if (steeringTurnId === undefined) {
                ctx.lastPlanFingerprint = undefined;
                ctx.assistantTextByTurn = "";
                ctx.reasoningAnnounced = false;
                ctx.capturedProposedPlanKeys = new Set();
              }
              ctx.session = {
                ...ctx.session,
                status: "running",
                activeTurnId: turnId,
                updatedAt: yield* nowIso,
                ...(displayModel ? { model: displayModel } : {}),
              };

              if (steeringTurnId === undefined) {
                yield* offerRuntimeEvent({
                  type: "turn.started",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: displayModel ? { model: displayModel } : {},
                });
              }

              return {
                acp: ctx.acp,
                acpSessionId: ctx.acpSessionId,
                displayModel,
                isSteering: steeringTurnId !== undefined,
                messageId: input.messageId,
                promptParts,
                turnId,
              };
            }).pipe(
              Effect.tapCause(() =>
                Effect.gen(function* () {
                  const liveCtx = sessions.get(input.threadId);
                  if (!liveCtx) {
                    return;
                  }
                  yield* settlePromptInFlight(input.threadId, turnId, liveCtx.acpSessionId, {
                    errorMessage: "Grok prompt preparation failed.",
                    emitTurnCompletion: false,
                  });
                }),
              ),
            );
          }),
        );
        const promptSettled = yield* Ref.make(false);
        const promptRpcSucceeded = yield* Ref.make(false);
        const promptResultRef = yield* Ref.make<EffectAcpSchema.PromptResponse | undefined>(
          undefined,
        );

        const promptFailureMessageRef = yield* Ref.make<string | undefined>(undefined);

        return yield* Effect.gen(function* () {
          if (prepared.messageId !== undefined) {
            const liveCtx = sessions.get(input.threadId);
            if (liveCtx?.acpSessionId === prepared.acpSessionId) {
              liveCtx.pendingMessageDeliveries.set(prepared.messageId, prepared.turnId);
            }
          }
          const result = yield* prepared.acp
            .prompt({
              ...(prepared.messageId !== undefined ? { messageId: prepared.messageId } : {}),
              prompt: prepared.promptParts,
            })
            .pipe(
              Effect.tap((promptResult) =>
                Effect.all([
                  Ref.set(promptRpcSucceeded, true),
                  Ref.set(promptResultRef, promptResult),
                ]),
              ),
              Effect.tapError((error) =>
                Ref.set(
                  promptFailureMessageRef,
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error).message,
                ).pipe(Effect.andThen(prepared.acp.drainEvents)),
              ),
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
              ),
            );

          const cancelledBeforeModelConsumption =
            result.stopReason === "cancelled" &&
            prepared.isSteering &&
            prepared.messageId !== undefined &&
            (() => {
              const liveCtx = sessions.get(input.threadId);
              return (
                liveCtx?.acpSessionId === prepared.acpSessionId &&
                liveCtx.pendingMessageDeliveries.get(prepared.messageId) === prepared.turnId
              );
            })();
          if (cancelledBeforeModelConsumption) {
            const detail = "Grok cancelled the queued prompt before the model consumed it.";
            yield* Ref.set(promptRpcSucceeded, false);
            yield* Ref.set(promptFailureMessageRef, detail);
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/prompt",
              detail,
              // This is a transient delivery race, not a failed user turn.
              // Route the durable obligation through the uncapped short retry
              // path so the successful signoff remains ready while every
              // never-consumed follow-up is delivered in a fresh turn.
              failureKind: "retryable-upstream",
            });
          }

          const acceptedTurn = {
            threadId: input.threadId,
            turnId: prepared.turnId,
          };
          // A successful session/prompt response is Grok ACP's durable proof
          // that this exact message was accepted. Local finalization below is
          // best-effort after that boundary: surfacing its failure would make
          // the delivery queue replay a prompt Grok already received.
          if (input.messageId !== undefined) {
            const liveCtx = sessions.get(input.threadId);
            if (liveCtx?.pendingMessageDeliveries.delete(input.messageId)) {
              yield* offerRuntimeEvent({
                type: "message.delivered",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: prepared.turnId,
                payload: { messageId: input.messageId },
              });
            }
          }

          const finalizedTurn = yield* preserveAcceptedGrokTurn(
            withThreadLock(
              input.threadId,
              Effect.gen(function* () {
                const ctx = yield* requireSession(input.threadId);
                if (ctx.acpSessionId !== prepared.acpSessionId) {
                  yield* settlePromptInFlight(
                    input.threadId,
                    prepared.turnId,
                    prepared.acpSessionId,
                    {
                      errorMessage: "Grok session changed before the turn completed.",
                      settleAllPrompts: true,
                    },
                  );
                  yield* Ref.set(promptSettled, true);
                  return yield* new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/prompt",
                    detail: "Grok session changed before the turn completed.",
                  });
                }
                // Keep prompt settlement atomic with respect to Stop and steering.
                // interruptTurn marks its target before waiting for this lock, so
                // cancellation can still win while queued ACP events are drained.
                for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
                  yield* Effect.yieldNow;
                }
                yield* prepared.acp.drainEvents;
                if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                  yield* Ref.set(promptSettled, true);
                  return {
                    threadId: input.threadId,
                    turnId: prepared.turnId,
                    resumeCursor: ctx.session.resumeCursor,
                  };
                }

                if (
                  ctx.promptsInFlight <= 0 ||
                  ctx.activeTurnId !== prepared.turnId ||
                  ctx.session.activeTurnId !== prepared.turnId
                ) {
                  yield* Ref.set(promptSettled, true);
                  return {
                    threadId: input.threadId,
                    turnId: prepared.turnId,
                    resumeCursor: ctx.session.resumeCursor,
                  };
                }

                appendPromptResultToTurn(ctx, prepared.turnId, prepared.promptParts, result);
                ctx.session = {
                  ...ctx.session,
                  status: "running",
                  activeTurnId: prepared.turnId,
                  updatedAt: yield* nowIso,
                  ...(prepared.displayModel ? { model: prepared.displayModel } : {}),
                };
                const remainingPrompts = Math.max(0, ctx.promptsInFlight - 1);
                ctx.promptsInFlight = remainingPrompts;

                // Only the last remaining prompt settles the turn. A steer-
                // superseded prompt resolving while another is in flight or
                // pending must leave the merged turn running.
                if (
                  remainingPrompts === 0 &&
                  ctx.activeTurnId === prepared.turnId &&
                  ctx.session.activeTurnId === prepared.turnId
                ) {
                  if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                    yield* Ref.set(promptSettled, true);
                    return {
                      threadId: input.threadId,
                      turnId: prepared.turnId,
                      resumeCursor: ctx.session.resumeCursor,
                    };
                  }
                  const completedAt = yield* nowIso;
                  const { activeTurnId: _completedTurnId, ...readySession } = ctx.session;
                  ctx.activeTurnId = undefined;
                  ctx.session = {
                    ...readySession,
                    status: "ready",
                    updatedAt: completedAt,
                    ...(prepared.displayModel ? { model: prepared.displayModel } : {}),
                  };
                  const completedStopReason = completedStopReasonFromPromptResponse(result);
                  yield* offerRuntimeEvent({
                    type: "turn.completed",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: prepared.turnId,
                    payload: {
                      state: result.stopReason === "cancelled" ? "cancelled" : "completed",
                      stopReason: completedStopReason,
                    },
                  });
                  yield* emitGrokAccountUsage(ctx.acp, input.threadId, prepared.turnId).pipe(
                    Effect.forkIn(ctx.scope),
                  );
                  yield* emitGrokTokenUsage(
                    ctx.acp,
                    input.threadId,
                    ctx.acpSessionId,
                    prepared.turnId,
                  ).pipe(Effect.forkIn(ctx.scope));
                  ctx.interruptedTurnIds.delete(prepared.turnId);
                  yield* Ref.set(promptSettled, true);
                } else if (remainingPrompts > 0) {
                  yield* Ref.set(promptSettled, true);
                }

                return {
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  resumeCursor: ctx.session.resumeCursor,
                };
              }),
            ),
            acceptedTurn,
            { threadId: input.threadId, turnId: prepared.turnId },
          );

          return finalizedTurn;
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              if (prepared.messageId !== undefined) {
                const liveCtx = sessions.get(input.threadId);
                if (
                  liveCtx?.acpSessionId === prepared.acpSessionId &&
                  liveCtx.pendingMessageDeliveries.get(prepared.messageId) === prepared.turnId
                ) {
                  liveCtx.pendingMessageDeliveries.delete(prepared.messageId);
                }
              }
              if (yield* Ref.get(promptSettled)) {
                return;
              }

              if (yield* Ref.get(promptRpcSucceeded)) {
                const promptResult = yield* Ref.get(promptResultRef);
                if (promptResult === undefined) {
                  return;
                }
                yield* withThreadLock(
                  input.threadId,
                  Effect.gen(function* () {
                    const ctx = yield* requireSession(input.threadId);
                    if (ctx.acpSessionId !== prepared.acpSessionId) {
                      yield* settlePromptInFlight(
                        input.threadId,
                        prepared.turnId,
                        prepared.acpSessionId,
                        {
                          errorMessage: "Grok session changed before the turn completed.",
                          settleAllPrompts: true,
                        },
                      );
                      return;
                    }
                    if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                      return;
                    }
                    if (
                      ctx.promptsInFlight <= 0 ||
                      ctx.activeTurnId !== prepared.turnId ||
                      ctx.session.activeTurnId !== prepared.turnId
                    ) {
                      return;
                    }
                    appendPromptResultToTurn(
                      ctx,
                      prepared.turnId,
                      prepared.promptParts,
                      promptResult,
                    );
                    yield* settlePromptInFlight(
                      input.threadId,
                      prepared.turnId,
                      prepared.acpSessionId,
                      {
                        completedStopReason: completedStopReasonFromPromptResponse(promptResult),
                      },
                    );
                  }),
                );
                return;
              }

              const errorMessage = yield* Ref.get(promptFailureMessageRef);
              yield* withThreadLock(
                input.threadId,
                settlePromptInFlight(input.threadId, prepared.turnId, prepared.acpSessionId, {
                  errorMessage: errorMessage ?? "Grok prompt request failed.",
                }),
              );
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        );
      });

    const promoteQueuedTurn: NonNullable<GrokAdapterShape["promoteQueuedTurn"]> = (threadId) => {
      const tryPromote = Effect.suspend(() =>
        withThreadLock(
          threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(threadId);
            const queuedPrompts = xAiQueueInterjectPayloads(
              ctx.acpSessionId,
              Array.from(ctx.queuedPromptVersions, ([id, version]) => ({ id, version })),
            );
            if (queuedPrompts.length === 0) {
              return { _tag: "Waiting" as const, signal: ctx.queueChangedSignal };
            }

            // One empty-composer Enter means "catch up now" in Solla. Promote
            // every native row, oldest first, so a burst of corrections cannot
            // remain minutes behind one full Grok reasoning cycle at a time.
            yield* Effect.forEach(
              queuedPrompts,
              (payload) => {
                ctx.queuedPromptVersions.delete(payload.id);
                return ctx.acp.notify("x.ai/queue/interject", payload).pipe(
                  Effect.tapError(() =>
                    Effect.sync(() =>
                      ctx.queuedPromptVersions.set(payload.id, payload.expectedVersion),
                    ),
                  ),
                  Effect.mapError((error) =>
                    mapAcpToAdapterError(PROVIDER, threadId, "x.ai/queue/interject", error),
                  ),
                );
              },
              { discard: true },
            );
            return {
              _tag: "Promoted" as const,
              messageIds: queuedPrompts.map((payload) => MessageId.make(payload.id)),
            };
          }),
        ),
      );

      // The client can render a persisted follow-up before Grok publishes the
      // corresponding queue snapshot. Wait on the notification itself instead
      // of failing that fast second Enter. Multiple snapshots may arrive first
      // (for example, the running prompt followed by the queued prompt), so
      // continue until an actual waiting row appears or the bounded window ends.
      const waitForQueuedPrompt = (): ReturnType<
        NonNullable<GrokAdapterShape["promoteQueuedTurn"]>
      > =>
        Effect.suspend(() =>
          tryPromote.pipe(
            Effect.flatMap((result) =>
              result._tag === "Promoted"
                ? Effect.succeed(result.messageIds)
                : Deferred.await(result.signal).pipe(Effect.andThen(waitForQueuedPrompt())),
            ),
          ),
        );

      return waitForQueuedPrompt().pipe(
        Effect.timeoutOption("1 second"),
        Effect.flatMap(
          Option.match({
            onSome: Effect.succeed,
            onNone: () =>
              Effect.fail(
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "x.ai/queue/interject",
                  detail: "Grok no longer has any follow-ups waiting in its native queue.",
                }),
              ),
          }),
        ),
      );
    };

    const interruptTurn: GrokAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const observed = yield* Effect.sync(() => {
          const ctx = sessions.get(threadId);
          if (!ctx || ctx.stopped) {
            return {
              _tag: "Proceed" as const,
              acpSessionId: undefined,
              interruptedTurnId: turnId,
            };
          }
          const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
          if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
            return { _tag: "Ignore" as const };
          }
          const interruptedTurnId = turnId ?? activeTurnId;
          if (interruptedTurnId !== undefined) {
            ctx.interruptedTurnIds.add(interruptedTurnId);
          }
          return {
            _tag: "Proceed" as const,
            acpSessionId: ctx.acpSessionId,
            interruptedTurnId,
          };
        });
        if (observed._tag === "Ignore") {
          return;
        }

        yield* withThreadLock(
          threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(threadId);
            if (observed.acpSessionId !== undefined && ctx.acpSessionId !== observed.acpSessionId) {
              return;
            }
            const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
            if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
              return;
            }
            if (
              observed.interruptedTurnId !== undefined &&
              activeTurnId !== undefined &&
              activeTurnId !== observed.interruptedTurnId
            ) {
              return;
            }
            const interruptedTurnId =
              observed.interruptedTurnId ?? turnId ?? activeTurnId ?? ctx.session.activeTurnId;
            yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
            yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs);
            yield* Effect.ignore(
              ctx.acp.cancel.pipe(
                Effect.mapError((error) =>
                  mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
                ),
              ),
            );
            if (interruptedTurnId) {
              ctx.interruptedTurnIds.add(interruptedTurnId);
              yield* settlePromptInFlight(threadId, interruptedTurnId, ctx.acpSessionId, {
                completedStopReason: "cancelled",
                settleAllPrompts: true,
              });
            } else if (
              ctx.promptsInFlight > 0 ||
              ctx.session.status === "running" ||
              ctx.session.status === "connecting"
            ) {
              const updatedAt = yield* nowIso;
              ctx.promptsInFlight = 0;
              ctx.activeTurnId = undefined;
              const { activeTurnId: _activeTurnId, ...readySession } = ctx.session;
              ctx.session = {
                ...readySession,
                status: "ready",
                updatedAt,
              };
            }
          }),
        );
      });

    const respondToRequest: GrokAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: GrokAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "_x.ai/ask_user_question",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.resolution, { _tag: "answered", answers });
      });

    const stopTask: NonNullable<GrokAdapterShape["stopTask"]> = (threadId, taskId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const payload = grokTaskKillPayload({
          sessionId: ctx.acpSessionId,
          taskId: String(taskId),
        });
        yield* ctx.acp.request(GROK_TASK_KILL_METHODS[0], payload).pipe(
          Effect.catch(() => ctx.acp.request(GROK_TASK_KILL_METHODS[1], payload)),
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, threadId, GROK_TASK_KILL_METHODS[0], error),
          ),
        );
      });

    const readThread: GrokAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: GrokAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail: "Grok ACP sessions do not support provider-side rollback yet.",
        });
      });

    const stopSession: GrokAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        // Do not wait for the turn lock. sendTurn holds it while draining, and
        // Stop must still be able to kill the ACP process.
        const ctx = sessions.get(threadId);
        if (!ctx) {
          return;
        }
        yield* stopSessionInternal(ctx);
      });

    const listSessions: GrokAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: GrokAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: GrokAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session", taskStop: true },
      startSession,
      sendTurn,
      interruptTurn,
      promoteQueuedTurn,
      stopTask,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies GrokAdapterShape;
  });
}
