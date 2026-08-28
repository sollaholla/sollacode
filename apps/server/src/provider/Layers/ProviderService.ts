/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern).
 *
 * @module ProviderServiceLive
 */
import * as NodeCrypto from "node:crypto";

import {
  isAgentBuilderThreadId,
  type MessageId,
  EventId,
  ModelSelection,
  NonNegativeInt,
  ProviderPendingContextRecovery,
  ThreadId,
  ProviderInterruptTurnInput,
  ProviderPromoteQueuedTurnInput,
  ProviderStopTaskInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import {
  increment,
  providerMetricAttributes,
  providerRuntimeEventsTotal,
  providerSessionsTotal,
  providerTurnDuration,
  providerTurnsTotal,
  providerTurnMetricAttributes,
  withMetrics,
} from "../../observability/Metrics.ts";
import {
  type ProviderAdapterError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import { withSideChatAgentContext } from "../sideChatContext.ts";
import { withVmAgentContext } from "../vmAgentContext.ts";
import { VmAgentStore } from "../../persistence/Services/VmAgents.ts";
const isModelSelection = Schema.is(ModelSelection);
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderPendingContextRecovery = Schema.is(ProviderPendingContextRecovery);
const isSessionGenerationPayload = Schema.is(Schema.Struct({ sessionGeneration: Schema.String }));

function isLocalProviderResumeTimeout(error: unknown): boolean {
  return (
    isProviderAdapterRequestError(error) &&
    error.failureKind === "local-control-timeout" &&
    error.method === "thread/resume"
  );
}

function causeContainsLocalProviderResumeTimeout(cause: Cause.Cause<unknown>): boolean {
  return cause.reasons.some(
    (reason) => Cause.isFailReason(reason) && isLocalProviderResumeTimeout(reason.error),
  );
}

function pendingContextRecoveryIdentityMatches(
  left: ProviderPendingContextRecovery,
  right: ProviderPendingContextRecovery,
): boolean {
  return (
    left.version === right.version &&
    left.kind === right.kind &&
    left.providerInstanceId === right.providerInstanceId &&
    left.createdAt === right.createdAt
  );
}

function pendingContextRecoveriesMatch(
  left: ProviderPendingContextRecovery,
  right: ProviderPendingContextRecovery,
): boolean {
  return (
    pendingContextRecoveryIdentityMatches(left, right) &&
    left.sourceMessageId === right.sourceMessageId
  );
}

function forkResumeCursor(provider: ProviderDriverKind, value: unknown): unknown | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const cursor = value as Record<string, unknown>;
  switch (provider) {
    case "claudeAgent":
      return { ...cursor, forkSession: true };
    case "codex":
    case "opencode":
    case "cursor":
    case "grok":
      return { ...cursor, fork: true };
    default:
      return undefined;
  }
}

function isPendingForkResumeCursor(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const cursor = value as Record<string, unknown>;
  return cursor.fork === true || cursor.forkSession === true;
}

/**
 * Hook for tests that want to override the canonical event logger pulled
 * from `ProviderEventLoggers`. Production wiring leaves this undefined and
 * reads the logger off the tag.
 */
export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogger?: EventNdjsonLogger;
}

type ProviderServiceMethod<Name extends keyof ProviderService.ProviderService["Service"]> =
  ProviderService.ProviderService["Service"][Name];

const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
});

function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) => {
  const decodeProviderRequestInput = Schema.decodeUnknownEffect(input.schema);
  return decodeProviderRequestInput(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );
};

function toRuntimeStatus(session: ProviderSession): "starting" | "running" | "stopped" | "error" {
  switch (session.status) {
    case "connecting":
      return "starting";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    case "running":
    default:
      return "running";
  }
}

function toRuntimePayloadFromSession(
  session: ProviderSession,
  extra?: {
    readonly modelSelection?: unknown;
    readonly lastRuntimeEvent?: string;
    readonly lastRuntimeEventAt?: string;
    readonly clearPendingContextRecovery?: boolean;
    readonly sessionGeneration?: string;
  },
): Record<string, unknown> {
  return {
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    ...(session.pendingContextRecovery !== undefined
      ? { pendingContextRecovery: session.pendingContextRecovery }
      : extra?.clearPendingContextRecovery === true
        ? { pendingContextRecovery: null }
        : {}),
    ...(extra?.modelSelection !== undefined ? { modelSelection: extra.modelSelection } : {}),
    ...(extra?.lastRuntimeEvent !== undefined ? { lastRuntimeEvent: extra.lastRuntimeEvent } : {}),
    ...(extra?.lastRuntimeEventAt !== undefined
      ? { lastRuntimeEventAt: extra.lastRuntimeEventAt }
      : {}),
    ...(extra?.sessionGeneration !== undefined
      ? { sessionGeneration: extra.sessionGeneration }
      : {}),
  };
}

function readSessionGeneration(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): string | null {
  if (!isSessionGenerationPayload(runtimePayload)) return null;
  const generation = runtimePayload.sessionGeneration.trim();
  return generation.length > 0 ? generation : null;
}

function readPersistedModelSelection(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): ModelSelection | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw = "modelSelection" in runtimePayload ? runtimePayload.modelSelection : undefined;
  return isModelSelection(raw) ? raw : undefined;
}

function readPersistedCwd(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const rawCwd = "cwd" in runtimePayload ? runtimePayload.cwd : undefined;
  if (typeof rawCwd !== "string") return undefined;
  const trimmed = rawCwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readPendingContextRecovery(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
  expectedProviderInstanceId?: ProviderInstanceId,
): ProviderPendingContextRecovery | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw =
    "pendingContextRecovery" in runtimePayload ? runtimePayload.pendingContextRecovery : undefined;
  if (!isProviderPendingContextRecovery(raw)) return undefined;
  if (
    expectedProviderInstanceId !== undefined &&
    raw.providerInstanceId !== expectedProviderInstanceId
  ) {
    return undefined;
  }
  return raw;
}

const dieOnMissingBindingInstanceId = (
  operation: string,
  payload: {
    readonly providerInstanceId?: ProviderInstanceId | undefined;
    readonly provider?: ProviderDriverKind | undefined;
  },
): ProviderInstanceId => {
  if (payload.providerInstanceId !== undefined) {
    return payload.providerInstanceId;
  }
  throw new Error(
    payload.provider
      ? `${operation}: provider instance id is required for provider '${payload.provider}'.`
      : `${operation}: provider instance id is required.`,
  );
};

const correlateRuntimeEventWithInstance = (
  source: {
    readonly instanceId: ProviderInstanceId;
    readonly provider: ProviderDriverKind;
  },
  event: ProviderRuntimeEvent,
): ProviderRuntimeEvent => {
  if (event.provider !== source.provider) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' is backed by driver '${source.provider}' but emitted driver '${event.provider}'.`,
    );
  }
  if (event.providerInstanceId !== undefined && event.providerInstanceId !== source.instanceId) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' emitted event for instance '${event.providerInstanceId}'.`,
    );
  }
  return { ...event, providerInstanceId: source.instanceId };
};

const makeProviderService = Effect.fn("makeProviderService")(function* (
  options?: ProviderServiceLiveOptions,
) {
  const analytics = yield* Effect.service(AnalyticsService.AnalyticsService);
  const eventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
  // Options-provided logger wins (test overrides); otherwise we take whatever
  // the `ProviderEventLoggers` tag exposes — `undefined` means "no canonical
  // log writer is attached", which downstream code already handles as a
  // no-op.
  const canonicalEventLogger = options?.canonicalEventLogger ?? eventLoggers.canonical;

  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistry;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const contextRecoveryLocksRef = yield* SynchronizedRef.make(
    new Map<ThreadId, Semaphore.Semaphore>(),
  );
  const liveSteerLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
  const sessionLifecycleLocksRef = yield* SynchronizedRef.make(
    new Map<ThreadId, Semaphore.Semaphore>(),
  );
  const getThreadSemaphore = <Key>(
    locksRef: SynchronizedRef.SynchronizedRef<Map<Key, Semaphore.Semaphore>>,
    key: Key,
  ) =>
    SynchronizedRef.modifyEffect(locksRef, (current) => {
      const existing = current.get(key);
      if (existing !== undefined) {
        return Effect.succeed([existing, current] as const);
      }
      return Semaphore.make(1).pipe(
        Effect.map((semaphore) => {
          const next = new Map(current);
          next.set(key, semaphore);
          return [semaphore, next] as const;
        }),
      );
    });
  const withContextRecoveryLock = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(getThreadSemaphore(contextRecoveryLocksRef, threadId), (semaphore) =>
      semaphore.withPermit(effect),
    );
  const withLiveSteerLock = <A, E, R>(
    threadId: ThreadId,
    providerInstanceId: ProviderInstanceId,
    effect: Effect.Effect<A, E, R>,
  ) =>
    Effect.flatMap(
      getThreadSemaphore(liveSteerLocksRef, `${threadId}\u0000${providerInstanceId}`),
      (semaphore) => semaphore.withPermit(effect),
    );
  const withSessionLifecycleLock = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(getThreadSemaphore(sessionLifecycleLocksRef, threadId), (semaphore) =>
      semaphore.withPermit(effect),
    );
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const deliveryReceiptPublicationLock = yield* Semaphore.make(1);
  const publishedDeliveryReceiptKeys = new Map<string, true>();
  const maxPublishedDeliveryReceiptKeys = 65_536;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const prepareMcpSession = (threadId: ThreadId, providerInstanceId: ProviderInstanceId) =>
    Effect.gen(function* () {
      const previous = McpProviderSession.readMcpProviderSession(threadId);
      if (previous) {
        yield* McpSessionRegistry.revokeActiveMcpProviderSession(previous.providerSessionId);
        McpProviderSession.clearMcpProviderSession(threadId);
      }
      // Only a custom agent's own thread gets the "vm" capability (historical
      // name) — it marks the thread as agent-owned and gates agent_workspace
      // and workspace_consult. VmAgentStore is optional (absent in unit
      // tests, where no thread is an agent anyway).
      const isVmAgent = yield* Option.match(yield* Effect.serviceOption(VmAgentStore), {
        onNone: () => Effect.succeed(false),
        onSome: (store) =>
          store.getByThreadId(threadId).pipe(
            Effect.map(Option.isSome),
            Effect.orElseSucceed(() => false),
          ),
      });
      // Agent Builder chats are identified by their thread-id prefix; only they
      // get the agent-builder capability, so the tool that creates and deletes
      // whole agents is unreachable from every other chat.
      const extraCapabilities = [
        ...(isVmAgent ? ["vm" as const] : []),
        ...(isAgentBuilderThreadId(threadId) ? ["agent-builder" as const] : []),
      ];
      const credential = yield* McpSessionRegistry.issueActiveMcpCredential({
        threadId,
        providerInstanceId,
        ...(extraCapabilities.length > 0
          ? {
              capabilities: new Set([
                ...McpSessionRegistry.DEFAULT_MCP_CAPABILITIES,
                ...extraCapabilities,
              ]),
            }
          : {}),
      });
      if (credential) {
        McpProviderSession.setMcpProviderSession(credential.config);
      }
      return credential;
    });
  const clearMcpSession = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const current = McpProviderSession.readMcpProviderSession(threadId);
      if (current) {
        yield* McpSessionRegistry.revokeActiveMcpProviderSession(current.providerSessionId);
      }
      McpProviderSession.clearMcpProviderSession(threadId);
    });

  const publishRuntimeEventUnchecked = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Effect.succeed(event).pipe(
      Effect.tap((canonicalEvent) =>
        canonicalEventLogger
          ? canonicalEventLogger.write(canonicalEvent, canonicalEvent.threadId)
          : Effect.void,
      ),
      Effect.flatMap((canonicalEvent) => PubSub.publish(runtimeEventPubSub, canonicalEvent)),
      Effect.asVoid,
    );

  const publishRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> => {
    if (event.type !== "message.delivered") return publishRuntimeEventUnchecked(event);
    const key = `${event.providerInstanceId ?? event.provider}\u0000${event.threadId}\u0000${event.payload.messageId}`;
    return deliveryReceiptPublicationLock.withPermit(
      Effect.gen(function* () {
        if (publishedDeliveryReceiptKeys.has(key)) return;
        yield* publishRuntimeEventUnchecked(event);
        publishedDeliveryReceiptKeys.set(key, true);
        if (publishedDeliveryReceiptKeys.size <= maxPublishedDeliveryReceiptKeys) return;
        const oldest = publishedDeliveryReceiptKeys.keys().next();
        if (!oldest.done) publishedDeliveryReceiptKeys.delete(oldest.value);
      }),
    );
  };

  const requireBindingInstanceId = (
    operation: string,
    payload: {
      readonly providerInstanceId?: ProviderInstanceId | undefined;
      readonly provider?: ProviderDriverKind | undefined;
    },
  ): Effect.Effect<ProviderInstanceId, ProviderValidationError> =>
    payload.providerInstanceId !== undefined
      ? Effect.succeed(payload.providerInstanceId)
      : Effect.fail(
          toValidationError(
            operation,
            payload.provider
              ? `Provider instance id is required for provider '${payload.provider}'.`
              : "Provider instance id is required.",
          ),
        );

  const persistPendingContextRecovery = Effect.fn("persistPendingContextRecovery")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly provider: ProviderDriverKind;
      readonly providerInstanceId: ProviderInstanceId;
      readonly runtimeMode: ProviderSession["runtimeMode"];
      readonly cwd?: string | undefined;
      readonly modelSelection?: ModelSelection | undefined;
      readonly sourceMessageId: MessageId | null;
      readonly existing?: ProviderPendingContextRecovery | undefined;
    }) {
      const pendingContextRecovery =
        input.existing?.providerInstanceId === input.providerInstanceId
          ? input.existing
          : {
              version: 1 as const,
              kind: "native-resume-timeout" as const,
              sourceMessageId: input.sourceMessageId,
              providerInstanceId: input.providerInstanceId,
              createdAt: yield* nowIso,
            };
      yield* directory.upsert({
        threadId: input.threadId,
        provider: input.provider,
        providerInstanceId: input.providerInstanceId,
        runtimeMode: input.runtimeMode,
        resumeCursor: null,
        runtimePayload: {
          pendingContextRecovery,
          ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
          ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
        },
      });
      return pendingContextRecovery;
    },
  );

  const requireLiveSteerTarget = Effect.fn("requireLiveSteerTarget")(function* (input: {
    readonly threadId: ThreadId;
    readonly liveSteerTarget?: ProviderSendTurnInput["liveSteerTarget"];
  }) {
    const target = input.liveSteerTarget;
    if (target === undefined) return;

    const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
    if (binding?.providerInstanceId !== target.providerInstanceId) {
      return yield* new ProviderAdapterRequestError({
        provider: binding?.provider ?? String(target.providerInstanceId),
        method: "turn/steer",
        detail: `Live steer target '${target.providerInstanceId}/${target.activeTurnId}' no longer matches the provider binding for thread '${input.threadId}'.`,
      });
    }

    const adapter = yield* registry.getByInstance(target.providerInstanceId);
    const liveSession = (yield* adapter.listSessions()).find(
      (session) => session.threadId === input.threadId,
    );
    if (liveSession?.status !== "running" || liveSession.activeTurnId !== target.activeTurnId) {
      return yield* new ProviderAdapterRequestError({
        provider: adapter.provider,
        method: "turn/steer",
        detail: `Live steer target '${target.activeTurnId}' is no longer the active turn for thread '${input.threadId}'.`,
      });
    }
  });

  const requireMatchingContextRecovery = Effect.fn("requireMatchingContextRecovery")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly messageId?: MessageId | undefined;
      readonly contextRecovery?: ProviderPendingContextRecovery | undefined;
      readonly liveSteerTarget?: ProviderSendTurnInput["liveSteerTarget"];
    }) {
      const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
      let pendingContextRecovery = readPendingContextRecovery(binding?.runtimePayload);
      if (
        pendingContextRecovery !== undefined &&
        pendingContextRecovery.providerInstanceId !== binding?.providerInstanceId
      ) {
        if (binding?.providerInstanceId !== undefined) {
          yield* directory.upsert({
            threadId: input.threadId,
            provider: binding.provider,
            providerInstanceId: binding.providerInstanceId,
            runtimeMode: binding.runtimeMode ?? "full-access",
            runtimePayload: { pendingContextRecovery: null },
          });
        }
        pendingContextRecovery = undefined;
      }
      if (pendingContextRecovery !== undefined) {
        if (binding === undefined) {
          return yield* toValidationError(
            "ProviderService.sendTurn",
            "A pending context recovery requires a persisted provider binding.",
          );
        }
        const contextRecoveryIdentityMatches =
          input.contextRecovery !== undefined &&
          pendingContextRecoveryIdentityMatches(input.contextRecovery, pendingContextRecovery);
        const suppliedMarkerIsCurrent =
          input.contextRecovery !== undefined &&
          pendingContextRecoveriesMatch(input.contextRecovery, pendingContextRecovery);
        const suppliedMarkerIsClaimEcho =
          contextRecoveryIdentityMatches &&
          input.messageId !== undefined &&
          pendingContextRecovery.sourceMessageId === input.messageId;
        if (input.liveSteerTarget !== undefined) {
          // The bounded handoff already owns the running turn. New human input
          // targets that turn through the adapter's native steer API; making it
          // repeat (or wait behind) the recovery handoff defeats steering. The
          // exact provider and turn were checked immediately before this call.
          return undefined;
        }
        if (
          input.messageId === undefined ||
          (!suppliedMarkerIsCurrent && !suppliedMarkerIsClaimEcho)
        ) {
          return yield* new ProviderAdapterRequestError({
            provider: binding.provider,
            method: "thread/context-recovery",
            detail:
              "A timed-out native resume requires its exact bounded context-recovery handoff before raw input can be sent.",
          });
        }
        if (pendingContextRecovery.sourceMessageId !== input.messageId) {
          const claimedContextRecovery = {
            ...pendingContextRecovery,
            sourceMessageId: input.messageId,
          };
          yield* directory.upsert({
            threadId: input.threadId,
            provider: binding.provider,
            providerInstanceId: pendingContextRecovery.providerInstanceId,
            runtimeMode: binding.runtimeMode ?? "full-access",
            runtimePayload: { pendingContextRecovery: claimedContextRecovery },
          });
          return claimedContextRecovery;
        }
        return pendingContextRecovery;
      } else if (input.contextRecovery !== undefined) {
        const isSupersedingBoundedHandoff =
          input.messageId !== undefined &&
          input.contextRecovery.sourceMessageId !== null &&
          input.messageId !== input.contextRecovery.sourceMessageId &&
          binding?.providerInstanceId === input.contextRecovery.providerInstanceId;
        if (!isSupersedingBoundedHandoff) {
          return yield* toValidationError(
            "ProviderService.sendTurn",
            "The supplied context-recovery handoff is no longer pending.",
          );
        }
      }
      return undefined;
    },
  );

  const upsertSessionBinding = (
    session: ProviderSession,
    threadId: ThreadId,
    extra?: {
      readonly modelSelection?: unknown;
      readonly lastRuntimeEvent?: string;
      readonly lastRuntimeEventAt?: string;
      readonly clearPendingContextRecovery?: boolean;
      readonly sessionGeneration?: string;
    },
  ) =>
    Effect.gen(function* () {
      const providerInstanceId = yield* requireBindingInstanceId(
        "ProviderService.upsertSessionBinding",
        session,
      );
      yield* directory.upsert({
        threadId,
        provider: session.provider,
        providerInstanceId,
        runtimeMode: session.runtimeMode,
        status: toRuntimeStatus(session),
        ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
        runtimePayload: toRuntimePayloadFromSession(session, extra),
      });
    });

  const processRuntimeEvent = (
    source: {
      readonly instanceId: ProviderInstanceId;
      readonly provider: ProviderDriverKind;
    },
    event: ProviderRuntimeEvent,
  ): Effect.Effect<void> =>
    Effect.sync(() => correlateRuntimeEventWithInstance(source, event)).pipe(
      Effect.flatMap((canonicalEvent) =>
        increment(providerRuntimeEventsTotal, {
          provider: canonicalEvent.provider,
          eventType: canonicalEvent.type,
        }).pipe(Effect.andThen(publishRuntimeEvent(canonicalEvent))),
      ),
    );

  // `subscribedAdapters` is our source-of-truth for "which instance adapters
  // are currently wired into the runtime event bus". It both tracks the set
  // of live subscriptions (so `reconcileInstanceSubscriptions` can diff and
  // fork only the *new* or *rebuilt* ones) and serves as the dynamic adapter
  // list consumed by `stopStaleSessionsForThread`, `listSessions`, and
  // `runStopAll` — replacing the pre-Slice-D startup snapshot so hot-added
  // instances become visible to those call sites as soon as settings edits
  // land.
  const subscribedAdapters = yield* Ref.make(
    new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>(),
  );

  const getAdapterEntries = Ref.get(subscribedAdapters).pipe(
    Effect.map((map) => Array.from(map.entries())),
  );

  // Rebuild the map of id → adapter from the registry and fork a new event
  // subscription for every instance that is either brand new or whose adapter
  // identity changed (indicating the underlying `ProviderInstance` was torn
  // down and rebuilt by `ProviderInstanceRegistry.reconcile`). Orphaned
  // fibers for removed/replaced instances exit on their own because their
  // adapter's `streamEvents` source terminates when the old scope closes.
  const reconcileInstanceSubscriptions = Effect.gen(function* () {
    const previous = yield* Ref.get(subscribedAdapters);
    const currentIds = yield* registry.listInstances();
    const next = new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>();
    for (const id of currentIds) {
      const adapterOption = yield* registry
        .getByInstance(id)
        .pipe(Effect.tapError(Effect.logWarning), Effect.option);
      if (Option.isNone(adapterOption)) continue;
      const adapter = adapterOption.value;
      next.set(id, adapter);
      if (previous.get(id) !== adapter) {
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          processRuntimeEvent(
            {
              instanceId: id,
              provider: adapter.provider,
            },
            event,
          ),
        ).pipe(Effect.forkScoped);
      }
    }
    yield* Ref.set(subscribedAdapters, next);
  });

  const instanceChanges = yield* registry.subscribeChanges;
  yield* reconcileInstanceSubscriptions;
  yield* Stream.runForEach(
    Stream.fromSubscription(instanceChanges),
    () => reconcileInstanceSubscriptions,
  ).pipe(Effect.forkScoped);

  type RecoverSessionForThreadInput = {
    readonly binding: ProviderSessionDirectory.ProviderRuntimeBinding;
    readonly operation: string;
    readonly sourceMessageId?: MessageId | null | undefined;
  };
  const recoverSessionForThreadUnlocked = Effect.fn("recoverSessionForThreadUnlocked")(function* (
    input: RecoverSessionForThreadInput,
  ) {
    const bindingInstanceId = yield* requireBindingInstanceId(input.operation, input.binding);
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "recover-session",
      "provider.kind": input.binding.provider,
      "provider.instance_id": bindingInstanceId,
      "provider.thread_id": input.binding.threadId,
    });
    return yield* Effect.gen(function* () {
      const adapter = yield* registry.getByInstance(bindingInstanceId);
      const pendingContextRecovery = readPendingContextRecovery(
        input.binding.runtimePayload,
        bindingInstanceId,
      );
      const hasResumeCursor =
        input.binding.resumeCursor !== null && input.binding.resumeCursor !== undefined;
      const hasActiveSession = yield* adapter.hasSession(input.binding.threadId);
      if (hasActiveSession) {
        const activeSessions = yield* adapter.listSessions();
        const existing = activeSessions.find(
          (session) => session.threadId === input.binding.threadId,
        );
        if (existing) {
          const existingWithBinding = {
            ...existing,
            providerInstanceId: bindingInstanceId,
            ...(pendingContextRecovery !== undefined ? { pendingContextRecovery } : {}),
          };
          yield* upsertSessionBinding(existingWithBinding, input.binding.threadId, {
            sessionGeneration: NodeCrypto.randomUUID(),
          });
          yield* analytics.record("provider.session.recovered", {
            provider: existing.provider,
            strategy: "adopt-existing",
            hasResumeCursor: existing.resumeCursor !== undefined,
          });
          return { adapter, session: existingWithBinding } as const;
        }
      }

      const persistedCwd = readPersistedCwd(input.binding.runtimePayload);
      const persistedModelSelection = readPersistedModelSelection(input.binding.runtimePayload);
      if (!hasResumeCursor && persistedCwd === undefined) {
        return yield* toValidationError(
          input.operation,
          `Cannot recover thread '${input.binding.threadId}' because no provider resume state is persisted.`,
        );
      }

      const startRecoveredSession = (resumeCursor: unknown | undefined) =>
        adapter
          .startSession({
            threadId: input.binding.threadId,
            provider: input.binding.provider,
            providerInstanceId: bindingInstanceId,
            ...(persistedCwd ? { cwd: persistedCwd } : {}),
            ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
            ...(resumeCursor !== undefined && resumeCursor !== null ? { resumeCursor } : {}),
            runtimeMode: input.binding.runtimeMode ?? "full-access",
          })
          .pipe(Effect.onError(() => clearMcpSession(input.binding.threadId)));

      yield* prepareMcpSession(input.binding.threadId, bindingInstanceId);
      const resumed = hasResumeCursor
        ? yield* startRecoveredSession(input.binding.resumeCursor).pipe(
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) {
                return Effect.failCause(cause);
              }
              if (causeContainsLocalProviderResumeTimeout(cause)) {
                return persistPendingContextRecovery({
                  threadId: input.binding.threadId,
                  provider: input.binding.provider,
                  providerInstanceId: bindingInstanceId,
                  runtimeMode: input.binding.runtimeMode ?? "full-access",
                  ...(persistedCwd !== undefined ? { cwd: persistedCwd } : {}),
                  ...(persistedModelSelection !== undefined
                    ? { modelSelection: persistedModelSelection }
                    : {}),
                  sourceMessageId: input.sourceMessageId ?? null,
                  ...(pendingContextRecovery !== undefined
                    ? { existing: pendingContextRecovery }
                    : {}),
                }).pipe(Effect.andThen(Effect.failCause(cause)));
              }
              if (persistedCwd === undefined) {
                return Effect.failCause(cause);
              }
              return Effect.logWarning(
                "provider.session.recover-resume-failed; starting a fresh session",
                {
                  threadId: input.binding.threadId,
                  provider: input.binding.provider,
                  errorTag: causeErrorTag(cause),
                },
              ).pipe(Effect.flatMap(() => startRecoveredSession(undefined)));
            }),
          )
        : yield* startRecoveredSession(undefined);
      if (resumed.provider !== adapter.provider) {
        yield* clearMcpSession(input.binding.threadId);
        return yield* toValidationError(
          input.operation,
          `Adapter/provider mismatch while recovering thread '${input.binding.threadId}'. Expected '${adapter.provider}', received '${resumed.provider}'.`,
        );
      }

      const resumedWithBinding = {
        ...resumed,
        providerInstanceId: bindingInstanceId,
        ...(pendingContextRecovery !== undefined ? { pendingContextRecovery } : {}),
      };
      yield* upsertSessionBinding(resumedWithBinding, input.binding.threadId, {
        sessionGeneration: NodeCrypto.randomUUID(),
      });
      yield* analytics.record("provider.session.recovered", {
        provider: resumed.provider,
        strategy: "resume-thread",
        hasResumeCursor: resumed.resumeCursor !== undefined,
      });
      return { adapter, session: resumedWithBinding } as const;
    }).pipe(
      withMetrics({
        counter: providerSessionsTotal,
        attributes: providerMetricAttributes(input.binding.provider, {
          operation: "recover",
        }),
      }),
    );
  });
  const recoverSessionForThread = Effect.fn("recoverSessionForThread")(function* (
    input: RecoverSessionForThreadInput,
  ) {
    return yield* withSessionLifecycleLock(
      input.binding.threadId,
      Effect.gen(function* () {
        // Route resolution happens before this lifecycle lock is acquired. A
        // provider switch may win the lock in between, so never resurrect the
        // captured route after waiting: recover whichever binding is current
        // at the protected boundary.
        const currentBinding = Option.getOrUndefined(
          yield* directory.getBinding(input.binding.threadId),
        );
        if (currentBinding === undefined) {
          return yield* toValidationError(
            input.operation,
            `Cannot recover thread '${input.binding.threadId}' because its provider binding no longer exists.`,
          );
        }
        return yield* recoverSessionForThreadUnlocked({
          ...input,
          binding: currentBinding,
        });
      }),
    );
  });

  const resolveRoutableSession = Effect.fn("resolveRoutableSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly operation: string;
    readonly allowRecovery: boolean;
    readonly sourceMessageId?: MessageId | null | undefined;
  }) {
    const bindingOption = yield* directory.getBinding(input.threadId);
    const binding = Option.getOrUndefined(bindingOption);
    if (!binding) {
      return yield* toValidationError(
        input.operation,
        `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
      );
    }
    const instanceId = yield* requireBindingInstanceId(input.operation, binding);
    const adapter = yield* registry.getByInstance(instanceId);

    const hasRequestedSession = yield* adapter.hasSession(input.threadId);
    if (hasRequestedSession) {
      return {
        adapter,
        instanceId,
        threadId: input.threadId,
        isActive: true,
      } as const;
    }

    if (!input.allowRecovery) {
      return {
        adapter,
        instanceId,
        threadId: input.threadId,
        isActive: false,
      } as const;
    }

    const recovered = yield* recoverSessionForThread({
      binding,
      operation: input.operation,
      ...(input.sourceMessageId !== undefined ? { sourceMessageId: input.sourceMessageId } : {}),
    });
    const recoveredInstanceId = yield* requireBindingInstanceId(input.operation, recovered.session);
    return {
      adapter: recovered.adapter,
      instanceId: recoveredInstanceId,
      threadId: input.threadId,
      isActive: true,
    } as const;
  });

  const stopStaleSessionsForThread = Effect.fn("stopStaleSessionsForThread")(function* (input: {
    readonly threadId: ThreadId;
    readonly currentInstanceId: ProviderInstanceId;
  }) {
    const currentAdapters = yield* getAdapterEntries;
    yield* Effect.forEach(
      currentAdapters,
      ([instanceId, adapter]) =>
        instanceId === input.currentInstanceId
          ? Effect.void
          : Effect.gen(function* () {
              const hasSession = yield* adapter.hasSession(input.threadId);
              if (!hasSession) {
                return;
              }

              yield* adapter.stopSession(input.threadId).pipe(
                Effect.tap(() =>
                  analytics.record("provider.session.stopped", {
                    provider: adapter.provider,
                  }),
                ),
                Effect.catchCause((cause) =>
                  Effect.logWarning("provider.session.stop-stale-failed", {
                    threadId: input.threadId,
                    provider: adapter.provider,
                    cause,
                  }),
                ),
              );
            }),
      { discard: true },
    );
  });

  const startSessionUnlocked: ProviderServiceMethod<"startSession"> = Effect.fn(
    "startSessionUnlocked",
  )(function* (threadId, rawInput) {
    const parsed = yield* decodeInputOrValidationError({
      operation: "ProviderService.startSession",
      schema: ProviderSessionStartInput,
      payload: rawInput,
    });

    const resolvedInstanceId = yield* requireBindingInstanceId(
      "ProviderService.startSession",
      parsed,
    );
    let metricProvider = parsed.provider ?? String(resolvedInstanceId);
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "start-session",
      "provider.instance_id": resolvedInstanceId,
      "provider.thread_id": threadId,
      "provider.runtime_mode": parsed.runtimeMode,
    });
    return yield* Effect.gen(function* () {
      const instanceInfo = yield* registry.getInstanceInfo(resolvedInstanceId);
      const resolvedProvider = instanceInfo.driverKind;
      metricProvider = resolvedProvider;
      if (parsed.provider !== undefined && parsed.provider !== resolvedProvider) {
        return yield* toValidationError(
          "ProviderService.startSession",
          `Provider instance '${resolvedInstanceId}' belongs to driver '${resolvedProvider}', not '${parsed.provider}'.`,
        );
      }
      const input = {
        ...parsed,
        threadId,
        provider: resolvedProvider,
      };
      if (!instanceInfo.enabled) {
        return yield* toValidationError(
          "ProviderService.startSession",
          `Provider instance '${resolvedInstanceId}' is disabled in Solla Code settings.`,
        );
      }
      const persistedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      // `undefined` means the caller did not choose, so the durable binding is
      // eligible for reuse. `null` is the explicit fresh-session sentinel: a
      // failed native resume must be able to replace an unusable cursor rather
      // than immediately inheriting it again from this directory.
      const effectiveResumeCursor =
        input.resumeCursor !== undefined
          ? input.resumeCursor
          : persistedBinding?.providerInstanceId === resolvedInstanceId
            ? persistedBinding.resumeCursor
            : undefined;
      const effectiveCwd =
        input.cwd ??
        (persistedBinding?.providerInstanceId === resolvedInstanceId
          ? readPersistedCwd(persistedBinding.runtimePayload)
          : undefined);
      const persistedPendingContextRecovery =
        persistedBinding?.providerInstanceId === resolvedInstanceId
          ? readPendingContextRecovery(persistedBinding.runtimePayload, resolvedInstanceId)
          : undefined;
      const pendingContextRecovery =
        input.resumeCursor === null
          ? yield* persistPendingContextRecovery({
              threadId,
              provider: resolvedProvider,
              providerInstanceId: resolvedInstanceId,
              runtimeMode: input.runtimeMode,
              ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
              ...(input.modelSelection !== undefined
                ? { modelSelection: input.modelSelection }
                : {}),
              sourceMessageId: null,
              ...(persistedPendingContextRecovery !== undefined
                ? { existing: persistedPendingContextRecovery }
                : {}),
            })
          : persistedPendingContextRecovery;
      yield* Effect.annotateCurrentSpan({
        "provider.kind": resolvedProvider,
        "provider.resume_cursor.source":
          input.resumeCursor !== undefined
            ? "request"
            : effectiveResumeCursor !== undefined &&
                persistedBinding?.providerInstanceId === resolvedInstanceId
              ? "persisted"
              : "none",
        "provider.resume_cursor.present":
          effectiveResumeCursor !== undefined && effectiveResumeCursor !== null,
        "provider.cwd.source":
          input.cwd !== undefined
            ? "request"
            : effectiveCwd !== undefined &&
                persistedBinding?.providerInstanceId === resolvedInstanceId
              ? "persisted"
              : "none",
        "provider.cwd.effective": effectiveCwd ?? "",
      });
      const adapter = yield* registry.getByInstance(resolvedInstanceId);
      // Stop the previous provider first. If both are live, listSessions used
      // to treat that as fatal and every thread's turn start died with it.
      yield* stopStaleSessionsForThread({
        threadId,
        currentInstanceId: resolvedInstanceId,
      });
      yield* prepareMcpSession(threadId, resolvedInstanceId);
      const { resumeCursor: _requestedResumeCursor, ...adapterInput } = input;
      const session = yield* adapter
        .startSession({
          ...adapterInput,
          providerInstanceId: resolvedInstanceId,
          ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
          ...(effectiveResumeCursor !== undefined && effectiveResumeCursor !== null
            ? { resumeCursor: effectiveResumeCursor }
            : {}),
        })
        .pipe(
          Effect.tapError((error) =>
            isLocalProviderResumeTimeout(error)
              ? persistPendingContextRecovery({
                  threadId,
                  provider: resolvedProvider,
                  providerInstanceId: resolvedInstanceId,
                  runtimeMode: input.runtimeMode,
                  ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
                  ...(input.modelSelection !== undefined
                    ? { modelSelection: input.modelSelection }
                    : {}),
                  sourceMessageId: null,
                  ...(pendingContextRecovery !== undefined
                    ? { existing: pendingContextRecovery }
                    : {}),
                })
              : Effect.void,
          ),
          Effect.onError(() => clearMcpSession(threadId)),
        );

      if (session.provider !== adapter.provider) {
        yield* clearMcpSession(threadId);
        return yield* toValidationError(
          "ProviderService.startSession",
          `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
        );
      }
      const sessionWithInstance = {
        ...session,
        providerInstanceId: resolvedInstanceId,
        ...(pendingContextRecovery !== undefined ? { pendingContextRecovery } : {}),
      };

      yield* upsertSessionBinding(sessionWithInstance, threadId, {
        modelSelection: input.modelSelection,
        sessionGeneration: NodeCrypto.randomUUID(),
        clearPendingContextRecovery:
          persistedBinding !== undefined &&
          (persistedBinding.providerInstanceId !== resolvedInstanceId ||
            persistedBinding.provider !== resolvedProvider),
      });
      yield* analytics.record("provider.session.started", {
        provider: sessionWithInstance.provider,
        runtimeMode: input.runtimeMode,
        hasResumeCursor: sessionWithInstance.resumeCursor !== undefined,
        hasCwd: typeof effectiveCwd === "string" && effectiveCwd.trim().length > 0,
        hasModel:
          typeof input.modelSelection?.model === "string" &&
          input.modelSelection.model.trim().length > 0,
      });

      return sessionWithInstance;
    }).pipe(
      withMetrics({
        counter: providerSessionsTotal,
        attributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "start",
          }),
      }),
    );
  });
  const matchingSessionAfterLifecycleRace = Effect.fn("matchingSessionAfterLifecycleRace")(
    function* (threadId: ThreadId, rawInput: ProviderSessionStartInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.startSession",
        schema: ProviderSessionStartInput,
        payload: rawInput,
      });
      const providerInstanceId = yield* requireBindingInstanceId(
        "ProviderService.startSession",
        input,
      );
      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      if (binding?.providerInstanceId !== providerInstanceId) return undefined;

      const adapter = yield* registry.getByInstance(providerInstanceId);
      if (
        binding.provider !== adapter.provider ||
        (input.provider !== undefined && input.provider !== adapter.provider)
      ) {
        return undefined;
      }
      const session = (yield* adapter.listSessions()).find(
        (candidate) => candidate.threadId === threadId,
      );
      if (
        session === undefined ||
        session.status === "closed" ||
        session.status === "error" ||
        session.runtimeMode !== input.runtimeMode
      ) {
        return undefined;
      }

      const effectiveCwd = input.cwd ?? readPersistedCwd(binding.runtimePayload);
      if (session.cwd !== effectiveCwd) return undefined;
      if (
        input.modelSelection !== undefined &&
        !Equal.equals(readPersistedModelSelection(binding.runtimePayload), input.modelSelection)
      ) {
        return undefined;
      }
      if (session.status === "running") {
        return yield* new ProviderAdapterRequestError({
          provider: adapter.provider,
          method: "session/start",
          detail: `A matching replacement session for thread '${threadId}' started a turn while lifecycle work was waiting; retry without restarting it.`,
        });
      }

      const pendingContextRecovery = readPendingContextRecovery(
        binding.runtimePayload,
        providerInstanceId,
      );
      const { pendingContextRecovery: _sessionPendingContextRecovery, ...sessionWithoutPending } =
        session;
      return {
        ...sessionWithoutPending,
        providerInstanceId,
        ...(pendingContextRecovery !== undefined ? { pendingContextRecovery } : {}),
      };
    },
  );
  const startSession: ProviderServiceMethod<"startSession"> = (threadId, input, options) =>
    withSessionLifecycleLock(
      threadId,
      options?.reuseMatchingSession === true && input.resumeCursor !== null
        ? matchingSessionAfterLifecycleRace(threadId, input).pipe(
            Effect.flatMap((matching) =>
              matching !== undefined
                ? Effect.succeed(matching)
                : startSessionUnlocked(threadId, input),
            ),
          )
        : startSessionUnlocked(threadId, input),
    );

  const sendTurn: ProviderServiceMethod<"sendTurn"> = Effect.fn("sendTurn")(
    function* (rawInput, sendOptions) {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderService.sendTurn",
        schema: ProviderSendTurnInput,
        payload: rawInput,
      });
      if (parsed.contextRecovery !== undefined && parsed.liveSteerTarget !== undefined) {
        return yield* toValidationError(
          "ProviderService.sendTurn",
          "A turn cannot be both a bounded context-recovery handoff and a live steer.",
        );
      }

      const liveSteerTarget = parsed.liveSteerTarget;
      const nativeDispatchStarted =
        liveSteerTarget === undefined ? undefined : yield* Deferred.make<void>();
      const acknowledgeNativeDispatch =
        nativeDispatchStarted === undefined
          ? undefined
          : Deferred.succeed(nativeDispatchStarted, undefined).pipe(
              Effect.flatMap((firstAcknowledgement) =>
                firstAcknowledgement ? (sendOptions?.onNativeDispatch ?? Effect.void) : Effect.void,
              ),
            );
      const send = Effect.gen(function* () {
        // A VM agent's thread gets its identity and collaborative-browser context
        // (mutually exclusive with side chat). VmAgentStore is optional: absent in
        // unit tests, where no thread is a VM agent anyway.
        const vmAgentIdentity =
          parsed.isSideChat === true
            ? null
            : yield* Option.match(yield* Effect.serviceOption(VmAgentStore), {
                onNone: () => Effect.succeed(null),
                onSome: (store) =>
                  store.getByThreadId(parsed.threadId).pipe(
                    Effect.map(Option.getOrNull),
                    Effect.orElseSucceed(() => null),
                  ),
              });

        const input = {
          ...parsed,
          ...(parsed.isSideChat === true
            ? { input: withSideChatAgentContext(parsed.input) }
            : vmAgentIdentity
              ? { input: withVmAgentContext(parsed.input, vmAgentIdentity) }
              : {}),
          attachments: parsed.attachments ?? [],
        };
        if (!input.input && input.attachments.length === 0) {
          return yield* toValidationError(
            "ProviderService.sendTurn",
            "Either input text or at least one attachment is required",
          );
        }
        yield* requireLiveSteerTarget(input);
        yield* requireMatchingContextRecovery(input);
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "send-turn",
          "provider.thread_id": input.threadId,
          "provider.interaction_mode": input.interactionMode,
          "provider.attachment_count": input.attachments.length,
        });
        let metricProvider = "unknown";
        let metricModel = input.modelSelection?.model;
        return yield* Effect.gen(function* () {
          const routed = yield* resolveRoutableSession({
            threadId: input.threadId,
            operation: "ProviderService.sendTurn",
            allowRecovery: input.liveSteerTarget === undefined,
            sourceMessageId: input.messageId ?? null,
          });
          const sendWithContextRecoveryCheck = Effect.fn("sendWithContextRecoveryCheck")(
            function* (route: {
              readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
              readonly instanceId: ProviderInstanceId;
            }) {
              const { adapter, instanceId } = route;
              // Recovery can persist a handoff marker while resolving the route.
              // Re-read it immediately before every adapter attempt so the same
              // raw request cannot cross that newly-established boundary.
              yield* requireLiveSteerTarget(input);
              const acceptedPendingContextRecovery = yield* requireMatchingContextRecovery(input);
              const bindingBeforeNativeDispatch = Option.getOrUndefined(
                yield* directory.getBinding(input.threadId),
              );
              const bindingStatus = bindingBeforeNativeDispatch?.status;
              if (
                bindingBeforeNativeDispatch?.provider !== adapter.provider ||
                bindingBeforeNativeDispatch.providerInstanceId !== instanceId ||
                bindingStatus === undefined ||
                bindingStatus === "stopped" ||
                bindingStatus === "error"
              ) {
                return yield* new ProviderAdapterRequestError({
                  provider: adapter.provider,
                  method: input.liveSteerTarget === undefined ? "session/prompt" : "turn/steer",
                  detail: `Provider binding changed before native dispatch for thread '${input.threadId}'.`,
                });
              }
              // A SessionNotFound result is known not to have crossed the native
              // admission boundary. Recovery creates a new attempt, so rerun the
              // caller's atomic admission check immediately before that attempt.
              yield* sendOptions?.beforeNativeDispatch ?? Effect.void;
              const admittedSessionGeneration =
                readSessionGeneration(bindingBeforeNativeDispatch.runtimePayload) ?? null;
              yield* Effect.sync(() =>
                sendOptions?.onNativeDispatchRoute?.({
                  providerInstanceId: instanceId,
                  sessionGeneration: admittedSessionGeneration,
                  messageDeliveryReceipts: adapter.capabilities.messageDeliveryReceipts === true,
                }),
              );
              const turn = yield* adapter.sendTurn(
                input,
                acknowledgeNativeDispatch === undefined
                  ? undefined
                  : { onNativeDispatch: acknowledgeNativeDispatch },
              );
              if (
                adapter.capabilities.messageDeliveryReceipts === true &&
                input.messageId !== undefined
              ) {
                // Receipt-capable adapters make successful sendTurn resolution
                // their native acceptance boundary. Publish the exact receipt
                // into ProviderService's canonical stream before returning so a
                // later registry rebuild cannot strand orchestration between an
                // adapter-local queue and durable projection. Adapter-emitted
                // copies are deduplicated by the exact route/message key above.
                yield* publishRuntimeEvent({
                  type: "message.delivered",
                  eventId: EventId.make(
                    `provider-service-delivered:${instanceId}:${input.threadId}:${input.messageId}`,
                  ),
                  provider: adapter.provider,
                  providerInstanceId: instanceId,
                  createdAt: yield* nowIso,
                  threadId: input.threadId,
                  turnId: turn.turnId,
                  payload: { messageId: input.messageId },
                  providerRefs: { providerTurnId: turn.turnId },
                });
              }
              return {
                acceptedPendingContextRecovery,
                bindingBeforeNativeDispatch: {
                  provider: adapter.provider,
                  providerInstanceId: instanceId,
                  status: bindingStatus,
                  sessionGeneration: readSessionGeneration(
                    bindingBeforeNativeDispatch.runtimePayload,
                  ),
                },
                route,
                turn,
              } as const;
            },
          );
          metricProvider = routed.adapter.provider;
          metricModel = input.modelSelection?.model;
          yield* Effect.annotateCurrentSpan({
            "provider.kind": routed.adapter.provider,
            ...(input.modelSelection?.model
              ? { "provider.model": input.modelSelection.model }
              : {}),
          });
          // A turn is the clearest sign a session is still alive. The MCP
          // credential is minted once at session start and cannot be rotated into
          // an already-spawned agent process, so we keep the existing token valid
          // rather than issuing a new one: sessions that go a long time between
          // browser tool calls used to lose the toolkit outright.
          yield* McpSessionRegistry.touchActiveMcpThread(input.threadId);
          const accepted = yield* sendWithContextRecoveryCheck({
            adapter: routed.adapter,
            instanceId: routed.instanceId,
          }).pipe(
            Effect.catchIf(
              (error): error is ProviderAdapterSessionNotFoundError =>
                input.liveSteerTarget === undefined &&
                error._tag === "ProviderAdapterSessionNotFoundError",
              () =>
                Effect.gen(function* () {
                  // After an app restart the adapter map is empty. Recovery may
                  // have just started a session that then vanished (instance
                  // rebuild, failed ACP resume), or hasSession raced a stop.
                  // Recreate once instead of failing the turn as unknown.
                  yield* Effect.logWarning("provider.sendTurn.session-missing; recovering", {
                    threadId: input.threadId,
                    provider: routed.adapter.provider,
                  });
                  const bindingOption = yield* directory.getBinding(input.threadId);
                  const binding = Option.getOrUndefined(bindingOption);
                  if (!binding) {
                    return yield* new ProviderAdapterSessionNotFoundError({
                      provider: routed.adapter.provider,
                      threadId: input.threadId,
                    });
                  }
                  const recovered = yield* recoverSessionForThread({
                    binding,
                    operation: "ProviderService.sendTurn",
                    sourceMessageId: input.messageId ?? null,
                  });
                  const recoveredInstanceId = yield* requireBindingInstanceId(
                    "ProviderService.sendTurn",
                    recovered.session,
                  );
                  return yield* sendWithContextRecoveryCheck({
                    adapter: recovered.adapter,
                    instanceId: recoveredInstanceId,
                  });
                }),
            ),
          );
          const {
            acceptedPendingContextRecovery,
            bindingBeforeNativeDispatch,
            route: acceptedRoute,
            turn,
          } = accepted;
          metricProvider = acceptedRoute.adapter.provider;
          // The adapter has accepted the message. Everything below is bookkeeping:
          // surfacing a persistence or telemetry failure to the caller would make
          // the delivery reactor requeue an already-accepted steer and send it a
          // second time. Log each failure independently and preserve the provider's
          // successful acceptance result.
          yield* directory
            .upsertIfCurrent(
              {
                threadId: input.threadId,
                provider: acceptedRoute.adapter.provider,
                providerInstanceId: acceptedRoute.instanceId,
                status: "running",
                ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
                runtimePayload: {
                  ...(input.modelSelection !== undefined
                    ? { modelSelection: input.modelSelection }
                    : {}),
                  ...(acceptedPendingContextRecovery !== undefined
                    ? { pendingContextRecovery: null }
                    : {}),
                  activeTurnId: turn.turnId,
                  lastRuntimeEvent: "provider.sendTurn",
                  lastRuntimeEventAt: yield* nowIso,
                },
              },
              {
                provider: bindingBeforeNativeDispatch.provider,
                providerInstanceId: bindingBeforeNativeDispatch.providerInstanceId,
                status: bindingBeforeNativeDispatch.status,
                sessionGeneration: bindingBeforeNativeDispatch.sessionGeneration,
              },
            )
            .pipe(
              Effect.flatMap((updated) =>
                updated
                  ? Effect.void
                  : Effect.logWarning(
                      "provider.sendTurn.binding-update-skipped-after-lifecycle-change",
                      {
                        threadId: input.threadId,
                        provider: acceptedRoute.adapter.provider,
                        providerInstanceId: acceptedRoute.instanceId,
                      },
                    ),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("provider.sendTurn.binding-update-failed-after-acceptance", {
                  threadId: input.threadId,
                  provider: acceptedRoute.adapter.provider,
                  cause: Cause.pretty(cause),
                }),
              ),
            );
          yield* analytics
            .record("provider.turn.sent", {
              provider: acceptedRoute.adapter.provider,
              model: input.modelSelection?.model,
              interactionMode: input.interactionMode,
              attachmentCount: input.attachments.length,
              hasInput: typeof input.input === "string" && input.input.trim().length > 0,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("provider.sendTurn.analytics-failed-after-acceptance", {
                  threadId: input.threadId,
                  provider: acceptedRoute.adapter.provider,
                  cause: Cause.pretty(cause),
                }),
              ),
            );
          return turn;
        }).pipe(
          withMetrics({
            counter: providerTurnsTotal,
            timer: providerTurnDuration,
            attributes: () =>
              providerTurnMetricAttributes({
                provider: metricProvider,
                model: metricModel,
                extra: {
                  operation: "send",
                },
              }),
          }),
        );
      });
      if (nativeDispatchStarted !== undefined && liveSteerTarget !== undefined) {
        const sendFiber = yield* withLiveSteerLock(
          parsed.threadId,
          liveSteerTarget.providerInstanceId,
          Effect.gen(function* () {
            const fiber = yield* send.pipe(Effect.forkChild({ startImmediately: true }));
            // Preserve same-provider FIFO only through native admission. The
            // full prompt response can remain pending while the next correction
            // enters that provider's same live turn.
            yield* Effect.raceFirst(
              Deferred.await(nativeDispatchStarted),
              Fiber.await(fiber).pipe(Effect.asVoid),
            );
            return fiber;
          }),
        );
        return yield* Fiber.join(sendFiber);
      }
      if (parsed.contextRecovery === undefined) {
        return yield* send;
      }
      const binding = Option.getOrUndefined(yield* directory.getBinding(parsed.threadId));
      const isCodexContextRecovery =
        binding?.provider === "codex" &&
        binding.providerInstanceId === parsed.contextRecovery.providerInstanceId;
      return yield* isCodexContextRecovery ? withContextRecoveryLock(parsed.threadId, send) : send;
    },
  );

  const interruptTurn: ProviderServiceMethod<"interruptTurn"> = Effect.fn("interruptTurn")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.interruptTurn",
        schema: ProviderInterruptTurnInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.interruptTurn",
          // A control-plane cancel must never spawn or recover a provider just
          // to stop it. If the binding is gone, the reactor still releases the
          // local turn authoritatively.
          allowRecovery: false,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "interrupt-turn",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.turn_id": input.turnId,
        });
        yield* routed.adapter.interruptTurn(routed.threadId, input.turnId);
        yield* analytics.record("provider.turn.interrupted", {
          provider: routed.adapter.provider,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "interrupt",
            }),
        }),
      );
    },
  );

  const promoteQueuedTurn: ProviderServiceMethod<"promoteQueuedTurn"> = Effect.fn(
    "promoteQueuedTurn",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.promoteQueuedTurn",
      schema: ProviderPromoteQueuedTurnInput,
      payload: rawInput,
    });
    const routed = yield* resolveRoutableSession({
      threadId: input.threadId,
      operation: "ProviderService.promoteQueuedTurn",
      allowRecovery: false,
    });
    const promote = routed.adapter.promoteQueuedTurn;
    if (promote === undefined) {
      return yield* new ProviderAdapterRequestError({
        provider: routed.adapter.provider,
        method: "queue/interject",
        detail: `Provider '${routed.adapter.provider}' cannot promote queued turns.`,
      });
    }
    return yield* promote(routed.threadId, input.messageIds);
  });

  const stopTask: ProviderServiceMethod<"stopTask"> = Effect.fn("stopTask")(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.stopTask",
      schema: ProviderStopTaskInput,
      payload: rawInput,
    });
    const routed = yield* resolveRoutableSession({
      threadId: input.threadId,
      operation: "ProviderService.stopTask",
      allowRecovery: false,
    });
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "stop-task",
      "provider.kind": routed.adapter.provider,
      "provider.thread_id": input.threadId,
      "provider.task_id": input.taskId,
    });
    const stop = routed.adapter.stopTask;
    if (stop === undefined || routed.adapter.capabilities.taskStop === false) {
      // Surfaced rather than swallowed: the caller renders a stop control and
      // must be able to tell the user the kill did not land, instead of
      // hiding the row and leaving the task running.
      return yield* new ProviderAdapterRequestError({
        provider: routed.adapter.provider,
        method: "task/stop",
        detail: `Provider '${routed.adapter.provider}' cannot stop individual tasks.`,
      });
    }
    yield* stop(routed.threadId, input.taskId);
  });

  const respondToRequest: ProviderServiceMethod<"respondToRequest"> = Effect.fn("respondToRequest")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.respondToRequest",
        schema: ProviderRespondToRequestInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.respondToRequest",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "respond-to-request",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.request_id": input.requestId,
        });
        yield* routed.adapter.respondToRequest(routed.threadId, input.requestId, input.decision);
        yield* analytics.record("provider.request.responded", {
          provider: routed.adapter.provider,
          decision: input.decision,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "approval-response",
            }),
        }),
      );
    },
  );

  const respondToUserInput: ProviderServiceMethod<"respondToUserInput"> = Effect.fn(
    "respondToUserInput",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.respondToUserInput",
      schema: ProviderRespondToUserInputInput,
      payload: rawInput,
    });
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.respondToUserInput",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "respond-to-user-input",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.request_id": input.requestId,
      });
      yield* routed.adapter.respondToUserInput(routed.threadId, input.requestId, input.answers);
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "user-input-response",
          }),
      }),
    );
  });

  const stopSession: ProviderServiceMethod<"stopSession"> = Effect.fn("stopSession")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.stopSession",
        schema: ProviderStopSessionInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* withSessionLifecycleLock(
        input.threadId,
        Effect.gen(function* () {
          const routed = yield* resolveRoutableSession({
            threadId: input.threadId,
            operation: "ProviderService.stopSession",
            allowRecovery: false,
          });
          metricProvider = routed.adapter.provider;
          yield* Effect.annotateCurrentSpan({
            "provider.operation": "stop-session",
            "provider.kind": routed.adapter.provider,
            "provider.thread_id": input.threadId,
          });
          if (routed.isActive) {
            yield* routed.adapter.stopSession(routed.threadId);
          }
          yield* stopStaleSessionsForThread({
            threadId: input.threadId,
            currentInstanceId: routed.instanceId,
          });
          yield* clearMcpSession(input.threadId);
          yield* directory.upsert({
            threadId: input.threadId,
            provider: routed.adapter.provider,
            providerInstanceId: routed.instanceId,
            status: "stopped",
            runtimePayload: {
              activeTurnId: null,
            },
          });
          yield* analytics.record("provider.session.stopped", {
            provider: routed.adapter.provider,
          });
        }).pipe(
          withMetrics({
            counter: providerSessionsTotal,
            outcomeAttributes: () =>
              providerMetricAttributes(metricProvider, {
                operation: "stop",
              }),
          }),
        ),
      );
    },
  );

  const listSessions: ProviderServiceMethod<"listSessions"> = Effect.fn("listSessions")(
    function* () {
      const currentAdapters = yield* getAdapterEntries;
      const sessionsByProvider = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
        adapter.listSessions().pipe(
          Effect.map((sessions) =>
            sessions.map((session) => ({
              ...session,
              providerInstanceId: instanceId,
            })),
          ),
        ),
      );
      const activeSessions = sessionsByProvider.flatMap((sessions) => sessions);
      const persistedBindings = yield* directory.listThreadIds().pipe(
        Effect.flatMap((threadIds) =>
          Effect.forEach(
            threadIds,
            (threadId) =>
              directory
                .getBinding(threadId)
                .pipe(
                  Effect.orElseSucceed(() =>
                    Option.none<ProviderSessionDirectory.ProviderRuntimeBinding>(),
                  ),
                ),
            { concurrency: "unbounded" },
          ),
        ),
        Effect.orElseSucceed(
          () => [] as Array<Option.Option<ProviderSessionDirectory.ProviderRuntimeBinding>>,
        ),
      );
      const bindingsByThreadId = new Map<
        ThreadId,
        ProviderSessionDirectory.ProviderRuntimeBinding
      >();
      for (const bindingOption of persistedBindings) {
        const binding = Option.getOrUndefined(bindingOption);
        if (binding) {
          bindingsByThreadId.set(binding.threadId, binding);
        }
      }

      const sessions: ProviderSession[] = [];
      for (const session of activeSessions) {
        const binding = bindingsByThreadId.get(session.threadId);
        if (!binding) {
          sessions.push(session);
          continue;
        }

        const overrides: {
          resumeCursor?: ProviderSession["resumeCursor"];
          pendingContextRecovery?: ProviderSession["pendingContextRecovery"];
          runtimeMode?: ProviderSession["runtimeMode"];
          providerInstanceId?: ProviderSession["providerInstanceId"];
        } = {};
        overrides.providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.listSessions",
          binding,
        );
        // Leftovers from a provider switch are expected for a moment (and can
        // linger if stop fails). Turn start, checkpointing, and the session
        // reaper all list every session at once, so dying here makes the rest
        // of the app unable to start chats.
        if (
          binding.provider !== session.provider ||
          overrides.providerInstanceId !== session.providerInstanceId
        ) {
          yield* Effect.logWarning("provider.session.list.skipped-stale", {
            threadId: session.threadId,
            activeProvider: session.provider,
            activeInstanceId: session.providerInstanceId,
            boundProvider: binding.provider,
            boundInstanceId: overrides.providerInstanceId,
          });
          continue;
        }
        if (session.resumeCursor === undefined && binding.resumeCursor !== undefined) {
          overrides.resumeCursor = binding.resumeCursor;
        }
        const pendingContextRecovery = readPendingContextRecovery(
          binding.runtimePayload,
          overrides.providerInstanceId,
        );
        if (pendingContextRecovery !== undefined) {
          overrides.pendingContextRecovery = pendingContextRecovery;
        }
        if (binding.runtimeMode !== undefined) {
          overrides.runtimeMode = binding.runtimeMode;
        }
        sessions.push(Object.assign({}, session, overrides));
      }
      return sessions;
    },
  );

  const getCapabilities: ProviderServiceMethod<"getCapabilities"> = (instanceId) =>
    registry.getByInstance(instanceId).pipe(Effect.map((adapter) => adapter.capabilities));

  const getInstanceInfo: ProviderServiceMethod<"getInstanceInfo"> = (instanceId) =>
    registry.getInstanceInfo(instanceId);

  const rollbackConversation: ProviderServiceMethod<"rollbackConversation"> = Effect.fn(
    "rollbackConversation",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.rollbackConversation",
      schema: ProviderRollbackConversationInput,
      payload: rawInput,
    });
    if (input.numTurns === 0) {
      return;
    }
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.rollbackConversation",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "rollback-conversation",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.rollback_turns": input.numTurns,
      });
      if (routed.adapter.capabilities.threadRollback === false) {
        return yield* new ProviderAdapterRequestError({
          provider: routed.adapter.provider,
          method: "thread/rollback",
          detail: `Provider '${routed.adapter.provider}' does not support thread rollback.`,
        });
      }
      yield* routed.adapter.rollbackThread(routed.threadId, input.numTurns);
      yield* analytics.record("provider.conversation.rolled_back", {
        provider: routed.adapter.provider,
        turns: input.numTurns,
      });
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "rollback",
          }),
      }),
    );
  });

  const forkSessionBinding: NonNullable<ProviderServiceMethod<"forkSessionBinding">> = Effect.fn(
    "ProviderService.forkSessionBinding",
  )(function* (input) {
    const existingTargetBinding = Option.getOrUndefined(
      yield* directory.getBinding(input.targetThreadId),
    );
    if (
      existingTargetBinding?.resumeCursor !== null &&
      existingTargetBinding?.resumeCursor !== undefined &&
      !isPendingForkResumeCursor(existingTargetBinding.resumeCursor)
    ) {
      const existingInstanceId = yield* requireBindingInstanceId(
        "ProviderService.forkSessionBinding",
        existingTargetBinding,
      );
      const existingAdapter = yield* registry.getByInstance(existingInstanceId);
      const pendingContextRecovery = readPendingContextRecovery(
        existingTargetBinding.runtimePayload,
        existingInstanceId,
      );
      const existingSession = (yield* existingAdapter.listSessions()).find(
        (session) => session.threadId === input.targetThreadId,
      );
      if (existingSession) {
        return {
          ...existingSession,
          providerInstanceId: existingInstanceId,
          ...(pendingContextRecovery !== undefined ? { pendingContextRecovery } : {}),
        };
      }
      const timestamp = yield* nowIso;
      const persistedModelSelection = readPersistedModelSelection(
        existingTargetBinding.runtimePayload,
      );
      const persistedCwd = readPersistedCwd(existingTargetBinding.runtimePayload);
      return {
        threadId: input.targetThreadId,
        provider: existingTargetBinding.provider,
        providerInstanceId: existingInstanceId,
        status: existingTargetBinding.status === "error" ? "error" : "closed",
        runtimeMode: existingTargetBinding.runtimeMode ?? input.runtimeMode,
        ...(persistedCwd ? { cwd: persistedCwd } : {}),
        ...(persistedModelSelection?.model ? { model: persistedModelSelection.model } : {}),
        resumeCursor: existingTargetBinding.resumeCursor,
        ...(pendingContextRecovery !== undefined ? { pendingContextRecovery } : {}),
        createdAt: timestamp,
        updatedAt: timestamp,
      } satisfies ProviderSession;
    }

    const sourceBinding = yield* directory.getBinding(input.sourceThreadId);
    if (Option.isNone(sourceBinding)) {
      return null;
    }
    const resumeCursor = forkResumeCursor(
      sourceBinding.value.provider,
      sourceBinding.value.resumeCursor,
    );
    if (resumeCursor === undefined) {
      return null;
    }
    const providerInstanceId = yield* requireBindingInstanceId(
      "ProviderService.forkSessionBinding",
      sourceBinding.value,
    );
    const adapter = yield* registry.getByInstance(providerInstanceId);
    const cwd = readPersistedCwd(sourceBinding.value.runtimePayload);
    const modelSelection = readPersistedModelSelection(sourceBinding.value.runtimePayload);
    if (adapter.capabilities.threadFork === false) {
      return yield* new ProviderAdapterRequestError({
        provider: adapter.provider,
        method: "thread/fork",
        detail: `Provider '${adapter.provider}' does not support thread forking.`,
      });
    }
    if (adapter.forkSession) {
      const session = yield* adapter.forkSession({
        sourceThreadId: input.sourceThreadId,
        targetThreadId: input.targetThreadId,
        sourceResumeCursor: sourceBinding.value.resumeCursor,
        providerInstanceId,
        runtimeMode: input.runtimeMode,
        ...(cwd ? { cwd } : {}),
        ...(modelSelection ? { modelSelection } : {}),
      });
      if (session.provider !== adapter.provider) {
        return yield* toValidationError(
          "ProviderService.forkSessionBinding",
          `Adapter/provider mismatch while forking thread '${input.sourceThreadId}'. Expected '${adapter.provider}', received '${session.provider}'.`,
        );
      }
      const sessionWithInstance = {
        ...session,
        providerInstanceId,
      };
      yield* upsertSessionBinding(sessionWithInstance, input.targetThreadId, {
        ...(modelSelection ? { modelSelection } : {}),
        sessionGeneration: NodeCrypto.randomUUID(),
        lastRuntimeEvent: "provider.forkSession",
        lastRuntimeEventAt: yield* nowIso,
      });
      return sessionWithInstance;
    }

    return yield* startSession(input.targetThreadId, {
      threadId: input.targetThreadId,
      provider: sourceBinding.value.provider,
      providerInstanceId,
      ...(cwd ? { cwd } : {}),
      ...(modelSelection ? { modelSelection } : {}),
      resumeCursor,
      runtimeMode: input.runtimeMode,
    });
  });

  const runStopAll = Effect.fn("runStopAll")(function* () {
    const threadIds = yield* directory.listThreadIds();
    const currentAdapters = yield* getAdapterEntries;
    const activeSessions = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
      adapter.listSessions().pipe(
        Effect.map((sessions) =>
          sessions.map((session) => ({
            ...session,
            providerInstanceId: instanceId,
          })),
        ),
      ),
    ).pipe(Effect.map((sessionsByAdapter) => sessionsByAdapter.flatMap((sessions) => sessions)));
    // Stop provider runtimes before persistence and telemetry work. During an
    // intentional server shutdown their pipes can close while those slower
    // steps are running; without this ordering the adapters misclassify that
    // teardown as a provider stream failure and paint a false red error before
    // startup auto-resume takes over.
    yield* Effect.forEach(currentAdapters, ([, adapter]) => adapter.stopAll(), {
      concurrency: "unbounded",
      discard: true,
    });
    yield* Effect.forEach(activeSessions, (session) =>
      Effect.flatMap(nowIso, (lastRuntimeEventAt) =>
        upsertSessionBinding(session, session.threadId, {
          lastRuntimeEvent: "provider.stopAll",
          lastRuntimeEventAt,
        }),
      ),
    ).pipe(Effect.asVoid);
    yield* McpSessionRegistry.revokeAllActiveMcpCredentials();
    McpProviderSession.clearAllMcpProviderSessions();
    const bindings = yield* directory.listBindings().pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(bindings, (binding) =>
      Effect.gen(function* () {
        const providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.stopAll",
          binding,
        );
        return yield* directory.upsert({
          threadId: binding.threadId,
          provider: binding.provider,
          providerInstanceId,
          status: "stopped",
          runtimePayload: {
            activeTurnId: null,
            lastRuntimeEvent: "provider.stopAll",
            lastRuntimeEventAt: yield* nowIso,
          },
        });
      }),
    ).pipe(Effect.asVoid);
    yield* analytics.record("provider.sessions.stopped_all", {
      sessionCount: threadIds.length,
    });
    yield* analytics.flush;
  });

  yield* Effect.addFinalizer(() =>
    runStopAll().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to stop provider service", {
          errorTag: causeErrorTag(cause),
        }),
      ),
    ),
  );

  return {
    startSession,
    sendTurn,
    interruptTurn,
    promoteQueuedTurn,
    stopTask,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    getCapabilities,
    getInstanceInfo,
    rollbackConversation,
    forkSessionBinding,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (ProviderRuntimeIngestion, CheckpointReactor, etc.) each
    // independently receive all runtime events.
    get streamEvents(): ProviderServiceMethod<"streamEvents"> {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  } satisfies ProviderService.ProviderService["Service"];
});

export const ProviderServiceLive = Layer.effect(
  ProviderService.ProviderService,
  makeProviderService(),
);

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(ProviderService.ProviderService, makeProviderService(options));
}
