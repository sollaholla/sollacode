// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderPendingContextRecovery,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderTurnStartResult,
} from "@t3tools/contracts";
import {
  ApprovalRequestId,
  EnvironmentId,
  EventId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionStartInput,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { it, assert, vi } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { HttpServer } from "effect/unstable/http";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderSessionDirectoryPersistenceError,
  ProviderUnsupportedError,
  ProviderValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type {
  ProviderAdapterSendTurnOptions,
  ProviderAdapterShape,
} from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "./ProviderService.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import { makeAdapterRegistryMock } from "../testUtils/providerAdapterRegistryMock.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";

const defaultServerSettingsLayer = ServerSettings.ServerSettingsService.layerTest();

const asRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const codexInstanceId = ProviderInstanceId.make("codex");
const claudeAgentInstanceId = ProviderInstanceId.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");
const CURSOR_DRIVER = ProviderDriverKind.make("cursor");

function makeLocalResumeTimeout(): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: String(CODEX_DRIVER),
    method: "thread/resume",
    detail: "simulated local native-resume timeout",
    failureKind: "local-control-timeout",
  });
}

function readPendingContextRecovery(
  binding: ProviderSessionDirectory.ProviderRuntimeBinding,
): ProviderPendingContextRecovery | undefined {
  const payload = binding.runtimePayload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  return "pendingContextRecovery" in payload && payload.pendingContextRecovery !== null
    ? (payload.pendingContextRecovery as ProviderPendingContextRecovery | undefined)
    : undefined;
}

function readSessionGeneration(
  binding: ProviderSessionDirectory.ProviderRuntimeBinding,
): string | undefined {
  const payload = binding.runtimePayload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const generation = "sessionGeneration" in payload ? payload.sessionGeneration : undefined;
  return typeof generation === "string" ? generation : undefined;
}

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderDriverKind;
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

function makeFakeCodexAdapter(
  provider: ProviderDriverKind = CODEX_DRIVER,
  options?: { readonly messageDeliveryReceipts?: boolean },
) {
  const sessions = new Map<ThreadId, ProviderSession>();
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());

  const startSession = vi.fn(
    (input: ProviderSessionStartInput): Effect.Effect<ProviderSession, ProviderAdapterError> =>
      Effect.sync(() => {
        const now = "2026-01-01T00:00:00.000Z";
        const session: ProviderSession = {
          provider,
          ...(input.providerInstanceId !== undefined
            ? { providerInstanceId: input.providerInstanceId }
            : {}),
          status: "ready",
          runtimeMode: input.runtimeMode,
          threadId: input.threadId,
          resumeCursor: input.resumeCursor ?? {
            opaque: `resume-${String(input.threadId)}`,
          },
          cwd: input.cwd ?? process.cwd(),
          createdAt: now,
          updatedAt: now,
        };
        sessions.set(session.threadId, session);
        return session;
      }),
  );

  const sendTurn = vi.fn(
    (
      input: ProviderSendTurnInput,
      options?: ProviderAdapterSendTurnOptions,
    ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> => {
      if (!sessions.has(input.threadId)) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider,
            threadId: input.threadId,
          }),
        );
      }

      const turn = {
        threadId: input.threadId,
        turnId: TurnId.make(`turn-${String(input.threadId)}`),
      };
      return (options?.onNativeDispatch ?? Effect.void).pipe(
        Effect.andThen(
          input.messageId !== undefined && adapter.capabilities.messageDeliveryReceipts === true
            ? PubSub.publish(runtimeEventPubSub, {
                type: "message.delivered",
                eventId: EventId.make(`fake-delivered:${input.messageId}`),
                provider,
                createdAt: "2026-01-01T00:00:00.000Z",
                threadId: input.threadId,
                turnId: turn.turnId,
                payload: { messageId: input.messageId },
                providerRefs: {},
              }).pipe(Effect.asVoid)
            : Effect.void,
        ),
        Effect.as(turn),
      );
    },
  );

  const interruptTurn = vi.fn(
    (_threadId: ThreadId, _turnId?: TurnId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.void,
  );

  const respondToRequest = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _decision: ProviderApprovalDecision,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const respondToUserInput = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _answers: Record<string, unknown>,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const stopSession = vi.fn(
    (threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.sync(() => {
        sessions.delete(threadId);
      }),
  );

  const listSessions = vi.fn(
    (): Effect.Effect<ReadonlyArray<ProviderSession>> =>
      Effect.sync(() => Array.from(sessions.values())),
  );

  const hasSession = vi.fn(
    (threadId: ThreadId): Effect.Effect<boolean> => Effect.succeed(sessions.has(threadId)),
  );

  const readThread = vi.fn(
    (
      threadId: ThreadId,
    ): Effect.Effect<
      {
        threadId: ThreadId;
        turns: ReadonlyArray<{ id: TurnId; items: readonly [] }>;
      },
      ProviderAdapterError
    > =>
      Effect.succeed({
        threadId,
        turns: [{ id: asTurnId("turn-1"), items: [] }],
      }),
  );

  const rollbackThread = vi.fn(
    (
      threadId: ThreadId,
      _numTurns: number,
    ): Effect.Effect<{ threadId: ThreadId; turns: readonly [] }, ProviderAdapterError> =>
      Effect.succeed({ threadId, turns: [] }),
  );

  const stopAll = vi.fn(
    (): Effect.Effect<void, ProviderAdapterError> =>
      Effect.sync(() => {
        sessions.clear();
      }),
  );

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider,
    capabilities: {
      sessionModelSwitch: "in-session",
      ...(options?.messageDeliveryReceipts === true ? { messageDeliveryReceipts: true } : {}),
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  const updateSession = (
    threadId: ThreadId,
    update: (session: ProviderSession) => ProviderSession,
  ): void => {
    const existing = sessions.get(threadId);
    if (!existing) {
      return;
    }
    sessions.set(threadId, update(existing));
  };

  return {
    adapter,
    emit,
    updateSession,
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
  };
}

const advanceTestClock = (ms: number) =>
  TestClock.adjust(`${ms} millis`).pipe(Effect.andThen(Effect.yieldNow));

const hasMetricSnapshot = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.some(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

function makeProviderServiceLayer() {
  const codex = makeFakeCodexAdapter();
  const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER, {
    messageDeliveryReceipts: true,
  });
  const cursor = makeFakeCodexAdapter(CURSOR_DRIVER);
  const registry = makeAdapterRegistryMock({
    [ProviderDriverKind.make("codex")]: codex.adapter,
    [ProviderDriverKind.make("claudeAgent")]: claude.adapter,
    [ProviderDriverKind.make("cursor")]: cursor.adapter,
  });

  const providerAdapterLayer = Layer.succeed(
    ProviderAdapterRegistry.ProviderAdapterRegistry,
    registry,
  );
  const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

  const layer = it.layer(
    Layer.mergeAll(
      makeProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provideMerge(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      ),
      directoryLayer,

      runtimeRepositoryLayer,
      NodeServices.layer,
    ),
  );

  return {
    codex,
    claude,
    cursor,
    layer,
  };
}

it.effect("ProviderServiceLive catches stopAll failures during shutdown", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    codex.stopAll.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: String(CODEX_DRIVER),
          method: "stopAll",
          detail: "simulated stopAll failure",
        }),
      ),
    );
    const registry = makeAdapterRegistryMock({
      [CODEX_DRIVER]: codex.adapter,
    });
    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      registry,
    );
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = Layer.mergeAll(
      makeProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provideMerge(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      ),
      directoryLayer,
      runtimeRepositoryLayer,
      NodeServices.layer,
    );
    const scope = yield* Scope.make();
    const runtimeServices = yield* Layer.build(providerLayer).pipe(Scope.provide(scope));

    yield* ProviderService.ProviderService.pipe(Effect.provide(runtimeServices));
    const closeExit = yield* Scope.close(scope, Exit.void).pipe(Effect.exit);

    assert.equal(Exit.isSuccess(closeExit), true);
    assert.equal(codex.stopAll.mock.calls.length, 1);
  }),
);

it.effect("ProviderServiceLive rejects new sessions for disabled providers", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
    const registryBase = makeAdapterRegistryMock({
      [CODEX_DRIVER]: codex.adapter,
      [CLAUDE_AGENT_DRIVER]: claude.adapter,
    });
    const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
      ...registryBase,
      getInstanceInfo: (instanceId) =>
        instanceId === claudeAgentInstanceId
          ? Effect.succeed({
              instanceId,
              driverKind: CLAUDE_AGENT_DRIVER,
              displayName: undefined,
              enabled: false,
              continuationIdentity: {
                driverKind: CLAUDE_AGENT_DRIVER,
                continuationKey: "claudeAgent:instance:claudeAgent",
              },
            })
          : registryBase.getInstanceInfo(instanceId),
    };
    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      registry,
    );
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(providerAdapterLayer),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    const failure = yield* Effect.flip(
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-disabled"), {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-disabled"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer)),
    );

    assert.instanceOf(failure, ProviderValidationError);
    assert.include(failure.issue, "Provider instance 'claudeAgent' is disabled");
    assert.equal(claude.startSession.mock.calls.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive allows enabled custom instances when legacy driver is disabled",
  () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex_personal");
      const driverKind = CODEX_DRIVER;
      const codex = makeFakeCodexAdapter();
      const unsupported = () =>
        new ProviderUnsupportedError({
          provider: driverKind,
        });
      const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
        getByInstance: (requestedInstanceId) =>
          requestedInstanceId === instanceId
            ? Effect.succeed(codex.adapter)
            : Effect.fail(unsupported()),
        getInstanceInfo: (requestedInstanceId) =>
          requestedInstanceId === instanceId
            ? Effect.succeed({
                instanceId,
                driverKind,
                displayName: "Codex Personal",
                enabled: true,
                continuationIdentity: {
                  driverKind,
                  continuationKey: "codex:/Users/example/.codex",
                },
              })
            : Effect.fail(unsupported()),
        listInstances: () => Effect.succeed([instanceId]),
        listProviders: () => Effect.succeed([driverKind] as const),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
          PubSub.subscribe(pubsub),
        ),
      };
      const providerAdapterLayer = Layer.succeed(
        ProviderAdapterRegistry.ProviderAdapterRegistry,
        registry,
      );
      const serverSettingsLayer = ServerSettings.ServerSettingsService.layerTest({
        providers: {
          codex: {
            enabled: false,
          },
        },
      });
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(SqlitePersistenceMemory),
      );
      const directoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const providerLayer = makeProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(serverSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      const session = yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-enabled-custom"), {
          provider: driverKind,
          providerInstanceId: instanceId,
          threadId: asThreadId("thread-enabled-custom"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer));

      assert.equal(session.providerInstanceId, instanceId);
      assert.equal(codex.startSession.mock.calls.length, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive rejects new sessions for disabled custom instances", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("codex_personal");
    const driverKind = ProviderDriverKind.make("codex");
    const codex = makeFakeCodexAdapter();
    const unsupported = () =>
      new ProviderUnsupportedError({
        provider: ProviderDriverKind.make("codex"),
      });
    const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
      getByInstance: (requestedInstanceId) =>
        requestedInstanceId === instanceId
          ? Effect.succeed(codex.adapter)
          : Effect.fail(unsupported()),
      getInstanceInfo: (requestedInstanceId) =>
        requestedInstanceId === instanceId
          ? Effect.succeed({
              instanceId,
              driverKind,
              displayName: "Codex Personal",
              enabled: false,
              continuationIdentity: {
                driverKind,
                continuationKey: "codex:/Users/example/.codex",
              },
            })
          : Effect.fail(unsupported()),
      listInstances: () => Effect.succeed([instanceId]),
      listProviders: () => Effect.succeed([CODEX_DRIVER] as const),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
        PubSub.subscribe(pubsub),
      ),
    };
    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      registry,
    );
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(providerAdapterLayer),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    const failure = yield* Effect.flip(
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-disabled-instance"), {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: instanceId,
          threadId: asThreadId("thread-disabled-instance"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer)),
    );

    assert.instanceOf(failure, ProviderValidationError);
    assert.include(failure.issue, "Provider instance 'codex_personal' is disabled");
    assert.equal(codex.startSession.mock.calls.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

const routing = makeProviderServiceLayer();

it.effect("ProviderServiceLive writes canonical events to the emitting thread segment", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const canonicalEvents: ProviderRuntimeEvent[] = [];
    const canonicalThreadIds: Array<string | null> = [];
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
    });
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLive({
      canonicalEventLogger: {
        filePath: "memory://provider-canonical-events",
        write: (event, threadId) => {
          canonicalEvents.push(event as ProviderRuntimeEvent);
          canonicalThreadIds.push(threadId ?? null);
          return Effect.void;
        },
        close: () => Effect.void,
      },
    }).pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    yield* Effect.gen(function* () {
      yield* ProviderService.ProviderService;
      yield* advanceTestClock(10);
      codex.emit({
        eventId: asEventId("evt-canonical-thread-segment"),
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-canonical-thread-segment"),
        createdAt: "2026-01-01T00:00:00.000Z",
        type: "turn.completed",
        payload: {
          state: "completed",
        },
      });
      yield* advanceTestClock(20);
    }).pipe(Effect.provide(providerLayer));

    assert.equal(canonicalEvents.length, 1);
    assert.equal(canonicalEvents[0]?.threadId, "thread-canonical-thread-segment");
    assert.deepEqual(canonicalThreadIds, ["thread-canonical-thread-segment"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive keeps persisted resumable sessions on startup", () =>
  Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-service-"));
    const dbPath = NodePath.join(tempDir, "orchestration.sqlite");

    const codex = makeFakeCodexAdapter();
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
    });

    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(persistenceLayer),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

    yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      yield* directory.upsert({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: ThreadId.make("thread-stale"),
      });
    }).pipe(Effect.provide(directoryLayer));

    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    yield* ProviderService.ProviderService.pipe(Effect.provide(providerLayer));

    const persistedProvider = yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      return yield* directory.getProvider(asThreadId("thread-stale"));
    }).pipe(Effect.provide(directoryLayer));
    assert.equal(persistedProvider, "codex");

    const runtime = yield* Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      return yield* repository.getByThreadId({
        threadId: asThreadId("thread-stale"),
      });
    }).pipe(Effect.provide(runtimeRepositoryLayer));
    assert.equal(Option.isSome(runtime), true);

    const legacyTableRows = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'provider_sessions'
      `;
    }).pipe(Effect.provide(persistenceLayer));
    assert.equal(legacyTableRows.length, 0);

    NodeFS.rmSync(tempDir, { recursive: true, force: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive restores rollback routing after restart using persisted thread mapping",
  () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-provider-service-restart-"),
      );
      const dbPath = NodePath.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(persistenceLayer),
      );

      const firstCodex = makeFakeCodexAdapter();
      const firstRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("codex")]: firstCodex.adapter,
      });

      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, firstRegistry),
        ),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );
      const updatedResumeCursor = {
        threadId: asThreadId("thread-1"),
        resume: "resume-session-1",
        resumeSessionAt: "assistant-message-1",
        turnCount: 1,
      };

      const startedSession = yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        const threadId = asThreadId("thread-1");
        const session = yield* provider.startSession(threadId, {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: "/tmp/project",
          runtimeMode: "full-access",
          threadId,
        });
        firstCodex.updateSession(threadId, (existing) => ({
          ...existing,
          status: "ready",
          resumeCursor: updatedResumeCursor,
          updatedAt: "2026-01-01T00:00:01.000Z",
        }));
        return session;
      }).pipe(Effect.provide(firstProviderLayer));

      const persistedAfterStopAll = yield* Effect.gen(function* () {
        const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
        return yield* repository.getByThreadId({
          threadId: startedSession.threadId,
        });
      }).pipe(Effect.provide(runtimeRepositoryLayer));
      assert.equal(Option.isSome(persistedAfterStopAll), true);
      if (Option.isSome(persistedAfterStopAll)) {
        assert.equal(persistedAfterStopAll.value.status, "stopped");
        assert.deepEqual(persistedAfterStopAll.value.resumeCursor, updatedResumeCursor);
      }

      const secondCodex = makeFakeCodexAdapter();
      const secondRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("codex")]: secondCodex.adapter,
      });
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, secondRegistry),
        ),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      secondCodex.startSession.mockClear();
      secondCodex.rollbackThread.mockClear();

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        yield* provider.rollbackConversation({
          threadId: startedSession.threadId,
          numTurns: 1,
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondCodex.startSession.mock.calls.length, 1);
      const resumedStartInput = secondCodex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, updatedResumeCursor);
        assert.equal(startPayload.threadId, startedSession.threadId);
      }
      assert.equal(secondCodex.rollbackThread.mock.calls.length, 1);
      const rollbackCall = secondCodex.rollbackThread.mock.calls[0];
      assert.equal(typeof rollbackCall?.[0], "string");
      assert.equal(rollbackCall?.[1], 1);

      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
);

routing.layer("ProviderServiceLive routing", (it) => {
  it.effect("materializes a frozen side-chat fork before its first turn", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const sourceThreadId = asThreadId("thread-side-chat-source");
      const threadId = asThreadId("thread-side-chat");

      const sourceSession = yield* provider.startSession(sourceThreadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: sourceThreadId,
        cwd: "/tmp/project-side-chat",
        runtimeMode: "full-access",
      });
      const forked = yield* provider.forkSessionBinding!({
        sourceThreadId,
        targetThreadId: threadId,
        runtimeMode: "full-access",
      });
      assert.equal(forked?.threadId, threadId);
      assert.equal(routing.codex.startSession.mock.calls.length, 2);
      assert.deepEqual(routing.codex.startSession.mock.calls[1]?.[0].resumeCursor, {
        ...(sourceSession.resumeCursor as Record<string, unknown>),
        fork: true,
      });
      yield* provider.startSession(sourceThreadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: sourceThreadId,
        cwd: "/tmp/project-side-chat",
        resumeCursor: { opaque: "source-advanced-after-fork" },
        runtimeMode: "full-access",
      });
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId,
        input: "Compare the approaches without changing the workspace.",
        attachments: [],
        isSideChat: true,
      });

      const adapterInput = routing.codex.sendTurn.mock.calls[0]?.[0];
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
      assert.include(adapterInput?.input ?? "", "interactive side-chat sub-agent");
      assert.include(adapterInput?.input ?? "", "main conversation as concurrent work");
      assert.include(
        adapterInput?.input ?? "",
        "Compare the approaches without changing the workspace.",
      );
      assert.equal(routing.codex.startSession.mock.calls.length, 0);
      const activeSessions = yield* provider.listSessions();
      assert.equal(
        activeSessions.some((session) => session.threadId === sourceThreadId),
        true,
      );
      assert.equal(
        activeSessions.some((session) => session.threadId === threadId),
        true,
      );

      yield* provider.stopSession({ threadId });
      yield* provider.stopSession({ threadId: sourceThreadId });
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();
      routing.codex.stopSession.mockClear();
    }),
  );

  it.effect("routes provider operations and rollback conversation", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      assert.equal(session.provider, "codex");

      const sessions = yield* provider.listSessions();
      assert.equal(sessions.length, 1);

      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);

      yield* provider.interruptTurn({ threadId: session.threadId });
      assert.deepEqual(routing.codex.interruptTurn.mock.calls, [[session.threadId, undefined]]);

      yield* provider.respondToRequest({
        threadId: session.threadId,
        requestId: asRequestId("req-1"),
        decision: "accept",
      });
      assert.deepEqual(routing.codex.respondToRequest.mock.calls, [
        [session.threadId, asRequestId("req-1"), "accept"],
      ]);

      yield* provider.respondToUserInput({
        threadId: session.threadId,
        requestId: asRequestId("req-user-input-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
      });
      assert.deepEqual(routing.codex.respondToUserInput.mock.calls, [
        [
          session.threadId,
          asRequestId("req-user-input-1"),
          {
            sandbox_mode: "workspace-write",
          },
        ],
      ]);

      yield* provider.rollbackConversation({
        threadId: session.threadId,
        numTurns: 0,
      });

      yield* provider.stopSession({ threadId: session.threadId });
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "after-stop",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, session.resumeCursor);
        assert.equal(startPayload.threadId, session.threadId);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("preserves an accepted sendTurn when the session binding update fails", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = asThreadId("thread-send-turn-post-acceptance-upsert-failure");

      yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-send-turn-post-acceptance-upsert-failure",
        runtimeMode: "full-access",
      });
      routing.codex.sendTurn.mockClear();

      const originalUpsertIfCurrent = directory.upsertIfCurrent;
      let failedRunningUpserts = 0;
      const upsertSpy = vi
        .spyOn(directory, "upsertIfCurrent")
        .mockImplementation((binding, expected) => {
          if (binding.threadId === threadId && binding.status === "running") {
            failedRunningUpserts += 1;
            return Effect.fail(
              new ProviderSessionDirectoryPersistenceError({
                operation: "ProviderSessionDirectory.upsertIfCurrent:update",
                detail: "simulated post-acceptance persistence failure",
              }),
            );
          }
          return originalUpsertIfCurrent(binding, expected);
        });

      const accepted = yield* provider
        .sendTurn({
          threadId,
          input: "deliver exactly once",
          attachments: [],
        })
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              upsertSpy.mockRestore();
            }),
          ),
        );

      assert.equal(accepted.threadId, threadId);
      assert.equal(accepted.turnId, asTurnId(`turn-${String(threadId)}`));
      assert.equal(failedRunningUpserts, 1);
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("recovers stale persisted sessions for rollback by resuming thread identity", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      yield* routing.codex.stopSession(initial.threadId);
      routing.codex.startSession.mockClear();
      routing.codex.rollbackThread.mockClear();

      yield* provider.rollbackConversation({
        threadId: initial.threadId,
        numTurns: 1,
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.rollbackThread.mock.calls.length, 1);
      const rollbackCall = routing.codex.rollbackThread.mock.calls[0];
      assert.equal(rollbackCall?.[1], 1);
    }),
  );

  it.effect("preserves the persisted binding when stopping a session", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      const initial = yield* provider.startSession(asThreadId("thread-reap-preserve"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-reap-preserve"),
        cwd: "/tmp/project-reap-preserve",
        runtimeMode: "full-access",
      });

      yield* provider.stopSession({ threadId: initial.threadId });

      const persistedAfterStop = yield* runtimeRepository.getByThreadId({
        threadId: initial.threadId,
      });
      assert.equal(Option.isSome(persistedAfterStop), true);
      if (Option.isSome(persistedAfterStop)) {
        assert.equal(persistedAfterStop.value.status, "stopped");
        assert.deepEqual(persistedAfterStop.value.resumeCursor, initial.resumeCursor);
      }

      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume after reap",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project-reap-preserve");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("routes explicit claudeAgent provider session starts to the claude adapter", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-claude"), {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId: asThreadId("thread-claude"),
        cwd: "/tmp/project-claude",
        runtimeMode: "full-access",
      });

      assert.equal(session.provider, "claudeAgent");
      assert.equal(routing.claude.startSession.mock.calls.length, 1);
      const startInput = routing.claude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof startInput === "object" && startInput !== null, true);
      if (startInput && typeof startInput === "object") {
        const startPayload = startInput as {
          provider?: string;
          providerInstanceId?: ProviderInstanceId;
          cwd?: string;
        };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.providerInstanceId, claudeAgentInstanceId);
        assert.equal(startPayload.cwd, "/tmp/project-claude");
      }
    }),
  );

  it.effect("omits leftover sessions that conflict with the persisted binding", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const healthyThreadId = asThreadId("thread-healthy");
      const leftoverThreadId = asThreadId("thread-binding-mismatch");

      yield* provider.startSession(healthyThreadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: healthyThreadId,
        cwd: "/tmp/project-healthy",
        runtimeMode: "full-access",
      });
      yield* provider.startSession(leftoverThreadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: leftoverThreadId,
        cwd: "/tmp/project-binding-mismatch",
        runtimeMode: "full-access",
      });
      yield* directory.upsert({
        threadId: leftoverThreadId,
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        runtimeMode: "full-access",
      });

      const sessions = yield* provider.listSessions();
      assert.equal(
        sessions.some((session) => session.threadId === leftoverThreadId),
        false,
      );
      assert.equal(
        sessions.some((session) => session.threadId === healthyThreadId),
        true,
      );

      yield* directory.upsert({
        threadId: leftoverThreadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        runtimeMode: "full-access",
      });
    }),
  );

  it.effect("stopSession also stops leftover sessions on other providers", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-stop-leftover");

      yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-stop-leftover",
        runtimeMode: "full-access",
      });
      yield* routing.claude.startSession({
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        cwd: "/tmp/project-stop-leftover",
        runtimeMode: "full-access",
      });

      routing.codex.stopSession.mockClear();
      routing.claude.stopSession.mockClear();

      yield* provider.stopSession({ threadId });

      assert.deepEqual(routing.codex.stopSession.mock.calls, [[threadId]]);
      assert.deepEqual(routing.claude.stopSession.mock.calls, [[threadId]]);
    }),
  );

  it.effect("stops stale sessions in other providers after a successful replacement start", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-provider-replacement");

      const codexSession = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-provider-replacement",
        runtimeMode: "full-access",
      });

      routing.codex.stopSession.mockClear();
      routing.claude.stopSession.mockClear();

      const claudeSession = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        cwd: "/tmp/project-provider-replacement",
        runtimeMode: "full-access",
      });

      assert.equal(codexSession.provider, "codex");
      assert.equal(claudeSession.provider, "claudeAgent");
      assert.deepEqual(routing.codex.stopSession.mock.calls, [[threadId]]);
      assert.equal(routing.claude.stopSession.mock.calls.length, 0);

      const sessions = yield* provider.listSessions();
      assert.deepEqual(
        sessions
          .filter((session) => session.threadId === threadId)
          .map((session) => session.provider),
        ["claudeAgent"],
      );
    }),
  );

  it.effect("recovers stale sessions for sendTurn using persisted cwd", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project-send-turn",
        runtimeMode: "full-access",
      });

      yield* routing.codex.stopAll();
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project-send-turn");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("recovers stale claudeAgent sessions for sendTurn using persisted cwd", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-claude-send-turn"), {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId: asThreadId("thread-claude-send-turn"),
        cwd: "/tmp/project-claude-send-turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "effort", value: "max" }],
        ),
        runtimeMode: "full-access",
      });

      yield* routing.claude.stopAll();
      routing.claude.startSession.mockClear();
      routing.claude.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume with claude",
        attachments: [],
      });

      assert.equal(routing.claude.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.claude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          modelSelection?: unknown;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.cwd, "/tmp/project-claude-send-turn");
        assert.deepEqual(
          startPayload.modelSelection,
          createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-opus-4-6", [
            { id: "effort", value: "max" },
          ]),
        );
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.claude.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("recovers sendTurn from cwd alone when no resume cursor is persisted", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = asThreadId("thread-send-turn-fresh");

      yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-send-turn-fresh",
        runtimeMode: "full-access",
      });
      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        runtimeMode: "full-access",
        resumeCursor: null,
        runtimePayload: { cwd: "/tmp/project-send-turn-fresh" },
      });
      yield* routing.codex.stopAll();
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId,
        input: "continue after restart",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const startPayload = routing.codex.startSession.mock.calls[0]?.[0] as {
        cwd?: string;
        resumeCursor?: unknown;
      };
      assert.equal(startPayload.cwd, "/tmp/project-send-turn-fresh");
      assert.equal(startPayload.resumeCursor, undefined);
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("starts a fresh session when persisted resume fails during sendTurn recovery", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const initial = yield* provider.startSession(asThreadId("thread-send-turn-resume-fail"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-send-turn-resume-fail"),
        cwd: "/tmp/project-send-turn-resume-fail",
        runtimeMode: "full-access",
      });

      yield* routing.codex.stopAll();
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();
      let rejectedToken: string | undefined;
      routing.codex.startSession.mockImplementationOnce(() =>
        Effect.gen(function* () {
          rejectedToken = McpProviderSession.readMcpProviderSession(
            initial.threadId,
          )?.authorizationHeader.replace(/^Bearer\s+/, "");
          assert.isDefined(rejectedToken);
          assert.equal((yield* registry.resolve(rejectedToken!))?.threadId, initial.threadId);
          return yield* new ProviderAdapterRequestError({
            provider: String(CODEX_DRIVER),
            method: "session/load",
            detail: "unknown session",
          });
        }),
      );

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "continue",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 2);
      const resumed = routing.codex.startSession.mock.calls[0]?.[0] as { resumeCursor?: unknown };
      const fresh = routing.codex.startSession.mock.calls[1]?.[0] as {
        cwd?: string;
        resumeCursor?: unknown;
      };
      assert.deepEqual(resumed.resumeCursor, initial.resumeCursor);
      assert.equal(fresh.resumeCursor, undefined);
      assert.equal(fresh.cwd, "/tmp/project-send-turn-resume-fail");
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
      const freshToken = McpProviderSession.readMcpProviderSession(
        initial.threadId,
      )?.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.isDefined(freshToken);
      assert.notEqual(freshToken, rejectedToken);
      assert.isUndefined(yield* registry.resolve(rejectedToken!));
      assert.equal((yield* registry.resolve(freshToken!))?.threadId, initial.threadId);
      yield* provider.stopSession({ threadId: initial.threadId });
      assert.isUndefined(yield* registry.resolve(freshToken!));
    }).pipe(
      Effect.provide(
        McpSessionRegistry.layer.pipe(
          Layer.provide(
            Layer.succeed(
              HttpServer.HttpServer,
              HttpServer.HttpServer.of({
                address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 43123 },
                serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
              }),
            ),
          ),
          Layer.provide(
            Layer.succeed(ServerEnvironment.ServerEnvironment, {
              getEnvironmentId: Effect.succeed(EnvironmentId.make("recovery-test")),
              getDescriptor: Effect.die("unused"),
            }),
          ),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("a delayed handoff stop preserves a newer session on the same provider", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-stale-handoff-stop");
      const input = {
        threadId,
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        cwd: "/tmp/project-stale-stop",
        runtimeMode: "full-access" as const,
      };
      const original = yield* provider.startSession(threadId, input);
      yield* provider.stopSession({ threadId });
      yield* provider.startSession(threadId, input);
      const successorCreatedAt = "2026-01-01T00:00:01.000Z";
      routing.codex.updateSession(threadId, (session) => ({
        ...session,
        createdAt: successorCreatedAt,
      }));
      routing.codex.stopSession.mockClear();
      yield* provider.stopSession({
        threadId,
        expectedSession: {
          providerInstanceId: codexInstanceId,
          createdAt: original.createdAt,
        },
      });
      assert.equal(routing.codex.stopSession.mock.calls.length, 0);
      assert.equal(
        (yield* provider.listSessions()).find((s) => s.threadId === threadId)?.createdAt,
        successorCreatedAt,
      );
      yield* provider.stopSession({
        threadId,
        expectedSession: {
          providerInstanceId: codexInstanceId,
          createdAt: successorCreatedAt,
        },
      });
      assert.equal(routing.codex.stopSession.mock.calls.length, 1);
    }),
  );

  it.effect("explicit fresh replaces the cursor and exposes its pending handoff", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = asThreadId("thread-explicit-fresh-start");
      const modelSelection = createModelSelection(codexInstanceId, "gpt-5.6", [
        { id: "reasoningEffort", value: "high" },
      ]);
      const initial = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-explicit-fresh-start",
        modelSelection,
        runtimeMode: "full-access",
      });
      assert.notEqual(initial.resumeCursor, undefined);
      const badResumeCursor = { opaque: "bad-native-resume-cursor" };
      yield* directory.upsert({
        threadId,
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        runtimeMode: "full-access",
        resumeCursor: badResumeCursor,
      });

      yield* routing.codex.stopAll();
      routing.codex.startSession.mockClear();

      const freshSession = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        resumeCursor: null,
        runtimeMode: "full-access",
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const freshAdapterInput = routing.codex.startSession.mock.calls[0]?.[0] as {
        cwd?: string;
        resumeCursor?: unknown;
      };
      assert.equal(Object.hasOwn(freshAdapterInput, "resumeCursor"), false);
      assert.equal(freshAdapterInput.cwd, "/tmp/project-explicit-fresh-start");
      assert.notDeepEqual(freshSession.resumeCursor, badResumeCursor);
      assert.equal(freshSession.pendingContextRecovery?.kind, "native-resume-timeout");
      assert.equal(freshSession.pendingContextRecovery?.sourceMessageId, null);

      const persisted = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.notEqual(persisted, undefined);
      if (!persisted) return;
      assert.deepEqual(persisted.resumeCursor, freshSession.resumeCursor);
      assert.deepEqual(readPendingContextRecovery(persisted), freshSession.pendingContextRecovery);
      assert.equal(
        (persisted.runtimePayload as { cwd?: unknown }).cwd,
        "/tmp/project-explicit-fresh-start",
      );
      assert.deepEqual(
        (persisted.runtimePayload as { modelSelection?: unknown }).modelSelection,
        modelSelection,
      );

      const listed = (yield* provider.listSessions()).find(
        (session) => session.threadId === threadId,
      );
      assert.deepEqual(listed?.pendingContextRecovery, freshSession.pendingContextRecovery);

      const adopted = yield* provider.forkSessionBinding!({
        sourceThreadId: asThreadId("unused-source-for-existing-target"),
        targetThreadId: threadId,
        runtimeMode: "full-access",
      });
      assert.deepEqual(adopted?.pendingContextRecovery, freshSession.pendingContextRecovery);

      const deliveryMessageId = asMessageId("message-explicit-fresh-context-recovery");
      routing.codex.sendTurn.mockImplementationOnce(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: String(CODEX_DRIVER),
            method: "thread/turn/start",
            detail: "simulated failure after the durable handoff claim",
          }),
        ),
      );
      const failedSend = yield* provider
        .sendTurn({
          threadId,
          messageId: deliveryMessageId,
          input: "bounded context handoff",
          attachments: [],
          contextRecovery: freshSession.pendingContextRecovery,
        })
        .pipe(Effect.exit);
      assert.equal(Exit.isFailure(failedSend), true);
      const claimedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.notEqual(claimedBinding, undefined);
      if (!claimedBinding) return;
      const claimedContextRecovery = readPendingContextRecovery(claimedBinding);
      assert.equal(claimedContextRecovery?.sourceMessageId, deliveryMessageId);

      const supersedingMessageId = asMessageId(
        "message-explicit-fresh-context-recovery-superseding",
      );
      yield* provider.sendTurn({
        threadId,
        messageId: supersedingMessageId,
        input: "newer bounded context handoff",
        attachments: [],
        ...(claimedContextRecovery !== undefined
          ? { contextRecovery: claimedContextRecovery }
          : {}),
      });
      const acceptedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.notEqual(acceptedBinding, undefined);
      if (!acceptedBinding) return;
      assert.equal(readPendingContextRecovery(acceptedBinding), undefined);
    }),
  );

  it.effect("clears a pending handoff when the thread switches provider instances", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = asThreadId("thread-context-recovery-provider-switch");
      const claudeInstanceId = ProviderInstanceId.make("claudeAgent");

      const codexSession = yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-context-recovery-provider-switch",
        resumeCursor: null,
        runtimeMode: "full-access",
      });
      assert.notEqual(codexSession.pendingContextRecovery, undefined);

      const claudeSession = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeInstanceId,
        threadId,
        cwd: "/tmp/project-context-recovery-provider-switch",
        runtimeMode: "full-access",
      });
      assert.equal(claudeSession.pendingContextRecovery, undefined);

      const switchedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.notEqual(switchedBinding, undefined);
      if (!switchedBinding) return;
      assert.equal(switchedBinding.providerInstanceId, claudeInstanceId);
      assert.equal(readPendingContextRecovery(switchedBinding), undefined);
      assert.equal(
        (switchedBinding.runtimePayload as { pendingContextRecovery?: unknown })
          .pendingContextRecovery,
        null,
      );

      routing.claude.sendTurn.mockClear();
      yield* provider.sendTurn({
        threadId,
        messageId: asMessageId("message-after-context-recovery-provider-switch"),
        input: "continue on the selected provider",
        attachments: [],
      });
      assert.equal(routing.claude.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("serializes concurrent recovery sends before marker claim and clear", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = asThreadId("thread-concurrent-context-recovery-sends");
      const firstMessageId = asMessageId("message-concurrent-context-recovery-first");
      const secondMessageId = asMessageId("message-concurrent-context-recovery-second");
      const session = yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-concurrent-context-recovery-sends",
        resumeCursor: null,
        runtimeMode: "full-access",
      });
      const pendingContextRecovery = session.pendingContextRecovery;
      assert.notEqual(pendingContextRecovery, undefined);
      if (!pendingContextRecovery) return;

      const adapterEntered = yield* Deferred.make<void>();
      const releaseAdapter = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();
      routing.codex.sendTurn.mockClear();
      routing.codex.sendTurn.mockImplementationOnce((input) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(adapterEntered, undefined);
          yield* Deferred.await(releaseAdapter);
          return {
            threadId: input.threadId,
            turnId: asTurnId("turn-concurrent-context-recovery-first"),
          };
        }),
      );

      const firstFiber = yield* Effect.forkScoped(
        provider.sendTurn({
          threadId,
          messageId: firstMessageId,
          input: "first bounded recovery handoff",
          attachments: [],
          contextRecovery: pendingContextRecovery,
        }),
      );
      yield* Deferred.await(adapterEntered);
      const claimedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.notEqual(claimedBinding, undefined);
      if (!claimedBinding) return;
      const claimedContextRecovery = readPendingContextRecovery(claimedBinding);
      assert.notEqual(claimedContextRecovery, undefined);
      if (!claimedContextRecovery) return;
      assert.equal(claimedContextRecovery.sourceMessageId, firstMessageId);
      const secondFiber = yield* Effect.forkScoped(
        Deferred.succeed(secondStarted, undefined).pipe(
          Effect.andThen(
            provider.sendTurn({
              threadId,
              messageId: secondMessageId,
              input: "newer bounded recovery handoff",
              attachments: [],
              contextRecovery: claimedContextRecovery,
            }),
          ),
        ),
      );
      yield* Deferred.await(secondStarted);
      yield* Effect.yieldNow;
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);

      yield* Deferred.succeed(releaseAdapter, undefined);
      const [firstExit, secondExit] = yield* Effect.all([
        Fiber.await(firstFiber),
        Fiber.await(secondFiber),
      ]);
      assert.equal(Exit.isSuccess(firstExit), true);
      assert.equal(Exit.isSuccess(secondExit), true);
      assert.deepEqual(
        routing.codex.sendTurn.mock.calls.map(
          (call) => (call[0] as ProviderSendTurnInput).messageId,
        ),
        [firstMessageId, secondMessageId],
      );

      const acceptedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.notEqual(acceptedBinding, undefined);
      if (!acceptedBinding) return;
      assert.equal(readPendingContextRecovery(acceptedBinding), undefined);
    }),
  );

  it.effect("does not serialize an explicit Codex steer behind slow recovery delivery", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-codex-steer-during-recovery");
      const session = yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-codex-steer-during-recovery",
        resumeCursor: null,
        runtimeMode: "full-access",
      });
      const pendingContextRecovery = session.pendingContextRecovery;
      assert.notEqual(pendingContextRecovery, undefined);
      if (!pendingContextRecovery) return;

      const recoveryEnteredAdapter = yield* Deferred.make<void>();
      const steerEnteredAdapter = yield* Deferred.make<void>();
      const releaseRecovery = yield* Deferred.make<void>();
      routing.codex.sendTurn.mockClear();
      routing.codex.sendTurn.mockImplementationOnce((input) =>
        Deferred.succeed(recoveryEnteredAdapter, undefined).pipe(
          Effect.andThen(Deferred.await(releaseRecovery)),
          Effect.as({
            threadId: input.threadId,
            turnId: asTurnId("turn-codex-slow-recovery"),
          }),
        ),
      );
      routing.codex.sendTurn.mockImplementationOnce((input, options) =>
        (options?.onNativeDispatch ?? Effect.void).pipe(
          Effect.andThen(Deferred.succeed(steerEnteredAdapter, undefined)),
          Effect.as({
            threadId: input.threadId,
            turnId: asTurnId("turn-codex-priority-steer"),
          }),
        ),
      );

      const recoveryFiber = yield* Effect.forkScoped(
        provider.sendTurn({
          threadId,
          messageId: asMessageId("message-codex-slow-recovery"),
          input: "bounded recovery handoff",
          attachments: [],
          contextRecovery: pendingContextRecovery,
        }),
      );
      yield* Deferred.await(recoveryEnteredAdapter);
      routing.codex.updateSession(threadId, (current) => ({
        ...current,
        status: "running",
        activeTurnId: asTurnId("turn-codex-slow-recovery"),
      }));

      const markerlessExit = yield* provider
        .sendTurn({
          threadId,
          messageId: asMessageId("message-codex-unproven-steer"),
          input: "this raw input must not bypass recovery",
          attachments: [],
        })
        .pipe(Effect.exit);
      assert.equal(Exit.isFailure(markerlessExit), true);
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);

      const steerFiber = yield* Effect.forkScoped(
        provider.sendTurn({
          threadId,
          messageId: asMessageId("message-codex-priority-steer"),
          input: "steer the live turn immediately",
          attachments: [],
          liveSteerTarget: {
            providerInstanceId: codexInstanceId,
            activeTurnId: asTurnId("turn-codex-slow-recovery"),
          },
        }),
      );
      yield* Deferred.await(steerEnteredAdapter);

      // Context recovery alone owns its serialization lock. A proven live
      // steer must reach the adapter while that recovery send is unresolved.
      assert.deepEqual(
        routing.codex.sendTurn.mock.calls.map(
          (call) => (call[0] as ProviderSendTurnInput).messageId,
        ),
        [asMessageId("message-codex-slow-recovery"), asMessageId("message-codex-priority-steer")],
      );

      yield* Deferred.succeed(releaseRecovery, undefined);
      const [recoveryExit, steerExit] = yield* Effect.all([
        Fiber.await(recoveryFiber),
        Fiber.await(steerFiber),
      ]);
      assert.equal(Exit.isSuccess(recoveryExit), true);
      assert.equal(Exit.isSuccess(steerExit), true);
      yield* provider.stopSession({ threadId });
    }),
  );

  it.effect("admits explicit live steers in FIFO order without awaiting either response", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-serialized-live-steers");
      const activeTurnId = asTurnId("turn-serialized-live-steers");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-serialized-live-steers",
        runtimeMode: "full-access",
      });
      routing.codex.updateSession(threadId, (current) => ({
        ...current,
        status: "running",
        activeTurnId,
      }));

      const firstEntered = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      routing.codex.sendTurn.mockClear();
      routing.codex.sendTurn.mockImplementationOnce((input, options) =>
        (options?.onNativeDispatch ?? Effect.void).pipe(
          Effect.andThen(Deferred.succeed(firstEntered, undefined)),
          Effect.andThen(Deferred.await(releaseFirst)),
          Effect.as({ threadId: input.threadId, turnId: activeTurnId }),
        ),
      );
      const liveSteerTarget = { providerInstanceId: codexInstanceId, activeTurnId };
      const firstMessageId = asMessageId("message-serialized-live-steer-first");
      const secondMessageId = asMessageId("message-serialized-live-steer-second");

      const firstFiber = yield* Effect.forkScoped(
        provider.sendTurn({
          threadId,
          messageId: firstMessageId,
          input: "first steer",
          attachments: [],
          liveSteerTarget,
        }),
      );
      yield* Deferred.await(firstEntered);
      const secondFiber = yield* Effect.forkScoped(
        provider.sendTurn({
          threadId,
          messageId: secondMessageId,
          input: "second steer",
          attachments: [],
          liveSteerTarget,
        }),
      );
      yield* Effect.yieldNow;
      assert.deepEqual(
        routing.codex.sendTurn.mock.calls.map(
          (call) => (call[0] as ProviderSendTurnInput).messageId,
        ),
        [firstMessageId, secondMessageId],
      );

      yield* Deferred.succeed(releaseFirst, undefined);
      const [firstExit, secondExit] = yield* Effect.all([
        Fiber.await(firstFiber),
        Fiber.await(secondFiber),
      ]);
      assert.equal(Exit.isSuccess(firstExit), true);
      assert.equal(Exit.isSuccess(secondExit), true);
      assert.deepEqual(
        routing.codex.sendTurn.mock.calls.map(
          (call) => (call[0] as ProviderSendTurnInput).messageId,
        ),
        [firstMessageId, secondMessageId],
      );
      yield* provider.stopSession({ threadId });
    }),
  );

  it.effect("keeps live-steer FIFO locked when an adapter never acknowledges native dispatch", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-live-steer-without-native-ack");
      const activeTurnId = asTurnId("turn-live-steer-without-native-ack");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-live-steer-without-native-ack",
        runtimeMode: "full-access",
      });
      routing.codex.updateSession(threadId, (current) => ({
        ...current,
        status: "running",
        activeTurnId,
      }));

      const firstEntered = yield* Deferred.make<void>();
      const secondEntered = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      routing.codex.sendTurn.mockClear();
      routing.codex.sendTurn.mockImplementationOnce((input) =>
        Deferred.succeed(firstEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseFirst)),
          Effect.as({ threadId: input.threadId, turnId: activeTurnId }),
        ),
      );
      routing.codex.sendTurn.mockImplementationOnce((input) =>
        Deferred.succeed(secondEntered, undefined).pipe(
          Effect.as({ threadId: input.threadId, turnId: activeTurnId }),
        ),
      );
      const liveSteerTarget = { providerInstanceId: codexInstanceId, activeTurnId };

      const firstFiber = yield* Effect.forkScoped(
        provider.sendTurn({
          threadId,
          messageId: asMessageId("message-live-steer-without-native-ack-first"),
          input: "first steer",
          attachments: [],
          liveSteerTarget,
        }),
      );
      yield* Deferred.await(firstEntered);
      const secondFiber = yield* Effect.forkScoped(
        provider.sendTurn({
          threadId,
          messageId: asMessageId("message-live-steer-without-native-ack-second"),
          input: "second steer",
          attachments: [],
          liveSteerTarget,
        }),
      );
      yield* Effect.yieldNow;
      assert.isTrue(Option.isNone(yield* Deferred.poll(secondEntered)));
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Deferred.await(secondEntered);
      const [firstExit, secondExit] = yield* Effect.all([
        Fiber.await(firstFiber),
        Fiber.await(secondFiber),
      ]);
      assert.equal(Exit.isSuccess(firstExit), true);
      assert.equal(Exit.isSuccess(secondExit), true);
      assert.equal(routing.codex.sendTurn.mock.calls.length, 2);
      yield* provider.stopSession({ threadId });
    }),
  );

  it.effect(
    "does not let an accepted send resurrect a session stopped while the adapter waited",
    () =>
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        const threadId = asThreadId("thread-send-completes-after-stop");
        yield* provider.startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          cwd: "/tmp/project-send-completes-after-stop",
          runtimeMode: "full-access",
        });

        const sendEntered = yield* Deferred.make<void>();
        const releaseSend = yield* Deferred.make<void>();
        routing.codex.sendTurn.mockClear();
        routing.codex.sendTurn.mockImplementationOnce((input) =>
          Deferred.succeed(sendEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseSend)),
            Effect.as({
              threadId: input.threadId,
              turnId: asTurnId("turn-completed-after-stop"),
            }),
          ),
        );

        const sendFiber = yield* Effect.forkScoped(
          provider.sendTurn({
            threadId,
            messageId: asMessageId("message-completed-after-stop"),
            input: "wait while Stop wins",
            attachments: [],
          }),
        );
        yield* Deferred.await(sendEntered);
        yield* provider.stopSession({ threadId });
        yield* Deferred.succeed(releaseSend, undefined);
        assert.equal(Exit.isSuccess(yield* Fiber.await(sendFiber)), true);

        const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
        assert.notEqual(binding, undefined);
        if (!binding) return;
        assert.equal(binding.status, "stopped");
        assert.equal(
          (binding.runtimePayload as { readonly activeTurnId?: unknown }).activeTurnId,
          null,
        );
      }),
  );

  it.effect(
    "serializes Stop before a same-instance restart and rejects the old accepted send generation",
    () =>
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        const threadId = asThreadId("thread-stop-restart-generation-race");
        yield* provider.startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          cwd: "/tmp/project-stop-restart-generation-race",
          runtimeMode: "full-access",
        });

        const initialBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
        assert.notEqual(initialBinding, undefined);
        if (!initialBinding) return;
        const initialGeneration = readSessionGeneration(initialBinding);
        assert.typeOf(initialGeneration, "string");

        const sendEntered = yield* Deferred.make<void>();
        const releaseSend = yield* Deferred.make<void>();
        routing.codex.sendTurn.mockClear();
        routing.codex.sendTurn.mockImplementationOnce((input) =>
          Deferred.succeed(sendEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseSend)),
            Effect.as({
              threadId: input.threadId,
              turnId: asTurnId("turn-old-generation-completed-late"),
            }),
          ),
        );
        const sendFiber = yield* Effect.forkScoped(
          provider.sendTurn({
            threadId,
            messageId: asMessageId("message-old-generation-completed-late"),
            input: "old generation send",
            attachments: [],
          }),
        );
        yield* Deferred.await(sendEntered);

        const originalStopSession = routing.codex.stopSession.getMockImplementation();
        const originalStartSession = routing.codex.startSession.getMockImplementation();
        if (originalStopSession === undefined || originalStartSession === undefined) {
          return yield* Effect.die("fake adapter lifecycle implementations are unavailable");
        }
        const stopEntered = yield* Deferred.make<void>();
        const releaseStop = yield* Deferred.make<void>();
        const restartEntered = yield* Deferred.make<void>();
        routing.codex.stopSession.mockClear();
        routing.codex.startSession.mockClear();
        routing.codex.stopSession.mockImplementationOnce((stoppedThreadId) =>
          Deferred.succeed(stopEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseStop)),
            Effect.andThen(originalStopSession(stoppedThreadId)),
          ),
        );
        routing.codex.startSession.mockImplementationOnce((input) =>
          Deferred.succeed(restartEntered, undefined).pipe(
            Effect.andThen(originalStartSession(input)),
          ),
        );

        const stopFiber = yield* Effect.forkScoped(provider.stopSession({ threadId }));
        yield* Deferred.await(stopEntered);
        const restartFiber = yield* Effect.forkScoped(
          provider.startSession(threadId, {
            provider: CODEX_DRIVER,
            providerInstanceId: codexInstanceId,
            threadId,
            cwd: "/tmp/project-stop-restart-generation-race",
            runtimeMode: "full-access",
          }),
        );
        yield* Effect.yieldNow;
        assert.isTrue(Option.isNone(yield* Deferred.poll(restartEntered)));

        yield* Deferred.succeed(releaseStop, undefined);
        assert.equal(Exit.isSuccess(yield* Fiber.await(stopFiber)), true);
        yield* Deferred.await(restartEntered);
        assert.equal(Exit.isSuccess(yield* Fiber.await(restartFiber)), true);

        const restartedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
        assert.notEqual(restartedBinding, undefined);
        if (!restartedBinding) return;
        const restartedGeneration = readSessionGeneration(restartedBinding);
        assert.typeOf(restartedGeneration, "string");
        assert.notEqual(restartedGeneration, initialGeneration);

        yield* Deferred.succeed(releaseSend, undefined);
        assert.equal(Exit.isSuccess(yield* Fiber.await(sendFiber)), true);

        const finalBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
        assert.notEqual(finalBinding, undefined);
        if (!finalBinding) return;
        assert.equal(finalBinding.status, "running");
        assert.equal(readSessionGeneration(finalBinding), restartedGeneration);
        assert.notEqual(
          (finalBinding.runtimePayload as { readonly activeTurnId?: unknown }).activeTurnId,
          asTurnId("turn-old-generation-completed-late"),
        );
        yield* provider.stopSession({ threadId });
      }),
  );

  it.effect("captures the exact admitted route capability and generation", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = asThreadId("thread-native-dispatch-route");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-native-dispatch-route",
        runtimeMode: "full-access",
      });
      let admittedRoute: ProviderService.ProviderServiceNativeDispatchRoute | undefined;

      yield* provider.sendTurn(
        {
          threadId,
          messageId: asMessageId("message-native-dispatch-route"),
          input: "capture the exact native route",
          attachments: [],
        },
        {
          onNativeDispatchRoute: (route) => {
            admittedRoute = route;
          },
        },
      );

      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.notEqual(binding, undefined);
      assert.notEqual(admittedRoute, undefined);
      if (binding === undefined || admittedRoute === undefined) return;
      assert.equal(admittedRoute.providerInstanceId, codexInstanceId);
      assert.equal(admittedRoute.sessionGeneration, readSessionGeneration(binding));
      assert.equal(admittedRoute.messageDeliveryReceipts, false);
      yield* provider.stopSession({ threadId });
    }),
  );

  it.effect("publishes one canonical receipt per successful receipt-capable send", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-canonical-delivery-receipt");
      const firstMessageId = asMessageId("message-canonical-delivery-first");
      const secondMessageId = asMessageId("message-canonical-delivery-second");
      yield* provider.startSession(threadId, {
        provider: CLAUDE_AGENT_DRIVER,
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        cwd: "/tmp/project-canonical-delivery-receipt",
        runtimeMode: "full-access",
      });

      const firstReceiptPublished = yield* Deferred.make<void>();
      const receiptsFiber = yield* provider.streamEvents.pipe(
        Stream.filter((event) => event.type === "message.delivered"),
        Stream.tap((event) =>
          event.type === "message.delivered" && event.payload.messageId === firstMessageId
            ? Deferred.succeed(firstReceiptPublished, undefined)
            : Effect.void,
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      const originalClaudeSend = routing.claude.sendTurn.getMockImplementation();
      if (originalClaudeSend === undefined) {
        return yield* Effect.die("fake Claude send implementation is unavailable");
      }
      routing.claude.sendTurn.mockImplementationOnce((input, options) =>
        Effect.gen(function* () {
          yield* options?.onNativeDispatch ?? Effect.void;
          routing.claude.emit({
            type: "message.delivered",
            eventId: asEventId("fake-delivered-before-service-return"),
            provider: CLAUDE_AGENT_DRIVER,
            createdAt: "2026-01-01T00:00:00.000Z",
            threadId,
            turnId: asTurnId("turn-canonical-delivery-first"),
            payload: { messageId: firstMessageId },
            providerRefs: {},
          });
          yield* Deferred.await(firstReceiptPublished);
          return {
            threadId: input.threadId,
            turnId: asTurnId("turn-canonical-delivery-first"),
          };
        }),
      );

      yield* provider.sendTurn({
        threadId,
        messageId: firstMessageId,
        input: "first accepted prompt",
        attachments: [],
      });
      routing.claude.emit({
        type: "message.delivered",
        eventId: asEventId("fake-delivered-late-duplicate"),
        provider: CLAUDE_AGENT_DRIVER,
        createdAt: "2026-01-01T00:00:01.000Z",
        threadId,
        turnId: asTurnId("turn-canonical-delivery-first"),
        payload: { messageId: firstMessageId },
        providerRefs: {},
      });
      yield* provider.sendTurn({
        threadId,
        messageId: secondMessageId,
        input: "second accepted prompt",
        attachments: [],
      });

      const receipts = Array.from(yield* Fiber.join(receiptsFiber));
      assert.deepEqual(
        receipts.map((event) =>
          event.type === "message.delivered" ? event.payload.messageId : undefined,
        ),
        [firstMessageId, secondMessageId],
      );
      yield* provider.stopSession({ threadId });
    }),
  );

  it.effect("serializes Stop after an in-flight provider-switch start", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = asThreadId("thread-provider-switch-start-stop-race");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-provider-switch-start-stop-race",
        runtimeMode: "full-access",
      });

      const originalClaudeStart = routing.claude.startSession.getMockImplementation();
      if (originalClaudeStart === undefined) {
        return yield* Effect.die("fake Claude start implementation is unavailable");
      }
      const switchEntered = yield* Deferred.make<void>();
      const releaseSwitch = yield* Deferred.make<void>();
      routing.claude.startSession.mockClear();
      routing.claude.stopSession.mockClear();
      routing.claude.startSession.mockImplementationOnce((input) =>
        Deferred.succeed(switchEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseSwitch)),
          Effect.andThen(originalClaudeStart(input)),
        ),
      );

      const switchFiber = yield* Effect.forkScoped(
        provider.startSession(threadId, {
          provider: CLAUDE_AGENT_DRIVER,
          providerInstanceId: claudeAgentInstanceId,
          threadId,
          cwd: "/tmp/project-provider-switch-start-stop-race",
          runtimeMode: "full-access",
        }),
      );
      yield* Deferred.await(switchEntered);
      const stopCompleted = yield* Deferred.make<void>();
      const stopFiber = yield* Effect.forkScoped(
        provider
          .stopSession({ threadId })
          .pipe(Effect.tap(() => Deferred.succeed(stopCompleted, undefined))),
      );
      yield* Effect.yieldNow;
      assert.isTrue(Option.isNone(yield* Deferred.poll(stopCompleted)));
      assert.equal(routing.claude.stopSession.mock.calls.length, 0);

      yield* Deferred.succeed(releaseSwitch, undefined);
      assert.equal(Exit.isSuccess(yield* Fiber.await(switchFiber)), true);
      assert.equal(Exit.isSuccess(yield* Fiber.await(stopFiber)), true);
      assert.equal(routing.claude.stopSession.mock.calls.length, 1);

      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.notEqual(binding, undefined);
      if (!binding) return;
      assert.equal(binding.provider, CLAUDE_AGENT_DRIVER);
      assert.equal(binding.providerInstanceId, claudeAgentInstanceId);
      assert.equal(binding.status, "stopped");
    }),
  );

  it.effect("recovers the provider-switch winner instead of resurrecting a captured route", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = asThreadId("thread-send-recovery-provider-switch-race");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-send-recovery-provider-switch-race",
        runtimeMode: "full-access",
      });
      yield* routing.codex.stopAll();
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();
      routing.claude.sendTurn.mockClear();

      const originalClaudeStart = routing.claude.startSession.getMockImplementation();
      if (originalClaudeStart === undefined) {
        return yield* Effect.die("fake Claude start implementation is unavailable");
      }
      const switchEntered = yield* Deferred.make<void>();
      const releaseSwitch = yield* Deferred.make<void>();
      routing.claude.startSession.mockImplementationOnce((input) =>
        Deferred.succeed(switchEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseSwitch)),
          Effect.andThen(originalClaudeStart(input)),
        ),
      );

      const switchFiber = yield* Effect.forkScoped(
        provider.startSession(threadId, {
          provider: CLAUDE_AGENT_DRIVER,
          providerInstanceId: claudeAgentInstanceId,
          threadId,
          cwd: "/tmp/project-send-recovery-provider-switch-race",
          runtimeMode: "full-access",
        }),
      );
      yield* Deferred.await(switchEntered);
      const sendFiber = yield* Effect.forkScoped(
        provider.sendTurn({
          threadId,
          messageId: asMessageId("message-send-recovery-provider-switch-race"),
          input: "route to the provider-switch winner",
          attachments: [],
        }),
      );
      yield* Effect.yieldNow;
      assert.equal(routing.codex.startSession.mock.calls.length, 0);

      yield* Deferred.succeed(releaseSwitch, undefined);
      assert.equal(Exit.isSuccess(yield* Fiber.await(switchFiber)), true);
      assert.equal(Exit.isSuccess(yield* Fiber.await(sendFiber)), true);

      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.notEqual(binding, undefined);
      if (binding === undefined) return;
      assert.equal(binding.provider, CLAUDE_AGENT_DRIVER);
      assert.equal(binding.providerInstanceId, claudeAgentInstanceId);
      assert.equal(routing.codex.startSession.mock.calls.length, 0);
      assert.equal(routing.codex.sendTurn.mock.calls.length, 0);
      assert.equal(routing.claude.sendTurn.mock.calls.length, 1);
      yield* provider.stopSession({ threadId });
    }),
  );

  it.effect("retries SessionNotFound on a provider switch that wins after native dispatch", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = asThreadId("thread-send-missing-after-provider-switch");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-send-missing-after-provider-switch",
        runtimeMode: "full-access",
      });

      const firstAttemptEntered = yield* Deferred.make<void>();
      const releaseMissingResult = yield* Deferred.make<void>();
      const admittedRoutes: Array<ProviderService.ProviderServiceNativeDispatchRoute> = [];
      routing.codex.sendTurn.mockClear();
      routing.claude.sendTurn.mockClear();
      routing.codex.sendTurn.mockImplementationOnce((input) =>
        Deferred.succeed(firstAttemptEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseMissingResult)),
          Effect.andThen(
            Effect.fail(
              new ProviderAdapterSessionNotFoundError({
                provider: CODEX_DRIVER,
                threadId: input.threadId,
              }),
            ),
          ),
        ),
      );

      const sendFiber = yield* Effect.forkScoped(
        provider.sendTurn(
          {
            threadId,
            messageId: asMessageId("message-send-missing-after-provider-switch"),
            input: "deliver exactly once to the provider-switch winner",
            attachments: [],
          },
          {
            onNativeDispatchRoute: (route) => {
              admittedRoutes.push(route);
            },
          },
        ),
      );
      yield* Deferred.await(firstAttemptEntered);

      yield* provider.startSession(threadId, {
        provider: CLAUDE_AGENT_DRIVER,
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        cwd: "/tmp/project-send-missing-after-provider-switch",
        runtimeMode: "full-access",
      });
      const switchedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.notEqual(switchedBinding, undefined);
      if (switchedBinding === undefined) return;
      assert.equal(switchedBinding.providerInstanceId, claudeAgentInstanceId);

      yield* Deferred.succeed(releaseMissingResult, undefined);
      assert.equal(Exit.isSuccess(yield* Fiber.await(sendFiber)), true);

      const finalBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.notEqual(finalBinding, undefined);
      if (finalBinding === undefined) return;
      const finalGeneration = readSessionGeneration(finalBinding);
      assert.typeOf(finalGeneration, "string");
      if (finalGeneration === undefined) return;
      assert.equal(finalBinding.provider, CLAUDE_AGENT_DRIVER);
      assert.equal(finalBinding.providerInstanceId, claudeAgentInstanceId);
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
      assert.equal(routing.claude.sendTurn.mock.calls.length, 1);
      assert.equal(admittedRoutes.length, 2);
      assert.deepEqual(admittedRoutes.at(-1), {
        providerInstanceId: claudeAgentInstanceId,
        sessionGeneration: finalGeneration,
        messageDeliveryReceipts: true,
      });
      yield* provider.stopSession({ threadId });
    }),
  );

  it.effect("does not let an old send overwrite a provider switch that wins completion", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = asThreadId("thread-send-completes-after-provider-switch");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-send-completes-after-provider-switch",
        runtimeMode: "full-access",
      });

      const sendEntered = yield* Deferred.make<void>();
      const releaseSend = yield* Deferred.make<void>();
      routing.codex.sendTurn.mockClear();
      routing.codex.sendTurn.mockImplementationOnce((input) =>
        Deferred.succeed(sendEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseSend)),
          Effect.as({
            threadId: input.threadId,
            turnId: asTurnId("turn-old-provider-completed-late"),
          }),
        ),
      );

      const sendFiber = yield* Effect.forkScoped(
        provider.sendTurn({
          threadId,
          messageId: asMessageId("message-old-provider-completed-late"),
          input: "old provider send",
          attachments: [],
        }),
      );
      yield* Deferred.await(sendEntered);
      yield* provider.startSession(threadId, {
        provider: CLAUDE_AGENT_DRIVER,
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        cwd: "/tmp/project-send-completes-after-provider-switch",
        runtimeMode: "full-access",
      });
      yield* Deferred.succeed(releaseSend, undefined);
      assert.equal(Exit.isSuccess(yield* Fiber.await(sendFiber)), true);

      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.notEqual(binding, undefined);
      if (!binding) return;
      assert.equal(binding.provider, CLAUDE_AGENT_DRIVER);
      assert.equal(binding.providerInstanceId, claudeAgentInstanceId);
      assert.notEqual(
        (binding.runtimePayload as { readonly activeTurnId?: unknown }).activeTurnId,
        asTurnId("turn-old-provider-completed-late"),
      );
      yield* provider.stopSession({ threadId });
    }),
  );

  it.effect("lets a switched provider bypass the prior provider's unacknowledged steer lane", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-provider-switch-bypasses-steer-lane");
      const codexTurnId = asTurnId("turn-provider-switch-old-codex");
      const claudeTurnId = asTurnId("turn-provider-switch-new-claude");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-provider-switch-bypasses-steer-lane",
        runtimeMode: "full-access",
      });
      routing.codex.updateSession(threadId, (current) => ({
        ...current,
        status: "running",
        activeTurnId: codexTurnId,
      }));

      const oldSteerEntered = yield* Deferred.make<void>();
      const releaseOldSteer = yield* Deferred.make<void>();
      routing.codex.sendTurn.mockClear();
      routing.codex.sendTurn.mockImplementationOnce((input) =>
        Deferred.succeed(oldSteerEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseOldSteer)),
          Effect.as({ threadId: input.threadId, turnId: codexTurnId }),
        ),
      );
      const oldSteerFiber = yield* Effect.forkScoped(
        provider.sendTurn({
          threadId,
          messageId: asMessageId("message-provider-switch-old-steer"),
          input: "old provider correction",
          attachments: [],
          liveSteerTarget: {
            providerInstanceId: codexInstanceId,
            activeTurnId: codexTurnId,
          },
        }),
      );
      yield* Deferred.await(oldSteerEntered);

      yield* provider.startSession(threadId, {
        provider: CLAUDE_AGENT_DRIVER,
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        cwd: "/tmp/project-provider-switch-bypasses-steer-lane",
        runtimeMode: "full-access",
      });
      routing.claude.updateSession(threadId, (current) => ({
        ...current,
        status: "running",
        activeTurnId: claudeTurnId,
      }));
      const newSteerEntered = yield* Deferred.make<void>();
      routing.claude.sendTurn.mockClear();
      routing.claude.sendTurn.mockImplementationOnce((input, options) =>
        (options?.onNativeDispatch ?? Effect.void).pipe(
          Effect.andThen(Deferred.succeed(newSteerEntered, undefined)),
          Effect.as({ threadId: input.threadId, turnId: claudeTurnId }),
        ),
      );

      const newSteer = yield* provider.sendTurn({
        threadId,
        messageId: asMessageId("message-provider-switch-new-steer"),
        input: "new provider correction",
        attachments: [],
        liveSteerTarget: {
          providerInstanceId: claudeAgentInstanceId,
          activeTurnId: claudeTurnId,
        },
      });
      yield* Deferred.await(newSteerEntered);
      assert.equal(newSteer.turnId, claudeTurnId);

      yield* Deferred.succeed(releaseOldSteer, undefined);
      assert.equal(Exit.isSuccess(yield* Fiber.await(oldSteerFiber)), true);
      yield* provider.stopSession({ threadId });
    }),
  );

  it.effect("runs the pre-dispatch hook once and prevents adapter admission when it fails", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-failed-before-native-dispatch");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-failed-before-native-dispatch",
        runtimeMode: "full-access",
      });
      const hookRuns = yield* Ref.make(0);
      routing.codex.sendTurn.mockClear();
      const hookFailure = new ProviderAdapterRequestError({
        provider: CODEX_DRIVER,
        method: "beforeNativeDispatch",
        detail: "synthetic resume was superseded before provider admission",
      });

      const exit = yield* provider
        .sendTurn(
          {
            threadId,
            messageId: asMessageId("message-failed-before-native-dispatch"),
            input: "synthetic resume",
            attachments: [],
          },
          {
            beforeNativeDispatch: Ref.update(hookRuns, (count) => count + 1).pipe(
              Effect.andThen(Effect.fail(hookFailure)),
            ),
          },
        )
        .pipe(Effect.exit);

      assert.equal(Exit.isFailure(exit), true);
      assert.equal(yield* Ref.get(hookRuns), 1);
      assert.equal(routing.codex.sendTurn.mock.calls.length, 0);
      yield* provider.stopSession({ threadId });
    }),
  );

  it.effect("fails a live steer closed when its exact turn is no longer active", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-stale-live-steer");
      routing.codex.startSession.mockClear();
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-stale-live-steer",
        runtimeMode: "full-access",
      });
      routing.codex.updateSession(threadId, (current) => ({
        ...current,
        status: "running",
        activeTurnId: asTurnId("turn-newer-than-steer"),
      }));
      routing.codex.sendTurn.mockClear();

      const exit = yield* provider
        .sendTurn({
          threadId,
          messageId: asMessageId("message-stale-live-steer"),
          input: "must not reach the newer turn",
          attachments: [],
          liveSteerTarget: {
            providerInstanceId: codexInstanceId,
            activeTurnId: asTurnId("turn-stale-steer-target"),
          },
        })
        .pipe(Effect.exit);

      assert.equal(Exit.isFailure(exit), true);
      assert.equal(routing.codex.sendTurn.mock.calls.length, 0);
      assert.equal(routing.codex.startSession.mock.calls.length, 1);

      yield* routing.codex.stopAll();
      const missingSessionExit = yield* provider
        .sendTurn({
          threadId,
          messageId: asMessageId("message-live-steer-after-teardown"),
          input: "must not recover a replacement session",
          attachments: [],
          liveSteerTarget: {
            providerInstanceId: codexInstanceId,
            activeTurnId: asTurnId("turn-newer-than-steer"),
          },
        })
        .pipe(Effect.exit);
      assert.equal(Exit.isFailure(missingSessionExit), true);
      assert.equal(routing.codex.sendTurn.mock.calls.length, 0);
      assert.equal(routing.codex.startSession.mock.calls.length, 1);
    }),
  );

  it.effect("does not persist a live steer rejected at native acceptance", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = asThreadId("thread-live-steer-native-rejection");
      const activeTurnId = asTurnId("turn-live-steer-native-rejection");
      routing.codex.startSession.mockClear();
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-live-steer-native-rejection",
        runtimeMode: "full-access",
      });
      routing.codex.updateSession(threadId, (current) => ({
        ...current,
        status: "running",
        activeTurnId,
      }));
      const bindingBefore = yield* directory.getBinding(threadId);
      routing.codex.sendTurn.mockClear();
      routing.codex.sendTurn.mockImplementationOnce(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: CODEX_DRIVER,
            method: "turn/steer",
            detail: "native prompt iterator rejected the stale target",
          }),
        ),
      );

      const exit = yield* provider
        .sendTurn({
          threadId,
          messageId: asMessageId("message-live-steer-native-rejection"),
          input: "must remain parked",
          attachments: [],
          liveSteerTarget: {
            providerInstanceId: codexInstanceId,
            activeTurnId,
          },
        })
        .pipe(Effect.exit);

      assert.equal(Exit.isFailure(exit), true);
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
      assert.deepEqual(yield* directory.getBinding(threadId), bindingBefore);
      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      routing.codex.sendTurn.mockClear();
    }),
  );

  it.effect(
    "does not start duplicate recovery while an explicit session restart is in flight",
    () =>
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        const threadId = asThreadId("thread-restart-recovery-serialization");
        routing.codex.startSession.mockClear();
        const startInput = {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          cwd: "/tmp/project-restart-recovery-serialization",
          runtimeMode: "full-access" as const,
        };
        yield* provider.startSession(threadId, startInput);

        const restartEntered = yield* Deferred.make<void>();
        const releaseRestart = yield* Deferred.make<void>();
        const defaultStartSession = routing.codex.startSession.getMockImplementation();
        assert.notEqual(defaultStartSession, undefined);
        if (!defaultStartSession) return;
        routing.codex.startSession.mockImplementationOnce((input) =>
          routing.codex
            .stopAll()
            .pipe(
              Effect.andThen(Deferred.succeed(restartEntered, undefined)),
              Effect.andThen(Deferred.await(releaseRestart)),
              Effect.andThen(defaultStartSession(input)),
            ),
        );

        const restartFiber = yield* Effect.forkScoped(provider.startSession(threadId, startInput));
        yield* Deferred.await(restartEntered);
        const queuedSendFiber = yield* Effect.forkScoped(
          provider.sendTurn({
            threadId,
            messageId: asMessageId("message-during-explicit-restart"),
            input: "deliver after the one restart finishes",
            attachments: [],
          }),
        );
        yield* Effect.yieldNow;
        assert.equal(routing.codex.startSession.mock.calls.length, 2);
        assert.equal(routing.codex.sendTurn.mock.calls.length, 0);

        yield* Deferred.succeed(releaseRestart, undefined);
        const [restartExit, sendExit] = yield* Effect.all([
          Fiber.await(restartFiber),
          Fiber.await(queuedSendFiber),
        ]);
        assert.equal(Exit.isSuccess(restartExit), true);
        assert.equal(Exit.isSuccess(sendExit), true);
        assert.equal(routing.codex.startSession.mock.calls.length, 2);
        assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
        yield* provider.stopSession({ threadId });
      }),
  );

  it.effect("adopts a matching lifecycle winner with its fresh cursor and recovery marker", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-coalesced-lifecycle-winner");
      routing.codex.startSession.mockClear();
      const startInput = {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-coalesced-lifecycle-winner",
        runtimeMode: "full-access" as const,
      };
      yield* provider.startSession(threadId, startInput);

      const restartEntered = yield* Deferred.make<void>();
      const releaseRestart = yield* Deferred.make<void>();
      const defaultStartSession = routing.codex.startSession.getMockImplementation();
      assert.notEqual(defaultStartSession, undefined);
      if (!defaultStartSession) return;
      routing.codex.startSession.mockImplementationOnce((input) =>
        routing.codex
          .stopAll()
          .pipe(
            Effect.andThen(Deferred.succeed(restartEntered, undefined)),
            Effect.andThen(Deferred.await(releaseRestart)),
            Effect.andThen(defaultStartSession(input)),
          ),
      );

      const restartFiber = yield* Effect.forkScoped(
        provider.startSession(threadId, { ...startInput, resumeCursor: null }),
      );
      yield* Deferred.await(restartEntered);
      const coalescedFiber = yield* Effect.forkScoped(
        provider.startSession(threadId, startInput, { reuseMatchingSession: true }),
      );
      yield* Effect.yieldNow;
      assert.equal(routing.codex.startSession.mock.calls.length, 2);

      yield* Deferred.succeed(releaseRestart, undefined);
      const [restarted, coalesced] = yield* Effect.all([
        Fiber.join(restartFiber),
        Fiber.join(coalescedFiber),
      ]);
      assert.equal(routing.codex.startSession.mock.calls.length, 2);
      assert.deepEqual(coalesced.resumeCursor, restarted.resumeCursor);
      assert.deepEqual(coalesced.pendingContextRecovery, restarted.pendingContextRecovery);
      assert.equal(coalesced.pendingContextRecovery?.kind, "native-resume-timeout");
      yield* provider.stopSession({ threadId });
    }),
  );

  it.effect("never coalesces an explicit fresh-session sentinel", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-explicit-fresh-not-coalesced");
      routing.codex.startSession.mockClear();
      const startInput = {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-explicit-fresh-not-coalesced",
        runtimeMode: "full-access" as const,
      };
      const initial = yield* provider.startSession(threadId, startInput);
      const fresh = yield* provider.startSession(
        threadId,
        { ...startInput, resumeCursor: null },
        { reuseMatchingSession: true },
      );

      assert.equal(routing.codex.startSession.mock.calls.length, 2);
      assert.notEqual(initial.resumeCursor, undefined);
      assert.equal(
        Object.hasOwn(routing.codex.startSession.mock.calls[1]?.[0] ?? {}, "resumeCursor"),
        false,
      );
      assert.equal(fresh.pendingContextRecovery?.kind, "native-resume-timeout");
      yield* provider.stopSession({ threadId });
    }),
  );

  it.effect("does not restart a matching lifecycle winner that already began a turn", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-running-lifecycle-winner");
      routing.codex.startSession.mockClear();
      const startInput = {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-running-lifecycle-winner",
        runtimeMode: "full-access" as const,
      };
      yield* provider.startSession(threadId, startInput);
      routing.codex.updateSession(threadId, (current) => ({
        ...current,
        status: "running",
        activeTurnId: asTurnId("turn-running-lifecycle-winner"),
      }));

      const exit = yield* provider
        .startSession(threadId, startInput, { reuseMatchingSession: true })
        .pipe(Effect.exit);

      assert.equal(Exit.isFailure(exit), true);
      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      yield* provider.stopSession({ threadId });
    }),
  );

  it.effect("does not serialize ordinary Cursor sends behind a long-running turn", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-concurrent-cursor-steer");
      yield* provider.startSession(threadId, {
        provider: CURSOR_DRIVER,
        providerInstanceId: ProviderInstanceId.make("cursor"),
        threadId,
        cwd: "/tmp/project-concurrent-cursor-steer",
        runtimeMode: "full-access",
      });

      const adapterEntered = yield* Deferred.make<void>();
      const releaseAdapter = yield* Deferred.make<void>();
      routing.cursor.sendTurn.mockClear();
      routing.cursor.sendTurn.mockImplementationOnce((input) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(adapterEntered, undefined);
          yield* Deferred.await(releaseAdapter);
          return {
            threadId: input.threadId,
            turnId: asTurnId("turn-concurrent-cursor-first"),
          };
        }),
      );

      const firstFiber = yield* Effect.forkScoped(
        provider.sendTurn({
          threadId,
          messageId: asMessageId("message-concurrent-cursor-first"),
          input: "start the long Cursor turn",
          attachments: [],
        }),
      );
      yield* Deferred.await(adapterEntered);
      const secondFiber = yield* Effect.forkScoped(
        provider.sendTurn({
          threadId,
          messageId: asMessageId("message-concurrent-cursor-second"),
          input: "steer the in-flight Cursor turn",
          attachments: [],
        }),
      );
      yield* Effect.yieldNow;
      assert.equal(routing.cursor.sendTurn.mock.calls.length, 2);

      yield* Deferred.succeed(releaseAdapter, undefined);
      const [firstExit, secondExit] = yield* Effect.all([
        Fiber.await(firstFiber),
        Fiber.await(secondFiber),
      ]);
      assert.equal(Exit.isSuccess(firstExit), true);
      assert.equal(Exit.isSuccess(secondExit), true);
      yield* provider.stopSession({ threadId });
    }),
  );

  it.effect(
    "invalidates a timed-out native resume without raw fallback and preserves the handoff when fresh start fails",
    () =>
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        const threadId = asThreadId("thread-native-resume-timeout-persisted");
        const sourceMessageId = asMessageId("message-native-resume-timeout-persisted");
        const badResumeCursor = { opaque: "bad-native-resume-cursor-persisted" };
        const modelSelection = createModelSelection(codexInstanceId, "gpt-5.6", [
          { id: "reasoningEffort", value: "high" },
        ]);
        yield* provider.startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          cwd: "/tmp/project-native-resume-timeout-persisted",
          modelSelection,
          runtimeMode: "full-access",
        });
        yield* directory.upsert({
          threadId,
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          runtimeMode: "full-access",
          resumeCursor: badResumeCursor,
        });
        yield* routing.codex.stopAll();
        routing.codex.startSession.mockClear();
        routing.codex.sendTurn.mockClear();
        routing.codex.startSession.mockImplementationOnce(() =>
          Effect.fail(makeLocalResumeTimeout()),
        );

        const resumeExit = yield* provider
          .sendTurn({
            threadId,
            messageId: sourceMessageId,
            input: "continue from the persisted cursor",
            attachments: [],
          })
          .pipe(Effect.exit);

        assert.equal(Exit.isFailure(resumeExit), true);
        assert.equal(routing.codex.startSession.mock.calls.length, 1);
        assert.deepEqual(
          (routing.codex.startSession.mock.calls[0]?.[0] as { resumeCursor?: unknown })
            .resumeCursor,
          badResumeCursor,
        );
        assert.equal(routing.codex.sendTurn.mock.calls.length, 0);
        const invalidated = Option.getOrUndefined(yield* directory.getBinding(threadId));
        assert.notEqual(invalidated, undefined);
        if (!invalidated) return;
        const pendingContextRecovery = readPendingContextRecovery(invalidated);
        assert.equal(invalidated.resumeCursor, null);
        assert.equal(pendingContextRecovery?.kind, "native-resume-timeout");
        assert.equal(pendingContextRecovery?.sourceMessageId, sourceMessageId);
        assert.equal(pendingContextRecovery?.providerInstanceId, codexInstanceId);
        assert.equal(
          (invalidated.runtimePayload as { cwd?: unknown }).cwd,
          "/tmp/project-native-resume-timeout-persisted",
        );
        assert.deepEqual(
          (invalidated.runtimePayload as { modelSelection?: unknown }).modelSelection,
          modelSelection,
        );

        routing.codex.startSession.mockClear();
        routing.codex.startSession.mockImplementationOnce(() =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: String(CODEX_DRIVER),
              method: "thread/start",
              detail: "simulated fresh-start failure",
            }),
          ),
        );
        const freshExit = yield* provider
          .startSession(threadId, {
            provider: CODEX_DRIVER,
            providerInstanceId: codexInstanceId,
            threadId,
            resumeCursor: null,
            runtimeMode: "full-access",
          })
          .pipe(Effect.exit);

        assert.equal(Exit.isFailure(freshExit), true);
        assert.equal(routing.codex.startSession.mock.calls.length, 1);
        const freshAdapterInput = routing.codex.startSession.mock.calls[0]?.[0] as {
          cwd?: string;
          resumeCursor?: unknown;
        };
        assert.equal(Object.hasOwn(freshAdapterInput, "resumeCursor"), false);
        assert.equal(freshAdapterInput.cwd, "/tmp/project-native-resume-timeout-persisted");
        const afterFreshFailure = Option.getOrUndefined(yield* directory.getBinding(threadId));
        assert.notEqual(afterFreshFailure, undefined);
        if (!afterFreshFailure) return;
        assert.equal(afterFreshFailure.resumeCursor, null);
        assert.deepEqual(readPendingContextRecovery(afterFreshFailure), pendingContextRecovery);
        assert.equal(
          (afterFreshFailure.runtimePayload as { cwd?: unknown }).cwd,
          "/tmp/project-native-resume-timeout-persisted",
        );
        assert.deepEqual(
          (afterFreshFailure.runtimePayload as { modelSelection?: unknown }).modelSelection,
          modelSelection,
        );
      }),
  );

  it.effect("invalidates the persisted cursor when direct native resume start times out", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = asThreadId("thread-direct-native-resume-timeout");
      const badResumeCursor = { opaque: "bad-direct-native-resume-cursor" };
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-direct-native-resume-timeout",
        runtimeMode: "full-access",
      });
      yield* directory.upsert({
        threadId,
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        runtimeMode: "full-access",
        resumeCursor: badResumeCursor,
      });
      yield* routing.codex.stopAll();
      routing.codex.startSession.mockClear();
      routing.codex.startSession.mockImplementationOnce(() =>
        Effect.fail(makeLocalResumeTimeout()),
      );

      const startExit = yield* provider
        .startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.exit);

      assert.equal(Exit.isFailure(startExit), true);
      assert.deepEqual(
        (routing.codex.startSession.mock.calls[0]?.[0] as { resumeCursor?: unknown }).resumeCursor,
        badResumeCursor,
      );
      const invalidated = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.notEqual(invalidated, undefined);
      if (!invalidated) return;
      assert.equal(invalidated.resumeCursor, null);
      assert.equal(readPendingContextRecovery(invalidated)?.sourceMessageId, null);
      assert.equal(
        (invalidated.runtimePayload as { cwd?: unknown }).cwd,
        "/tmp/project-direct-native-resume-timeout",
      );
    }),
  );

  it.effect("rechecks a recovery marker created while resolving the send route", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = asThreadId("thread-context-recovery-route-recheck");
      const session = yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-context-recovery-route-recheck",
        resumeCursor: null,
        runtimeMode: "full-access",
      });
      const pendingContextRecovery = session.pendingContextRecovery;
      assert.notEqual(pendingContextRecovery, undefined);
      if (!pendingContextRecovery) return;
      yield* directory.upsert({
        threadId,
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        runtimeMode: "full-access",
        runtimePayload: { pendingContextRecovery: null },
      });
      routing.codex.hasSession.mockImplementationOnce(() =>
        directory
          .upsert({
            threadId,
            provider: CODEX_DRIVER,
            providerInstanceId: codexInstanceId,
            runtimeMode: "full-access",
            resumeCursor: null,
            runtimePayload: { pendingContextRecovery },
          })
          .pipe(Effect.orDie, Effect.as(true)),
      );
      routing.codex.sendTurn.mockClear();

      const rawExit = yield* provider
        .sendTurn({
          threadId,
          input: "must be stopped by the post-resolution check",
          attachments: [],
        })
        .pipe(Effect.exit);

      assert.equal(Exit.isFailure(rawExit), true);
      assert.equal(routing.codex.sendTurn.mock.calls.length, 0);
      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.notEqual(binding, undefined);
      if (!binding) return;
      assert.deepEqual(readPendingContextRecovery(binding), pendingContextRecovery);
    }),
  );

  it.effect("requires the exact timed-out handoff and clears it only after acceptance", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = asThreadId("thread-native-resume-timeout-handoff");
      const sourceMessageId = asMessageId("message-native-resume-timeout-handoff");
      const modelSelection = createModelSelection(codexInstanceId, "gpt-5.6", [
        { id: "reasoningEffort", value: "high" },
      ]);
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-native-resume-timeout-handoff",
        modelSelection,
        runtimeMode: "full-access",
      });
      yield* routing.codex.stopAll();
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();
      routing.codex.startSession.mockImplementationOnce(() =>
        Effect.fail(makeLocalResumeTimeout()),
      );

      const timeoutExit = yield* provider
        .sendTurn({
          threadId,
          messageId: sourceMessageId,
          input: "resume and establish the bounded handoff",
          attachments: [],
        })
        .pipe(Effect.exit);
      assert.equal(Exit.isFailure(timeoutExit), true);
      assert.equal(routing.codex.sendTurn.mock.calls.length, 0);
      const invalidated = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.notEqual(invalidated, undefined);
      if (!invalidated) return;
      const pendingContextRecovery = readPendingContextRecovery(invalidated);
      assert.notEqual(pendingContextRecovery, undefined);
      if (!pendingContextRecovery) return;
      assert.equal(pendingContextRecovery.sourceMessageId, sourceMessageId);

      routing.codex.startSession.mockClear();
      const freshSession = yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        resumeCursor: null,
        runtimeMode: "full-access",
      });
      assert.deepEqual(freshSession.pendingContextRecovery, pendingContextRecovery);

      routing.codex.sendTurn.mockClear();
      const rawExit = yield* provider
        .sendTurn({
          threadId,
          messageId: sourceMessageId,
          input: "raw retry must not pass",
          attachments: [],
        })
        .pipe(Effect.exit);
      assert.equal(Exit.isFailure(rawExit), true);
      assert.equal(routing.codex.sendTurn.mock.calls.length, 0);

      const wrongIdentityExit = yield* provider
        .sendTurn({
          threadId,
          messageId: sourceMessageId,
          input: "wrong recovery identity must not pass",
          attachments: [],
          contextRecovery: {
            ...pendingContextRecovery,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        })
        .pipe(Effect.exit);
      assert.equal(Exit.isFailure(wrongIdentityExit), true);
      assert.equal(routing.codex.sendTurn.mock.calls.length, 0);

      yield* provider.sendTurn({
        threadId,
        messageId: sourceMessageId,
        input: "bounded context handoff",
        attachments: [],
        contextRecovery: pendingContextRecovery,
      });
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);

      const accepted = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.notEqual(accepted, undefined);
      if (!accepted) return;
      assert.equal(readPendingContextRecovery(accepted), undefined);
      assert.equal(
        (accepted.runtimePayload as { cwd?: unknown }).cwd,
        "/tmp/project-native-resume-timeout-handoff",
      );
      assert.deepEqual(
        (accepted.runtimePayload as { modelSelection?: unknown }).modelSelection,
        modelSelection,
      );

      const staleTagExit = yield* provider
        .sendTurn({
          threadId,
          messageId: sourceMessageId,
          input: "stale handoff tag must not replay",
          attachments: [],
          contextRecovery: pendingContextRecovery,
        })
        .pipe(Effect.exit);
      assert.equal(Exit.isFailure(staleTagExit), true);
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("retries sendTurn after the adapter reports the session missing", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const initial = yield* provider.startSession(asThreadId("thread-send-turn-missing"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-send-turn-missing"),
        cwd: "/tmp/project-send-turn-missing",
        runtimeMode: "full-access",
      });

      routing.codex.sendTurn.mockClear();
      routing.codex.sendTurn.mockImplementationOnce((input: ProviderSendTurnInput) =>
        Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider: String(CODEX_DRIVER),
            threadId: input.threadId,
          }),
        ),
      );

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "hello after restart",
        attachments: [],
      });

      assert.equal(routing.codex.sendTurn.mock.calls.length, 2);
    }),
  );

  it.effect("revalidates native admission before a SessionNotFound recovery retry", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-send-turn-missing-superseded");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-send-turn-missing-superseded",
        runtimeMode: "full-access",
      });

      const admissionChecks = yield* Ref.make(0);
      let laterRealEventObserved = false;
      routing.codex.sendTurn.mockClear();
      routing.codex.sendTurn.mockImplementationOnce((input: ProviderSendTurnInput) =>
        Effect.sync(() => {
          laterRealEventObserved = true;
        }).pipe(
          Effect.andThen(
            Effect.fail(
              new ProviderAdapterSessionNotFoundError({
                provider: String(CODEX_DRIVER),
                threadId: input.threadId,
              }),
            ),
          ),
        ),
      );

      const superseded = new ProviderAdapterRequestError({
        provider: CODEX_DRIVER,
        method: "beforeNativeDispatch",
        detail: "a later real user event superseded this synthetic retry",
      });
      const exit = yield* provider
        .sendTurn(
          {
            threadId,
            messageId: asMessageId("message-send-turn-missing-superseded"),
            input: "synthetic retry must be revalidated",
            attachments: [],
          },
          {
            beforeNativeDispatch: Ref.update(admissionChecks, (count) => count + 1).pipe(
              Effect.andThen(
                Effect.suspend(() =>
                  laterRealEventObserved ? Effect.fail(superseded) : Effect.void,
                ),
              ),
            ),
          },
        )
        .pipe(Effect.exit);

      assert.equal(Exit.isFailure(exit), true);
      assert.equal(yield* Ref.get(admissionChecks), 2);
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
      yield* provider.stopSession({ threadId });
    }),
  );

  it.effect("lists no sessions after adapter runtime clears", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });
      yield* provider.startSession(asThreadId("thread-2"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-2"),
        runtimeMode: "full-access",
      });

      yield* routing.codex.stopAll();
      yield* routing.claude.stopAll();

      const remaining = yield* provider.listSessions();
      assert.equal(remaining.length, 0);
    }),
  );

  it.effect("persists runtime status transitions in provider_session_runtime", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      const threadId = asThreadId("thread-runtime-status");
      const session = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const runningRuntime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runningRuntime), true);
      if (Option.isSome(runningRuntime)) {
        assert.equal(runningRuntime.value.status, "running");
        assert.deepEqual(runningRuntime.value.resumeCursor, session.resumeCursor);
        const payload = runningRuntime.value.runtimePayload;
        assert.equal(payload !== null && typeof payload === "object", true);
        if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
          const runtimePayload = payload as {
            cwd: string;
            model: string | null;
            activeTurnId: string | null;
            lastError: string | null;
            lastRuntimeEvent: string | null;
          };
          assert.equal(runtimePayload.cwd, session.cwd);
          assert.equal(runtimePayload.model, null);
          assert.equal(runtimePayload.activeTurnId, `turn-${String(session.threadId)}`);
          assert.equal(runtimePayload.lastError, null);
          assert.equal(runtimePayload.lastRuntimeEvent, "provider.sendTurn");
        }
      }
    }),
  );

  it.effect("reuses persisted resume cursor when startSession is called after a restart", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-provider-service-start-"),
      );
      const dbPath = NodePath.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(persistenceLayer),
      );

      const firstClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
      const firstRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("claudeAgent")]: firstClaude.adapter,
      });
      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, firstRegistry),
        ),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      const initial = yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-claude-start"), {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-claude-start"),
          cwd: "/tmp/project-claude-start",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(firstProviderLayer));

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        yield* provider.listSessions();
      }).pipe(Effect.provide(firstProviderLayer));

      const secondClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
      const secondRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("claudeAgent")]: secondClaude.adapter,
      });
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, secondRegistry),
        ),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      secondClaude.startSession.mockClear();

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        yield* provider.startSession(initial.threadId, {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: initial.threadId,
          cwd: "/tmp/project-claude-start",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondClaude.startSession.mock.calls.length, 1);
      const resumedStartInput = secondClaude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.cwd, "/tmp/project-claude-start");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }

      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reuses persisted cwd when startSession resumes a claude session without cwd input",
    () =>
      Effect.gen(function* () {
        const tempDir = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-provider-service-cwd-"),
        );
        const dbPath = NodePath.join(tempDir, "orchestration.sqlite");
        const persistenceLayer = makeSqlitePersistenceLive(dbPath);
        const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
          Layer.provide(persistenceLayer),
        );

        const firstClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
        const firstRegistry = makeAdapterRegistryMock({
          [ProviderDriverKind.make("claudeAgent")]: firstClaude.adapter,
        });
        const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
          Layer.provide(runtimeRepositoryLayer),
        );
        const firstProviderLayer = makeProviderServiceLive().pipe(
          Layer.provide(
            Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, firstRegistry),
          ),
          Layer.provide(firstDirectoryLayer),
          Layer.provide(defaultServerSettingsLayer),
          Layer.provide(AnalyticsService.layerTest),
          Layer.provide(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
        );

        const initial = yield* Effect.gen(function* () {
          const provider = yield* ProviderService.ProviderService;
          return yield* provider.startSession(asThreadId("thread-claude-cwd"), {
            provider: ProviderDriverKind.make("claudeAgent"),
            providerInstanceId: claudeAgentInstanceId,
            threadId: asThreadId("thread-claude-cwd"),
            cwd: "/tmp/project-claude-cwd",
            runtimeMode: "full-access",
          });
        }).pipe(Effect.provide(firstProviderLayer));

        const secondClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
        const secondRegistry = makeAdapterRegistryMock({
          [ProviderDriverKind.make("claudeAgent")]: secondClaude.adapter,
        });
        const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
          Layer.provide(runtimeRepositoryLayer),
        );
        const secondProviderLayer = makeProviderServiceLive().pipe(
          Layer.provide(
            Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, secondRegistry),
          ),
          Layer.provide(secondDirectoryLayer),
          Layer.provide(defaultServerSettingsLayer),
          Layer.provide(AnalyticsService.layerTest),
          Layer.provide(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
        );

        secondClaude.startSession.mockClear();

        yield* Effect.gen(function* () {
          const provider = yield* ProviderService.ProviderService;
          yield* provider.startSession(initial.threadId, {
            provider: ProviderDriverKind.make("claudeAgent"),
            providerInstanceId: claudeAgentInstanceId,
            threadId: initial.threadId,
            runtimeMode: "full-access",
          });
        }).pipe(Effect.provide(secondProviderLayer));

        assert.equal(secondClaude.startSession.mock.calls.length, 1);
        const resumedStartInput = secondClaude.startSession.mock.calls[0]?.[0];
        assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
        if (resumedStartInput && typeof resumedStartInput === "object") {
          const startPayload = resumedStartInput as {
            provider?: string;
            cwd?: string;
            resumeCursor?: unknown;
            threadId?: string;
          };
          assert.equal(startPayload.provider, "claudeAgent");
          assert.equal(startPayload.cwd, "/tmp/project-claude-cwd");
          assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
          assert.equal(startPayload.threadId, initial.threadId);
        }

        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const fanout = makeProviderServiceLayer();
fanout.layer("ProviderServiceLive fanout", (it) => {
  it.effect("fans out adapter turn completion events", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });

      const eventsRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.runForEach(provider.streamEvents, (event) =>
        Ref.update(eventsRef, (current) => [...current, event]),
      ).pipe(Effect.forkChild);
      yield* advanceTestClock(50);

      const completedEvent: LegacyProviderRuntimeEvent = {
        type: "turn.completed",
        eventId: asEventId("evt-1"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        status: "completed",
      };

      fanout.codex.emit(completedEvent);
      yield* advanceTestClock(50);

      const events = yield* Ref.get(eventsRef);
      yield* Fiber.interrupt(consumer);

      assert.equal(
        events.some((entry) => entry.type === "turn.completed"),
        true,
      );
      assert.equal(
        events.some(
          (entry) =>
            entry.type === "turn.completed" && entry.providerInstanceId === codexInstanceId,
        ),
        true,
      );
    }),
  );

  it.effect("fans out canonical runtime events in emission order", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-seq"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-seq"),
        runtimeMode: "full-access",
      });

      const receivedRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.take(provider.streamEvents, 3).pipe(
        Stream.runForEach((event) => Ref.update(receivedRef, (current) => [...current, event])),
        Effect.forkChild,
      );
      yield* advanceTestClock(50);

      fanout.codex.emit({
        type: "tool.started",
        eventId: asEventId("evt-seq-1"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        toolKind: "command",
        title: "Ran command",
      });
      fanout.codex.emit({
        type: "tool.completed",
        eventId: asEventId("evt-seq-2"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        toolKind: "command",
        title: "Ran command",
      });
      fanout.codex.emit({
        type: "turn.completed",
        eventId: asEventId("evt-seq-3"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        status: "completed",
      });

      yield* Fiber.join(consumer);
      const received = yield* Ref.get(receivedRef);
      assert.deepEqual(
        received.map((event) => event.eventId),
        [asEventId("evt-seq-1"), asEventId("evt-seq-2"), asEventId("evt-seq-3")],
      );
    }),
  );

  it.effect("keeps subscriber delivery ordered and isolates failing subscribers", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });

      const receivedByHealthy: string[] = [];
      const expectedEventIds = new Set<string>(["evt-ordered-1", "evt-ordered-2", "evt-ordered-3"]);
      const healthyFiber = yield* Stream.take(provider.streamEvents, 3).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            receivedByHealthy.push(event.eventId);
          }),
        ),
        Effect.forkChild,
      );
      const failingFiber = yield* Stream.take(provider.streamEvents, 1).pipe(
        Stream.runForEach(() => Effect.fail("listener crash")),
        Effect.forkChild,
      );
      yield* advanceTestClock(50);

      const events: ReadonlyArray<LegacyProviderRuntimeEvent> = [
        {
          type: "tool.completed",
          eventId: asEventId("evt-ordered-1"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          toolKind: "command",
          title: "Ran command",
          detail: "echo one",
        },
        {
          type: "message.delta",
          eventId: asEventId("evt-ordered-2"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          delta: "hello",
        },
        {
          type: "turn.completed",
          eventId: asEventId("evt-ordered-3"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          status: "completed",
        },
      ];

      for (const event of events) {
        fanout.codex.emit(event);
      }
      const failingResult = yield* Effect.result(Fiber.join(failingFiber));
      assert.equal(failingResult._tag, "Failure");
      yield* Fiber.join(healthyFiber);

      assert.deepEqual(
        receivedByHealthy.filter((eventId) => expectedEventIds.has(eventId)).slice(0, 3),
        ["evt-ordered-1", "evt-ordered-2", "evt-ordered-3"],
      );
    }),
  );

  it.effect("records provider metrics with the routed provider label", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-metrics"), {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId: asThreadId("thread-metrics"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      yield* provider.interruptTurn({ threadId: session.threadId });
      yield* provider.respondToRequest({
        threadId: session.threadId,
        requestId: asRequestId("req-metrics-1"),
        decision: "accept",
      });
      yield* provider.respondToUserInput({
        threadId: session.threadId,
        requestId: asRequestId("req-metrics-2"),
        answers: {
          sandbox_mode: "workspace-write",
        },
      });
      yield* provider.rollbackConversation({
        threadId: session.threadId,
        numTurns: 1,
      });
      yield* provider.stopSession({ threadId: session.threadId });

      const snapshots = yield* Metric.snapshot;

      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "interrupt",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "approval-response",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "user-input-response",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "rollback",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_sessions_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "stop",
          outcome: "success",
        }),
        true,
      );
    }),
  );

  it.effect(
    "records sendTurn metrics with the resolved provider when modelSelection is omitted",
    () =>
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;

        const session = yield* provider.startSession(asThreadId("thread-send-metrics"), {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-send-metrics"),
          cwd: "/tmp/project-send-metrics",
          runtimeMode: "full-access",
        });

        yield* provider.sendTurn({
          threadId: session.threadId,
          input: "hello",
          attachments: [],
        });

        const snapshots = yield* Metric.snapshot;

        assert.equal(
          hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
            provider: ProviderDriverKind.make("claudeAgent"),
            operation: "send",
            outcome: "success",
          }),
          true,
        );
        assert.equal(
          hasMetricSnapshot(snapshots, "t3_provider_turn_duration", {
            provider: ProviderDriverKind.make("claudeAgent"),
            operation: "send",
          }),
          true,
        );
      }),
  );
});

const validation = makeProviderServiceLayer();
validation.layer("ProviderServiceLive validation", (it) => {
  it.effect("rejects session starts without an explicit provider instance id", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      validation.codex.startSession.mockClear();
      const failure = yield* Effect.flip(
        provider.startSession(asThreadId("thread-missing-instance-id"), {
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-missing-instance-id"),
          runtimeMode: "full-access",
        }),
      );

      assert.instanceOf(failure, ProviderValidationError);
      assert.include(failure.issue, "Provider instance id is required for provider 'codex'.");
      assert.equal(validation.codex.startSession.mock.calls.length, 0);
    }),
  );

  it.effect("rejects mismatched provider kind and provider instance id", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      validation.codex.startSession.mockClear();
      validation.claude.startSession.mockClear();
      const failure = yield* Effect.flip(
        provider.startSession(asThreadId("thread-instance-mismatch"), {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-instance-mismatch"),
          runtimeMode: "full-access",
        }),
      );

      assert.instanceOf(failure, ProviderValidationError);
      assert.include(
        failure.issue,
        "Provider instance 'claudeAgent' belongs to driver 'claudeAgent', not 'codex'.",
      );
      assert.equal(validation.codex.startSession.mock.calls.length, 0);
      assert.equal(validation.claude.startSession.mock.calls.length, 0);
    }),
  );

  it.effect("returns ProviderValidationError for invalid input payloads", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const failure = yield* Effect.result(
        provider.startSession(asThreadId("thread-validation"), {
          threadId: asThreadId("thread-validation"),
          provider: "invalid-provider",
          runtimeMode: "full-access",
        } as never),
      );

      assert.equal(failure._tag, "Failure");
      if (failure._tag !== "Failure") {
        return;
      }
      assert.equal(failure.failure._tag, "ProviderValidationError");
      if (failure.failure._tag !== "ProviderValidationError") {
        return;
      }
      assert.equal(failure.failure.operation, "ProviderService.startSession");
      assert.equal(failure.failure.issue.includes("invalid-provider"), true);
    }),
  );

  it.effect("accepts startSession when adapter has not emitted provider thread id yet", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      validation.codex.startSession.mockImplementationOnce((input: ProviderSessionStartInput) =>
        Effect.sync(() => {
          const now = "2026-01-01T00:00:00.000Z";
          return {
            provider: ProviderDriverKind.make("codex"),
            status: "ready",
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            cwd: input.cwd ?? process.cwd(),
            createdAt: now,
            updatedAt: now,
          } satisfies ProviderSession;
        }),
      );

      const session = yield* provider.startSession(asThreadId("thread-missing"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-missing"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      assert.equal(session.threadId, asThreadId("thread-missing"));

      const runtime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.threadId, session.threadId);
      }
    }),
  );
});
