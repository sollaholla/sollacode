/**
 * KimiAdapterLive — Kimi Code CLI (`kimi acp`) via ACP.
 *
 * Kimi rejects a `session/prompt` while one of its turns is running, so this
 * adapter declares `liveSteering: "unsupported"`: a message sent mid-turn is
 * delivered by interrupting the turn and starting the next one in the same
 * session. Approvals, AskUserQuestion, and ExitPlanMode all arrive through
 * `session/request_permission`; see {@link classifyKimiPermissionRequest}.
 *
 * @module KimiAdapterLive
 */
import {
  ApprovalRequestId,
  EventId,
  type KimiSettings,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderOptionSelection,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  type RuntimeMode,
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
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpReasoningItemEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  classifyKimiPermissionRequest,
  isKimiAuthRequiredFailure,
  isKimiFileEditPermission,
  KIMI_DRIVER_KIND,
  KIMI_EMPTY_TURN_MESSAGE,
  KIMI_NOT_SIGNED_IN_MESSAGE,
  KIMI_PLAN_CAPTURED_OPTION_ID,
  kimiModeForTurn,
  kimiPlanMarkdownFromPermission,
  kimiQuestionAnswerOptionId,
  kimiQuestionFromPermission,
  kimiSelectOptionValues,
  makeKimiAcpRuntime,
  selectKimiPermissionOptionId,
} from "../acp/KimiAcpSupport.ts";
import { type KimiAdapterShape } from "../Services/KimiAdapter.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = KIMI_DRIVER_KIND;
const KIMI_RESUME_VERSION = 1 as const;
/** Kimi bridges one question per AskUserQuestion call; this is its answer key. */
const KIMI_QUESTION_ID = "kimi-question";
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.UnknownFromJsonString);

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

/**
 * Runs an ACP call whose failure the person may need to act on. A signed-out
 * CLI becomes the sign-in instruction — whether it arrived typed or, as a real
 * CLI's JSON-RPC error does, as a defect; everything else maps as usual.
 */
const withKimiFailureMapping =
  (threadId: ThreadId, method: string) =>
  <A>(effect: Effect.Effect<A, EffectAcpErrors.AcpError>): Effect.Effect<A, ProviderAdapterError> =>
    effect.pipe(
      Effect.catchCause((cause) =>
        !Cause.hasInterruptsOnly(cause) && isKimiAuthRequiredFailure(cause)
          ? Effect.fail(
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method,
                detail: KIMI_NOT_SIGNED_IN_MESSAGE,
              }),
            )
          : Effect.failCause(cause).pipe(
              Effect.mapError((error) => mapAcpToAdapterError(PROVIDER, threadId, method, error)),
            ),
      ),
    );

export interface KimiAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /**
   * Selections are honored when `modelSelection.instanceId` matches this value.
   * Defaults to the built-in instance id (`kimi`).
   */
  readonly instanceId?: ProviderInstanceId;
  /** Tests swap the binary mid-suite; production binds settings per instance. */
  readonly resolveSettings?: Effect.Effect<KimiSettings>;
  /**
   * Reads the account's plan usage. Run after every turn: Kimi has just used
   * — and so refreshed — its sign-in, which is when a reading is possible.
   */
  readonly readAccountUsage?: Effect.Effect<unknown>;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface KimiSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  /** One turn at a time: Kimi refuses a prompt while its own turn runs. */
  readonly turnLock: Semaphore.Semaphore;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  /** Whether the active turn produced anything a person could see. */
  activeTurnHasOutput: boolean;
  lastPlanFingerprint: string | undefined;
  reasoningAnnounced: boolean;
  stopped: boolean;
}

function parseKimiResume(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== KIMI_RESUME_VERSION) return undefined;
  return typeof record.sessionId === "string" && record.sessionId.trim()
    ? record.sessionId.trim()
    : undefined;
}

function settlePending(ctx: {
  readonly pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>;
}): Effect.Effect<void> {
  return Effect.all(
    [
      Effect.forEach(
        Array.from(ctx.pendingApprovals.values()),
        (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
        { discard: true },
      ),
      Effect.forEach(
        Array.from(ctx.pendingUserInputs.values()),
        (pending) => Deferred.succeed(pending.answers, {}).pipe(Effect.ignore),
        { discard: true },
      ),
    ],
    { discard: true },
  );
}

/**
 * Brings the session's model, thinking toggle, and mode to what the turn asks
 * for, writing only what differs.
 *
 * A model the session does not advertise is never sent: Kimi would refuse it,
 * and an id it does not know must not reach a decision. The session keeps its
 * current model instead, which the caller reports back as the model in use.
 */
function applyKimiSessionConfiguration(input: {
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly threadId: ThreadId;
  readonly model: string | undefined;
  readonly options: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly runtimeMode: RuntimeMode;
}): Effect.Effect<string | undefined, ProviderAdapterError> {
  return Effect.gen(function* () {
    const setOption = (configId: string, value: string) =>
      input.acp
        .setConfigOption(configId, value)
        .pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_config_option", error),
          ),
        );
    const currentValue = (
      options: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
      configId: string,
    ) => {
      const option = options.find((candidate) => candidate.id === configId);
      return option?.type === "select" ? option.currentValue : undefined;
    };

    let configOptions = yield* input.acp.getConfigOptions;
    if (
      input.model !== undefined &&
      input.model !== currentValue(configOptions, "model") &&
      kimiSelectOptionValues(configOptions, "model").includes(input.model)
    ) {
      yield* setOption("model", input.model);
      configOptions = yield* input.acp.getConfigOptions;
    }

    const thinking = input.options?.find((selection) => selection.id === "thinking")?.value;
    if (
      typeof thinking === "string" &&
      thinking !== currentValue(configOptions, "thinking") &&
      kimiSelectOptionValues(configOptions, "thinking").includes(thinking)
    ) {
      yield* setOption("thinking", thinking);
      configOptions = yield* input.acp.getConfigOptions;
    }

    const mode = kimiModeForTurn({
      interactionMode: input.interactionMode,
      runtimeMode: input.runtimeMode,
    });
    if (
      mode !== currentValue(configOptions, "mode") &&
      kimiSelectOptionValues(configOptions, "mode").includes(mode)
    ) {
      yield* setOption("mode", mode);
      configOptions = yield* input.acp.getConfigOptions;
    }

    return currentValue(configOptions, "model");
  });
}

export function makeKimiAdapter(kimiSettings: KimiSettings, options?: KimiAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("kimi");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger = options?.nativeEventLogger;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, KimiSessionContext>();
    const startLocks = new Map<string, Semaphore.Semaphore>();
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate a Kimi runtime identifier.",
            cause,
          }),
      ),
    );
    const makeEventStamp = () =>
      Effect.all({ eventId: Effect.map(randomUUIDv4, EventId.make), createdAt: nowIso });
    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);
    const toTransportError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "Failed to process a Kimi permission request.",
              cause,
            }),
        ),
      );

    const withStartLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        let lock = startLocks.get(threadId);
        if (!lock) {
          lock = Semaphore.makeUnsafe(1);
          startLocks.set(threadId, lock);
        }
        return lock.withPermit(effect);
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
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<KimiSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      return !ctx || ctx.stopped
        ? Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }))
        : Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: KimiSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePending(ctx);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    /**
     * Routes one `session/request_permission` by what Kimi is actually asking:
     * a plan is captured for the person to settle, a question always goes to
     * the person, and only real tool approvals follow the runtime mode.
     */
    const handlePermission = (
      threadId: ThreadId,
      runtimeMode: () => RuntimeMode,
      activeTurnId: () => TurnId | undefined,
      markOutput: () => void,
      pendingApprovals: Map<ApprovalRequestId, PendingApproval>,
      pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>,
      params: EffectAcpSchema.RequestPermissionRequest,
    ) =>
      Effect.gen(function* () {
        yield* logNative(threadId, "session/request_permission", params);
        const selected = (optionId: string) => ({
          outcome: { outcome: "selected" as const, optionId },
        });
        const cancelled = { outcome: { outcome: "cancelled" as const } };

        switch (classifyKimiPermissionRequest(params)) {
          case "plan-review": {
            const planMarkdown = kimiPlanMarkdownFromPermission(params);
            if (planMarkdown) {
              markOutput();
              const toolCallId = params.toolCall.toolCallId.trim();
              yield* offerRuntimeEvent({
                type: "turn.proposed.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId,
                turnId: activeTurnId(),
                ...(toolCallId.length > 0 ? { itemId: RuntimeItemId.make(toolCallId) } : {}),
                payload: { planMarkdown },
                raw: {
                  source: "acp.jsonrpc",
                  method: "session/request_permission",
                  payload: params,
                },
              });
            }
            return selected(KIMI_PLAN_CAPTURED_OPTION_ID);
          }
          case "question": {
            const question = kimiQuestionFromPermission(params);
            const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
            const runtimeRequestId = RuntimeRequestId.make(requestId);
            const answers = yield* Deferred.make<ProviderUserInputAnswers>();
            pendingUserInputs.set(requestId, { answers });
            markOutput();
            yield* offerRuntimeEvent({
              type: "user-input.requested",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId,
              turnId: activeTurnId(),
              requestId: runtimeRequestId,
              payload: {
                questions: [
                  {
                    id: KIMI_QUESTION_ID,
                    header: "Question",
                    question: question.question,
                    multiSelect: false,
                    options: question.options.map((option) => ({
                      label: option.label,
                      description: option.label,
                    })),
                  },
                ],
              },
              raw: { source: "acp.jsonrpc", method: "session/request_permission", payload: params },
            });
            const resolved = yield* Deferred.await(answers);
            pendingUserInputs.delete(requestId);
            yield* offerRuntimeEvent({
              type: "user-input.resolved",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId,
              turnId: activeTurnId(),
              requestId: runtimeRequestId,
              payload: { answers: resolved },
            });
            const optionId = kimiQuestionAnswerOptionId(question, resolved[KIMI_QUESTION_ID]);
            return optionId ? selected(optionId) : cancelled;
          }
          case "approval": {
            const mode = runtimeMode();
            if (
              mode === "full-access" ||
              mode === "auto" ||
              (mode === "auto-accept-edits" && isKimiFileEditPermission(params))
            ) {
              const optionId = selectKimiPermissionOptionId(params.options, "acceptForSession");
              if (optionId) return selected(optionId);
            }
            const permissionRequest = parsePermissionRequest(params);
            const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
            const runtimeRequestId = RuntimeRequestId.make(requestId);
            const decision = yield* Deferred.make<ProviderApprovalDecision>();
            pendingApprovals.set(requestId, { decision });
            yield* offerRuntimeEvent(
              makeAcpRequestOpenedEvent({
                stamp: yield* makeEventStamp(),
                provider: PROVIDER,
                threadId,
                turnId: activeTurnId(),
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
                threadId,
                turnId: activeTurnId(),
                requestId: runtimeRequestId,
                permissionRequest,
                decision: resolved,
              }),
            );
            const optionId = selectKimiPermissionOptionId(params.options, resolved);
            return optionId ? selected(optionId) : cancelled;
          }
        }
      });

    const startSession: KimiAdapterShape["startSession"] = (input) =>
      withStartLock(
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
          const modelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          let ctx: KimiSessionContext | undefined;

          const resumeSessionId = parseKimiResume(input.resumeCursor);
          const settings = options?.resolveSettings ? yield* options.resolveSettings : kimiSettings;
          const acp = yield* makeKimiAcpRuntime({
            kimiSettings: settings,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            ...makeAcpNativeLoggers({
              nativeEventLogger,
              provider: PROVIDER,
              threadId: input.threadId,
            }),
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );

          const started = yield* Effect.gen(function* () {
            yield* acp.handleRequestPermission((params) =>
              toTransportError(
                handlePermission(
                  input.threadId,
                  () => ctx?.session.runtimeMode ?? input.runtimeMode,
                  () => ctx?.activeTurnId,
                  () => {
                    if (ctx) ctx.activeTurnHasOutput = true;
                  },
                  pendingApprovals,
                  pendingUserInputs,
                  params,
                ),
              ),
            );
            return yield* acp.start();
          }).pipe(withKimiFailureMapping(input.threadId, "session/start"));

          const appliedModel = yield* applyKimiSessionConfiguration({
            acp,
            threadId: input.threadId,
            model: modelSelection?.model,
            options: modelSelection?.options,
            interactionMode: undefined,
            runtimeMode: input.runtimeMode,
          });

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(appliedModel ? { model: appliedModel } : {}),
            threadId: input.threadId,
            resumeCursor: { schemaVersion: KIMI_RESUME_VERSION, sessionId: started.sessionId },
            createdAt: now,
            updatedAt: now,
          };
          const context: KimiSessionContext = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            acp,
            turnLock: Semaphore.makeUnsafe(1),
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            activeTurnId: undefined,
            activeTurnHasOutput: false,
            lastPlanFingerprint: undefined,
            reasoningAnnounced: false,
            stopped: false,
          };
          ctx = context;

          context.notificationFiber = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                switch (event._tag) {
                  case "EventStreamBarrier":
                    yield* Deferred.succeed(event.acknowledge, undefined);
                    return;
                  case "ModeChanged":
                  case "UsageUpdated":
                    return;
                  case "AssistantItemStarted":
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: context.threadId,
                        turnId: context.activeTurnId,
                        itemId: event.itemId,
                        lifecycle:
                          event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated": {
                    yield* logNative(context.threadId, "session/update", event.rawPayload);
                    context.activeTurnHasOutput = true;
                    const fingerprint = `${context.activeTurnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(event.payload) ?? ""}`;
                    if (context.lastPlanFingerprint === fingerprint) return;
                    context.lastPlanFingerprint = fingerprint;
                    yield* offerRuntimeEvent(
                      makeAcpPlanUpdatedEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: context.threadId,
                        turnId: context.activeTurnId,
                        payload: event.payload,
                        source: "acp.jsonrpc",
                        method: "session/update",
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  }
                  case "ToolCallUpdated":
                    yield* logNative(context.threadId, "session/update", event.rawPayload);
                    context.activeTurnHasOutput = true;
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: context.threadId,
                        turnId: context.activeTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    yield* logNative(context.threadId, "session/update", event.rawPayload);
                    if (event.text.length > 0) context.activeTurnHasOutput = true;
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: context.threadId,
                        turnId: context.activeTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        streamKind: event.streamKind,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    if (event.streamKind === "reasoning_text" && !context.reasoningAnnounced) {
                      context.reasoningAnnounced = true;
                      yield* offerRuntimeEvent(
                        makeAcpReasoningItemEvent({
                          stamp: yield* makeEventStamp(),
                          provider: PROVIDER,
                          threadId: context.threadId,
                          turnId: context.activeTurnId,
                          rawPayload: event.rawPayload,
                        }),
                      );
                    }
                    return;
                }
              }),
            ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to process Kimi runtime notification.", { cause }),
            ),
            // Session-scoped: startSession may run inside a short-lived
            // obligation fiber, and a child fork would die with it.
            Effect.forkIn(sessionScope),
          );
          sessions.set(input.threadId, context);
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
            payload: { state: "ready", reason: "Kimi ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });
          return session;
        }).pipe(Effect.scoped),
      );

    const buildPrompt = (input: Parameters<KimiAdapterShape["sendTurn"]>[0]) =>
      Effect.gen(function* () {
        const promptParts: Array<EffectAcpSchema.ContentBlock> = [];
        if (input.input?.trim()) {
          promptParts.push({ type: "text", text: input.input.trim() });
        }
        for (const attachment of input.attachments ?? []) {
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
          promptParts.push({
            type: "image",
            data: Buffer.from(bytes).toString("base64"),
            mimeType: attachment.mimeType,
          });
        }
        if (promptParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }
        return promptParts;
      });

    const sendTurn: KimiAdapterShape["sendTurn"] = (input, sendOptions) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        // Kimi cannot join a running turn; the orchestrator interrupts it and
        // sends again, so an explicit steer target here is always stale.
        if (input.liveSteerTarget !== undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/steer",
            detail: "Kimi Code cannot add a message to a running turn.",
          });
        }
        const promptParts = yield* buildPrompt(input);
        const turnModelSelection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;

        return yield* ctx.turnLock.withPermit(
          Effect.gen(function* () {
            if (ctx.stopped || sessions.get(input.threadId) !== ctx) {
              return yield* new ProviderAdapterSessionNotFoundError({
                provider: PROVIDER,
                threadId: input.threadId,
              });
            }
            const appliedModel = yield* applyKimiSessionConfiguration({
              acp: ctx.acp,
              threadId: input.threadId,
              model: turnModelSelection?.model ?? ctx.session.model,
              options: turnModelSelection?.options,
              interactionMode: input.interactionMode,
              runtimeMode: ctx.session.runtimeMode,
            });
            const turnId = TurnId.make(yield* randomUUIDv4);
            ctx.activeTurnId = turnId;
            ctx.activeTurnHasOutput = false;
            ctx.lastPlanFingerprint = undefined;
            ctx.reasoningAnnounced = false;
            ctx.session = {
              ...ctx.session,
              status: "running",
              activeTurnId: turnId,
              ...(appliedModel ? { model: appliedModel } : {}),
              updatedAt: yield* nowIso,
            };
            yield* offerRuntimeEvent({
              type: "turn.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: appliedModel ? { model: appliedModel } : {},
            });

            const result = yield* ctx.acp
              .prompt(
                { prompt: promptParts },
                sendOptions?.onNativeDispatch === undefined
                  ? undefined
                  : { onNativeDispatch: sendOptions.onNativeDispatch },
              )
              .pipe(withKimiFailureMapping(input.threadId, "session/prompt"));
            // Updates are queued behind the prompt response; let the event
            // loop catch up before judging whether the turn showed anything.
            yield* ctx.acp.drainEvents;
            ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });

            const silentFailure = result.stopReason === "end_turn" && !ctx.activeTurnHasOutput;
            yield* offerRuntimeEvent({
              type: "turn.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: silentFailure
                ? {
                    state: "failed",
                    stopReason: result.stopReason,
                    errorMessage: KIMI_EMPTY_TURN_MESSAGE,
                  }
                : {
                    state: result.stopReason === "cancelled" ? "cancelled" : "completed",
                    stopReason: result.stopReason ?? null,
                  },
            });
            if (options?.readAccountUsage) {
              // Forked: a usage reading must never hold the turn open or fail it.
              yield* options.readAccountUsage.pipe(
                Effect.flatMap((rateLimits) =>
                  rateLimits === null || rateLimits === undefined
                    ? Effect.void
                    : Effect.flatMap(makeEventStamp(), (stamp) =>
                        offerRuntimeEvent({
                          type: "account.rate-limits.updated",
                          ...stamp,
                          provider: PROVIDER,
                          threadId: input.threadId,
                          turnId,
                          providerInstanceId: boundInstanceId,
                          payload: { rateLimits },
                        }),
                      ),
                ),
                Effect.ignore,
                Effect.forkIn(ctx.scope),
              );
            }
            return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                const { activeTurnId: _activeTurnId, ...readySession } = ctx.session;
                ctx.activeTurnId = undefined;
                ctx.session = { ...readySession, status: "ready", updatedAt: yield* nowIso };
              }),
            ),
          ),
        );
      });

    const interruptTurn: KimiAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* settlePending(ctx);
        yield* Effect.ignore(ctx.acp.cancel);
      });

    const respondToRequest: KimiAdapterShape["respondToRequest"] = (
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

    const respondToUserInput: KimiAdapterShape["respondToUserInput"] = (
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
            method: "session/request_permission",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread: KimiAdapterShape["readThread"] = (threadId) =>
      Effect.map(requireSession(threadId), (ctx) => ({ threadId, turns: ctx.turns }));

    const rollbackThread: KimiAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        ctx.turns.splice(Math.max(0, ctx.turns.length - numTurns));
        return { threadId, turns: ctx.turns };
      });

    const stopSession: KimiAdapterShape["stopSession"] = (threadId) =>
      withStartLock(threadId, Effect.flatMap(requireSession(threadId), stopSessionInternal));

    const listSessions: KimiAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));

    const hasSession: KimiAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    const stopAll: KimiAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.catch((cause) =>
          Effect.logError("Failed to emit Kimi session shutdown event.", { cause }),
        ),
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session", liveSteering: "unsupported" },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies KimiAdapterShape;
  });
}
