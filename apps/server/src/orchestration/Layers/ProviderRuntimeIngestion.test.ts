// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  OrchestrationReadModel,
  ProviderDriverKind,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderInstanceId,
  FILL_PREVIEW_VIEWPORT,
  type PreviewSessionSnapshot,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderItemId,
  RuntimeRequestId,
  type ServerSettings,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Metric from "effect/Metric";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { makeProviderRegistryLayer } from "../../provider/testUtils/providerRegistryMock.ts";
import { PROVIDER_OVERLOAD_RETRY_REASON_PREFIX } from "../../provider/providerOverloadRetry.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import {
  ProviderRuntimeIngestionLive,
  runtimeEventWorkObservation,
  runtimeEventToActivities,
} from "./ProviderRuntimeIngestion.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ThreadWorkScheduler,
  type ThreadWorkSchedulerShape,
} from "../Services/ThreadWorkScheduler.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PreviewManager from "../../preview/Manager.ts";

function makeTestServerSettingsLayer(overrides: Partial<ServerSettings> = {}) {
  return ServerSettingsService.layerTest(overrides);
}

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asItemId = (value: string): ProviderItemId => ProviderItemId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

describe("provider runtime work observation", () => {
  const base = {
    provider: ProviderDriverKind.make("codex"),
    threadId: asThreadId("thread-runtime-observation"),
    createdAt: "2026-01-01T00:00:00.000Z",
    turnId: asTurnId("turn-runtime-observation"),
  } as const;

  it("classifies tools, subagents, compaction, retries, and provider interaction", () => {
    expect(
      runtimeEventWorkObservation({
        ...base,
        type: "item.started",
        eventId: asEventId("runtime-observation-tool"),
        payload: { itemType: "command_execution" },
      }),
    ).toEqual({
      activeTurnId: asTurnId("turn-runtime-observation"),
      phase: "tool-running",
    });
    expect(
      runtimeEventWorkObservation({
        ...base,
        type: "item.started",
        eventId: asEventId("runtime-observation-subagent"),
        payload: { itemType: "collab_agent_tool_call" },
      }),
    ).toEqual({
      activeTurnId: asTurnId("turn-runtime-observation"),
      phase: "subagent-running",
    });
    expect(
      runtimeEventWorkObservation({
        ...base,
        type: "item.started",
        eventId: asEventId("runtime-observation-compaction"),
        payload: { itemType: "context_compaction" },
      }),
    ).toEqual({
      activeTurnId: asTurnId("turn-runtime-observation"),
      phase: "context-compacting",
    });
    expect(
      runtimeEventWorkObservation({
        ...base,
        type: "session.state.changed",
        eventId: asEventId("runtime-observation-retry"),
        payload: {
          state: "running",
          reason: `${PROVIDER_OVERLOAD_RETRY_REASON_PREFIX} upstream unavailable`,
        },
      }),
    ).toEqual({
      activeTurnId: asTurnId("turn-runtime-observation"),
      phase: "provider-retrying",
    });
    expect(
      runtimeEventWorkObservation({
        ...base,
        type: "user-input.requested",
        eventId: asEventId("runtime-observation-input"),
        requestId: RuntimeRequestId.make("request-runtime-observation"),
        payload: { questions: [] },
      }),
    ).toEqual({
      activeTurnId: asTurnId("turn-runtime-observation"),
      phase: "waiting-provider-interaction",
    });
  });
});

describe("provider usage activity projection", () => {
  it("preserves typed provider rate-limit payloads for the usage UI", () => {
    const activities = runtimeEventToActivities({
      type: "account.rate-limits.updated",
      eventId: asEventId("provider-usage"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex-personal"),
      createdAt: "2026-07-29T15:00:00.000Z",
      threadId: asThreadId("thread-usage"),
      payload: {
        rateLimits: {
          rateLimits: {
            primary: { usedPercent: 45, windowDurationMins: 300 },
          },
        },
      },
    });

    expect(activities).toEqual([
      expect.objectContaining({
        kind: "provider.usage.updated",
        summary: "Provider usage updated",
        payload: {
          provider: "codex",
          providerInstanceId: "codex-personal",
          rateLimits: {
            rateLimits: {
              primary: { usedPercent: 45, windowDurationMins: 300 },
            },
          },
        },
      }),
    ]);
  });
});

describe("delivery receipt projection", () => {
  it("unwraps synthetic recovery delivery ids so the origin message reads delivered", () => {
    const activities = runtimeEventToActivities({
      type: "message.delivered",
      eventId: asEventId("delivery-receipt"),
      provider: ProviderDriverKind.make("mcpBridge"),
      createdAt: "2026-08-14T03:20:45.000Z",
      threadId: asThreadId("thread-delivery"),
      turnId: asTurnId("turn-delivery"),
      payload: {
        messageId: MessageId.make(
          "active-turn-recovery-delivery:f85f56d3-44b7-4710-aa8e-6e2f8f0f65a1:979966b2-c7dd-42f6-8560-98f4613ff8bc",
        ),
      },
    });
    expect(activities).toEqual([
      expect.objectContaining({
        kind: "message.delivered",
        payload: {
          messageId:
            "active-turn-recovery-delivery:f85f56d3-44b7-4710-aa8e-6e2f8f0f65a1:979966b2-c7dd-42f6-8560-98f4613ff8bc",
        },
      }),
      expect.objectContaining({
        id: "delivery-receipt:origin",
        kind: "message.delivered",
        payload: { messageId: "979966b2-c7dd-42f6-8560-98f4613ff8bc" },
      }),
    ]);
  });

  it("keeps ordinary delivery receipts single", () => {
    const activities = runtimeEventToActivities({
      type: "message.delivered",
      eventId: asEventId("plain-receipt"),
      provider: ProviderDriverKind.make("mcpBridge"),
      createdAt: "2026-08-14T03:20:45.000Z",
      threadId: asThreadId("thread-delivery"),
      payload: { messageId: MessageId.make("message-plain") },
    });
    expect(activities).toHaveLength(1);
    expect(activities[0]?.payload).toEqual({ messageId: "message-plain" });
  });
});

describe("Token Optimizer activity projection", () => {
  it("projects optimizer telemetry as a first-class informational activity", () => {
    const [activity] = runtimeEventToActivities({
      type: "runtime.warning",
      eventId: asEventId("optimizer-applied"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-07-31T00:00:00.000Z",
      threadId: asThreadId("thread-optimizer"),
      turnId: asTurnId("turn-optimizer"),
      payload: {
        message: "Optimized 2 pages · saved ~1,200 tokens",
        detail: {
          kind: "token-optimizer.applied",
          compressedChars: 42_000,
          pageCount: 2,
          estimatedTokensSaved: 1_200,
          attachments: [],
        },
      },
      providerRefs: {},
    });

    expect(activity).toMatchObject({
      kind: "token-optimizer.applied",
      tone: "info",
      summary: "Optimized 2 pages · saved ~1,200 tokens",
      turnId: "turn-optimizer",
      payload: {
        compressedChars: 42_000,
        pageCount: 2,
        estimatedTokensSaved: 1_200,
      },
    });
  });
});

describe("provider overload retry activity projection", () => {
  it("projects only the structured running retry reason for the chat status UI", () => {
    const base = {
      eventId: asEventId("provider-overload-retry"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-07-29T15:00:00.000Z",
      threadId: asThreadId("thread-overload"),
      turnId: asTurnId("turn-overload"),
      type: "session.state.changed" as const,
    };
    const activities = runtimeEventToActivities({
      ...base,
      payload: {
        state: "running",
        reason: "provider_overloaded:retrying;attempt=2;max=5;delay_ms=1000",
      },
    });
    expect(activities).toEqual([
      expect.objectContaining({
        id: "provider-upstream-retry:thread-overload:turn-overload",
        kind: "provider.overload.retrying",
        summary: "Provider unavailable — retrying shortly",
        turnId: "turn-overload",
      }),
    ]);
    expect(
      runtimeEventToActivities({
        ...base,
        eventId: asEventId("provider-overload-retry-later"),
        payload: { state: "running", reason: "provider_overloaded:retrying;attempt=3" },
      }),
    ).toEqual([
      expect.objectContaining({
        id: activities[0]?.id,
        kind: "provider.overload.retrying",
      }),
    ]);
    expect(
      runtimeEventToActivities({
        ...base,
        eventId: asEventId("ordinary-running"),
        payload: { state: "running", reason: "working" },
      }),
    ).toEqual([]);
  });

  it("collapses ACP thought-chunk reasoning items onto one thinking activity", () => {
    const first = runtimeEventToActivities({
      eventId: asEventId("thought-1"),
      provider: ProviderDriverKind.make("grok"),
      createdAt: "2026-08-19T17:00:00.000Z",
      threadId: asThreadId("thread-grok"),
      turnId: asTurnId("turn-grok"),
      type: "item.updated",
      itemId: "thread-grok:reasoning" as never,
      payload: {
        itemType: "reasoning",
        status: "inProgress",
        title: "Thinking",
      },
    });
    const second = runtimeEventToActivities({
      eventId: asEventId("thought-2"),
      provider: ProviderDriverKind.make("grok"),
      createdAt: "2026-08-19T17:00:01.000Z",
      threadId: asThreadId("thread-grok"),
      turnId: asTurnId("turn-grok"),
      type: "item.updated",
      itemId: "thread-grok:reasoning" as never,
      payload: {
        itemType: "reasoning",
        status: "inProgress",
        title: "Thinking",
      },
    });
    expect(first).toEqual([
      expect.objectContaining({
        id: "reasoning:thread-grok:turn-grok",
        kind: "reasoning.updated",
        summary: "Thinking",
        turnId: "turn-grok",
      }),
    ]);
    expect(second[0]?.id).toBe(first[0]?.id);
  });

  it("does not append a visible error row for a durable upstream retry", () => {
    expect(
      runtimeEventToActivities({
        eventId: asEventId("retryable-runtime-error"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-07-29T15:00:00.000Z",
        threadId: asThreadId("thread-overload"),
        turnId: asTurnId("turn-overload"),
        type: "runtime.error",
        payload: {
          message: "pxpipe upstream unreachable",
          class: "provider_error",
          failureKind: "retryable-upstream",
        },
        providerRefs: {},
      }),
    ).toEqual([]);
  });
});

function makeProviderSnapshot(input: {
  readonly instanceId: string;
  readonly driver: string;
  readonly model: string;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [
      {
        slug: input.model,
        name: input.model,
        isCustom: false,
        isDefault: true,
        capabilities: null,
      },
    ],
    slashCommands: [],
    skills: [],
  };
}

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderRuntimeEvent["provider"];
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

type LegacyTurnCompletedEvent = LegacyProviderRuntimeEvent & {
  readonly type: "turn.completed";
  readonly payload?: undefined;
  readonly status: "completed" | "failed" | "interrupted" | "cancelled";
  readonly errorMessage?: string | undefined;
};

function isLegacyTurnCompletedEvent(
  event: LegacyProviderRuntimeEvent,
): event is LegacyTurnCompletedEvent {
  return (
    event.type === "turn.completed" &&
    event.payload === undefined &&
    typeof event.status === "string"
  );
}

function createProviderServiceHarness() {
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const runtimeSessions: ProviderSession[] = [];
  const startSessionCalls: Array<{
    readonly threadId: ThreadId;
    readonly input: ProviderSessionStartInput;
  }> = [];
  const sendTurnCalls: ProviderSendTurnInput[] = [];
  const interruptTurnCalls: Array<Parameters<ProviderServiceShape["interruptTurn"]>[0]> = [];
  let shouldFailNextSendTurn = false;

  const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
  const service: ProviderServiceShape = {
    startSession: (threadId, input) =>
      Effect.sync(() => {
        startSessionCalls.push({ threadId, input });
        const now = "2026-01-01T00:00:00.000Z";
        const session: ProviderSession = {
          provider: input.provider ?? ProviderDriverKind.make(String(input.providerInstanceId)),
          providerInstanceId: input.providerInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          threadId,
          createdAt: now,
          updatedAt: now,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
          ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        };
        const existingIndex = runtimeSessions.findIndex((entry) => entry.threadId === threadId);
        if (existingIndex >= 0) {
          runtimeSessions[existingIndex] = session;
        } else {
          runtimeSessions.push(session);
        }
        return session;
      }),
    sendTurn: (input) =>
      Effect.sync(() => {
        sendTurnCalls.push(input);
        if (shouldFailNextSendTurn) {
          shouldFailNextSendTurn = false;
          throw new Error("Simulated handoff send failure");
        }
        return {
          threadId: input.threadId,
          turnId: TurnId.make(`handoff-turn-${sendTurnCalls.length}`),
        };
      }),
    interruptTurn: (input) =>
      Effect.sync(() => {
        interruptTurnCalls.push(input);
      }),
    promoteQueuedTurn: () => unsupported(),
    stopTask: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions: () => Effect.succeed([...runtimeSessions]),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    getInstanceInfo: (instanceId) => {
      const driverKind = ProviderDriverKind.make(String(instanceId));
      return Effect.succeed({
        instanceId,
        driverKind,
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind,
          continuationKey: `${driverKind}:instance:${instanceId}`,
        },
      });
    },
    rollbackConversation: () => unsupported(),
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  const setSession = (session: ProviderSession): void => {
    const existingIndex = runtimeSessions.findIndex((entry) => entry.threadId === session.threadId);
    if (existingIndex >= 0) {
      runtimeSessions[existingIndex] = session;
      return;
    }
    runtimeSessions.push(session);
  };

  const normalizeLegacyEvent = (event: LegacyProviderRuntimeEvent): ProviderRuntimeEvent => {
    if (isLegacyTurnCompletedEvent(event)) {
      const normalized: Extract<ProviderRuntimeEvent, { type: "turn.completed" }> = {
        ...(event as Omit<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>, "payload">),
        payload: {
          state: event.status,
          ...(typeof event.errorMessage === "string" ? { errorMessage: event.errorMessage } : {}),
        },
      };
      return normalized;
    }

    return event as ProviderRuntimeEvent;
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, normalizeLegacyEvent(event)));
  };

  return {
    service,
    emit,
    setSession,
    startSessionCalls,
    sendTurnCalls,
    interruptTurnCalls,
    failNextSendTurn: () => {
      shouldFailNextSendTurn = true;
    },
  };
}

type ProviderRuntimeTestReadModel = OrchestrationReadModel;
type ProviderRuntimeTestThread = ProviderRuntimeTestReadModel["threads"][number];
type ProviderRuntimeTestMessage = ProviderRuntimeTestThread["messages"][number];
type ProviderRuntimeTestProposedPlan = ProviderRuntimeTestThread["proposedPlans"][number];
type ProviderRuntimeTestActivity = ProviderRuntimeTestThread["activities"][number];
type ProviderRuntimeTestCheckpoint = ProviderRuntimeTestThread["checkpoints"][number];

async function waitForThread(
  readModel: () => Promise<ProviderRuntimeTestReadModel>,
  predicate: (thread: ProviderRuntimeTestThread) => boolean,
  timeoutMs = 2000,
  threadId: ThreadId = asThreadId("thread-1"),
) {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<ProviderRuntimeTestThread> => {
    const snapshot = await readModel();
    const thread = snapshot.threads.find((entry) => entry.id === threadId);
    if (thread && predicate(thread)) {
      return thread;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for thread state");
    }
    await Effect.runPromise(Effect.yieldNow);
    return poll();
  };
  return poll();
}

describe("ProviderRuntimeIngestion", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | ProviderRuntimeIngestionService
    | ProjectionSnapshotQuery
    | SqlClient.SqlClient,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const dir of tempDirs.splice(0)) {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function createHarness(options?: {
    serverSettings?: Partial<ServerSettings>;
    providers?: ReadonlyArray<ServerProvider>;
    interactionMode?: "default" | "plan" | "agent";
  }) {
    const workspaceRoot = makeTempDir("t3-provider-project-");
    NodeFS.mkdirSync(NodePath.join(workspaceRoot, ".git"));
    const provider = createProviderServiceHarness();
    const runtimeObservations: Array<Parameters<ThreadWorkSchedulerShape["observeRuntime"]>[0]> =
      [];
    const threadWorkSchedulerLayer = Layer.succeed(ThreadWorkScheduler, {
      start: () => Effect.void,
      wake: () => Effect.void,
      registerHandler: () => Effect.void,
      unregisterHandler: () => Effect.void,
      observeRuntime: (input) =>
        Effect.sync(() => {
          runtimeObservations.push(input);
          return true;
        }),
      runtimeLivenessAt: () => Effect.succeed(Option.none()),
      setAdmissionParked: () => Effect.void,
      snapshot: Effect.succeed({
        activeGlobal: 0,
        activeByProvider: {},
        activeRecoveryByProvider: {},
        activeThreads: [],
        schedulerWindowSize: 0,
        runtimeByThread: {},
      }),
    } satisfies ThreadWorkSchedulerShape);
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const previewSessions: PreviewSessionSnapshot[] = [];
    let previewSequence = 0;
    const openPreviewTab = (threadId: ThreadId) => {
      previewSequence += 1;
      const snapshot: PreviewSessionSnapshot = {
        threadId,
        tabId: `tab-test-${previewSequence}`,
        navStatus: { _tag: "Idle" },
        canGoBack: false,
        canGoForward: false,
        viewport: FILL_PREVIEW_VIEWPORT,
        updatedAt: `2026-08-25T12:00:${String(previewSequence).padStart(2, "0")}.000Z`,
      };
      previewSessions.push(snapshot);
      return snapshot;
    };
    const previewLayer = Layer.mock(PreviewManager.PreviewManager)({
      list: ({ threadId }) =>
        Effect.succeed({
          sessions: previewSessions.filter((session) => session.threadId === threadId),
          serverEpoch: "provider-runtime-ingestion-test",
          revision: previewSequence,
        }),
    });
    const layer = ProviderRuntimeIngestionLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(makeProviderRegistryLayer(options?.providers)),
      Layer.provideMerge(threadWorkSchedulerLayer),
      Layer.provideMerge(makeTestServerSettingsLayer(options?.serverSettings)),
      Layer.provideMerge(previewLayer),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(NodeServices.layer),
    );
    const managedRuntime = ManagedRuntime.make(layer);
    runtime = managedRuntime;
    const engine = await managedRuntime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await managedRuntime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const ingestion = await managedRuntime.runPromise(
      Effect.service(ProviderRuntimeIngestionService),
    );
    const sql = await managedRuntime.runPromise(Effect.service(SqlClient.SqlClient));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(ingestion.start().pipe(Scope.provide(scope)));
    const drain = () => Effect.runPromise(ingestion.drain);

    const createdAt = "2026-01-01T00:00:00.000Z";
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-provider-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot,
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create"),
        threadId: ThreadId.make("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: options?.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-seed"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    provider.setSession({
      provider: ProviderDriverKind.make("codex"),
      status: "ready",
      runtimeMode: "approval-required",
      threadId: ThreadId.make("thread-1"),
      createdAt,
      updatedAt: createdAt,
    });

    return {
      engine,
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      readThreadShell: (threadId: ThreadId) =>
        managedRuntime.runPromise(snapshotQuery.getThreadShellById(threadId)),
      emit: provider.emit,
      setProviderSession: provider.setSession,
      startSessionCalls: provider.startSessionCalls,
      sendTurnCalls: provider.sendTurnCalls,
      interruptTurnCalls: provider.interruptTurnCalls,
      failNextSendTurn: provider.failNextSendTurn,
      runtimeObservations,
      openPreviewTab,
      readBrowserTabCleanupState: (threadId: ThreadId) =>
        managedRuntime.runPromise(
          sql<{
            readonly tabSetJson: string;
            readonly lastProcessedTurnId: string | null;
            readonly lastProcessedStartSequence: number;
          }>`
            SELECT
              tab_set_json AS "tabSetJson",
              last_processed_turn_id AS "lastProcessedTurnId",
              last_processed_start_sequence AS "lastProcessedStartSequence"
            FROM browser_tab_cleanup_state
            WHERE thread_id = ${threadId}
          `,
        ),
      readThreadWork: (threadId: ThreadId) =>
        managedRuntime.runPromise(
          sql<{
            readonly kind: string;
            readonly sourceTurnId: string;
            readonly state: string;
          }>`
            SELECT
              kind,
              source_turn_id AS "sourceTurnId",
              state
            FROM thread_work_obligations
            WHERE thread_id = ${threadId}
            ORDER BY kind ASC, source_turn_id ASC
          `,
        ),
      seedProviderRuntimePayload: (input: {
        readonly threadId: ThreadId;
        readonly providerInstanceId: ProviderInstanceId;
        readonly runtimePayload: Readonly<Record<string, unknown>>;
      }) =>
        managedRuntime.runPromise(
          sql`
            INSERT INTO provider_session_runtime (
              thread_id,
              provider_name,
              provider_instance_id,
              adapter_key,
              runtime_mode,
              status,
              last_seen_at,
              resume_cursor_json,
              runtime_payload_json
            )
            VALUES (
              ${input.threadId},
              ${"codex"},
              ${input.providerInstanceId},
              ${"codex"},
              ${"approval-required"},
              ${"running"},
              ${"2026-08-27T12:00:00.000Z"},
              NULL,
              ${JSON.stringify(input.runtimePayload)}
            )
          `,
        ),
      readProviderRuntimePayload: (threadId: ThreadId) =>
        managedRuntime
          .runPromise(
            sql<{ readonly runtimePayloadJson: string | null }>`
              SELECT runtime_payload_json AS "runtimePayloadJson"
              FROM provider_session_runtime
              WHERE thread_id = ${threadId}
            `,
          )
          .then((rows) => {
            const serialized = rows[0]?.runtimePayloadJson;
            return serialized === null || serialized === undefined
              ? null
              : (JSON.parse(serialized) as unknown);
          }),
      drain,
    };
  }

  it("clears only the exactly delivered persisted context recovery marker", async () => {
    const harness = await createHarness();
    const threadId = asThreadId("thread-1");
    const providerInstanceId = ProviderInstanceId.make("codex-personal");
    const sourceMessageId = asMessageId("message-context-recovery");
    const pendingContextRecovery = {
      version: 1,
      kind: "native-resume-timeout",
      sourceMessageId,
      providerInstanceId,
      createdAt: "2026-08-27T12:00:00.000Z",
    } as const;
    await harness.seedProviderRuntimePayload({
      threadId,
      providerInstanceId,
      runtimePayload: {
        pendingContextRecovery,
        activeTurnId: "turn-context-recovery",
        preserved: "keep-me",
      },
    });

    harness.emit({
      type: "message.delivered",
      eventId: asEventId("delivery-context-recovery-wrong-message"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId,
      threadId,
      createdAt: "2026-08-27T12:00:01.000Z",
      payload: { messageId: asMessageId("message-other") },
    });
    harness.emit({
      type: "message.delivered",
      eventId: asEventId("delivery-context-recovery-wrong-instance"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex-other"),
      threadId,
      createdAt: "2026-08-27T12:00:02.000Z",
      payload: { messageId: sourceMessageId },
    });
    await harness.drain();

    expect(await harness.readProviderRuntimePayload(threadId)).toEqual({
      pendingContextRecovery,
      activeTurnId: "turn-context-recovery",
      preserved: "keep-me",
    });

    harness.emit({
      type: "message.delivered",
      eventId: asEventId("delivery-context-recovery-exact"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId,
      threadId,
      createdAt: "2026-08-27T12:00:03.000Z",
      payload: { messageId: sourceMessageId },
    });
    await harness.drain();

    expect(await harness.readProviderRuntimePayload(threadId)).toEqual({
      pendingContextRecovery: null,
      activeTurnId: "turn-context-recovery",
      preserved: "keep-me",
    });
    expect(harness.sendTurnCalls).toHaveLength(0);
  });

  it("maps turn started/completed events into thread session updates", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: now,
      turnId: asTurnId("turn-1"),
    });

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === "running" && thread.session?.activeTurnId === "turn-1",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:00.000Z",
      turnId: asTurnId("turn-1"),
      payload: {
        state: "failed",
        errorMessage: "turn failed",
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "turn failed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("turn failed");
    expect(harness.runtimeObservations).toContainEqual({
      threadId: asThreadId("thread-1"),
      activeTurnId: asTurnId("turn-1"),
      phase: "provider-running",
    });
  });

  it("queues one changed-tab cleanup turn and suppresses its own completion", async () => {
    const harness = await createHarness({ interactionMode: "agent" });
    const threadId = asThreadId("thread-1");
    harness.openPreviewTab(threadId);

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-browser-work-started"),
      provider: ProviderDriverKind.make("codex"),
      threadId,
      createdAt: "2026-08-25T12:00:00.000Z",
      turnId: asTurnId("turn-browser-work"),
    });
    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.activeTurnId === "turn-browser-work",
    );
    await harness.drain();
    harness.openPreviewTab(threadId);

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-browser-work-assistant-delta"),
      provider: ProviderDriverKind.make("codex"),
      threadId,
      createdAt: "2026-08-25T12:00:30.000Z",
      turnId: asTurnId("turn-browser-work"),
      itemId: asItemId("item-browser-work-assistant"),
      payload: {
        streamKind: "assistant_text",
        delta: "This phase is complete and more work remains.",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-browser-work-assistant-completed"),
      provider: ProviderDriverKind.make("codex"),
      threadId,
      createdAt: "2026-08-25T12:00:31.000Z",
      turnId: asTurnId("turn-browser-work"),
      itemId: asItemId("item-browser-work-assistant"),
      payload: { itemType: "assistant_message", status: "completed" },
    });
    await harness.drain();

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-browser-work-completed"),
      provider: ProviderDriverKind.make("codex"),
      threadId,
      createdAt: "2026-08-25T12:01:00.000Z",
      turnId: asTurnId("turn-browser-work"),
      payload: { state: "completed" },
    });

    const reminded = await waitForThread(harness.readModel, (thread) =>
      thread.messages.some((message) =>
        String(message.id).startsWith("browser-tab-cleanup-message:thread-1:turn-browser-work"),
      ),
    );
    const reminder = reminded.messages.find((message) =>
      String(message.id).startsWith("browser-tab-cleanup-message:"),
    );
    expect(reminder).toMatchObject({ role: "user", inputOrigin: "agent-loop" });
    expect(reminder?.text).toContain("2 tabs are open");
    expect(reminder?.text).not.toContain("tab_");
    expect(await harness.readThreadWork(threadId)).toEqual([
      {
        kind: "active-turn-recovery",
        sourceTurnId: "turn-start:browser-tab-cleanup-message:thread-1:turn-browser-work",
        state: "pending",
      },
      {
        kind: "agent-continuation",
        sourceTurnId: "turn-browser-work",
        state: "cancelled",
      },
    ]);
    expect(await harness.readBrowserTabCleanupState(threadId)).toEqual([
      {
        tabSetJson: '["tab-test-1","tab-test-2"]',
        lastProcessedTurnId: "turn-browser-work",
        lastProcessedStartSequence: 1,
      },
    ]);

    // A provider replay cannot enqueue a second message: the durable receipt
    // and deterministic command/message IDs both identify the source turn.
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-browser-work-completed-replay"),
      provider: ProviderDriverKind.make("codex"),
      threadId,
      createdAt: "2026-08-25T12:01:01.000Z",
      turnId: asTurnId("turn-browser-work"),
      payload: { state: "completed" },
    });
    await harness.drain();
    expect(
      (await harness.readModel())?.threads
        .find((thread) => thread.id === threadId)
        ?.messages.filter((message) =>
          String(message.id).startsWith("browser-tab-cleanup-message:"),
        ),
    ).toHaveLength(1);

    // Even if the set changes during the housekeeping turn, that turn records
    // the new baseline instead of recursively creating another reminder.
    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-browser-cleanup-started"),
      provider: ProviderDriverKind.make("codex"),
      threadId,
      createdAt: "2026-08-25T12:02:00.000Z",
      turnId: asTurnId("turn-browser-cleanup"),
    });
    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.activeTurnId === "turn-browser-cleanup",
    );
    await harness.drain();
    harness.openPreviewTab(threadId);
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-browser-cleanup-completed"),
      provider: ProviderDriverKind.make("codex"),
      threadId,
      createdAt: "2026-08-25T12:03:00.000Z",
      turnId: asTurnId("turn-browser-cleanup"),
      payload: { state: "completed" },
    });
    await harness.drain();
    expect(
      (await harness.readModel())?.threads
        .find((thread) => thread.id === threadId)
        ?.messages.filter((message) =>
          String(message.id).startsWith("browser-tab-cleanup-message:"),
        ),
    ).toHaveLength(1);
  });

  it("does not start browser housekeeping while human input is pending", async () => {
    const harness = await createHarness({ interactionMode: "agent" });
    const threadId = asThreadId("thread-1");
    harness.openPreviewTab(threadId);

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-human-gate-turn-started"),
      provider: ProviderDriverKind.make("codex"),
      threadId,
      createdAt: "2026-08-25T13:00:00.000Z",
      turnId: asTurnId("turn-human-gate"),
    });
    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.activeTurnId === "turn-human-gate",
    );
    await harness.drain();
    harness.openPreviewTab(threadId);

    harness.emit({
      type: "user-input.requested",
      eventId: asEventId("evt-human-gate-request"),
      provider: ProviderDriverKind.make("codex"),
      threadId,
      turnId: asTurnId("turn-human-gate"),
      requestId: ApprovalRequestId.make("action-approval:human-gate"),
      createdAt: "2026-08-25T13:00:30.000Z",
      payload: {
        questions: [
          {
            id: "t3_action_approval",
            header: "Approval",
            question: "Authorize this action?",
            options: [{ label: "Approve", description: "Perform the action." }],
          },
        ],
      },
    });
    await harness.drain();
    const pendingShell = await harness.readThreadShell(threadId);
    expect(Option.getOrThrow(pendingShell).hasPendingUserInput).toBe(true);

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-human-gate-turn-completed"),
      provider: ProviderDriverKind.make("codex"),
      threadId,
      createdAt: "2026-08-25T13:01:00.000Z",
      turnId: asTurnId("turn-human-gate"),
      payload: { state: "completed" },
    });
    await harness.drain();

    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    const completedShell = await harness.readThreadShell(threadId);
    expect(Option.getOrThrow(completedShell).hasPendingUserInput).toBe(true);
    expect(
      thread?.messages.filter((message) =>
        String(message.id).startsWith("browser-tab-cleanup-message:"),
      ),
    ).toEqual([]);
    expect(await harness.readBrowserTabCleanupState(threadId)).toEqual([
      {
        tabSetJson: '["tab-test-1"]',
        lastProcessedTurnId: null,
        lastProcessedStartSequence: 0,
      },
    ]);
  });

  it("durably ignores an older completion replay after a newer turn", async () => {
    const harness = await createHarness();
    const threadId = asThreadId("thread-1");
    harness.openPreviewTab(threadId);

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-browser-older-started"),
      provider: ProviderDriverKind.make("codex"),
      threadId,
      createdAt: "2026-08-25T15:00:00.000Z",
      turnId: asTurnId("turn-browser-older"),
    });
    await harness.drain();
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-browser-older-completed"),
      provider: ProviderDriverKind.make("codex"),
      threadId,
      createdAt: "2026-08-25T15:01:00.000Z",
      turnId: asTurnId("turn-browser-older"),
      payload: { state: "completed" },
    });
    await harness.drain();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-browser-newer-started"),
      provider: ProviderDriverKind.make("codex"),
      threadId,
      createdAt: "2026-08-25T15:02:00.000Z",
      turnId: asTurnId("turn-browser-newer"),
    });
    await harness.drain();
    harness.openPreviewTab(threadId);
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-browser-newer-completed"),
      provider: ProviderDriverKind.make("codex"),
      threadId,
      createdAt: "2026-08-25T15:03:00.000Z",
      turnId: asTurnId("turn-browser-newer"),
      payload: { state: "completed" },
    });
    await waitForThread(harness.readModel, (thread) =>
      thread.messages.some(
        (message) => message.id === "browser-tab-cleanup-message:thread-1:turn-browser-newer",
      ),
    );
    await harness.drain();

    // The replay arrives later in wall-clock order and the live tab set has
    // changed again. Its durable start sequence still identifies it as older.
    harness.openPreviewTab(threadId);
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-browser-older-completed-late-replay"),
      provider: ProviderDriverKind.make("codex"),
      threadId,
      createdAt: "2026-08-25T15:04:00.000Z",
      turnId: asTurnId("turn-browser-older"),
      payload: { state: "completed" },
    });
    await harness.drain();

    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(
      thread?.messages.filter((message) =>
        String(message.id).startsWith("browser-tab-cleanup-message:"),
      ),
    ).toHaveLength(1);
    expect(await harness.readBrowserTabCleanupState(threadId)).toEqual([
      {
        tabSetJson: '["tab-test-1","tab-test-2"]',
        lastProcessedTurnId: "turn-browser-newer",
        lastProcessedStartSequence: 2,
      },
    ]);
  });

  it("does not remind after accepted started turns fail, cancel, or interrupt", async () => {
    const harness = await createHarness();
    const threadId = asThreadId("thread-1");
    harness.openPreviewTab(threadId);

    // Auxiliary/recovered completion with no accepted start establishes a
    // baseline only; older tabs cannot be attributed to this turn.
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-browser-unknown-baseline"),
      provider: ProviderDriverKind.make("codex"),
      threadId,
      createdAt: "2026-08-25T13:00:00.000Z",
      turnId: asTurnId("turn-browser-unknown"),
      payload: { state: "completed" },
    });
    await harness.drain();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-browser-unchanged-started"),
      provider: ProviderDriverKind.make("codex"),
      threadId,
      createdAt: "2026-08-25T13:01:00.000Z",
      turnId: asTurnId("turn-browser-unchanged"),
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-browser-unchanged-completed"),
      provider: ProviderDriverKind.make("codex"),
      threadId,
      createdAt: "2026-08-25T13:02:00.000Z",
      turnId: asTurnId("turn-browser-unchanged"),
      payload: { state: "completed" },
    });
    for (const [index, state] of (["failed", "cancelled", "interrupted"] as const).entries()) {
      const turnId = asTurnId(`turn-browser-${state}`);
      harness.emit({
        type: "turn.started",
        eventId: asEventId(`evt-browser-${state}-started`),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: `2026-08-25T13:0${index + 3}:00.000Z`,
        turnId,
      });
      await harness.drain();
      harness.openPreviewTab(threadId);
      harness.emit({
        type: "turn.completed",
        eventId: asEventId(`evt-browser-${state}-completed`),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: `2026-08-25T13:0${index + 3}:30.000Z`,
        turnId,
        payload: state === "failed" ? { state, errorMessage: "failed" } : { state },
      });
      await harness.drain();
    }
    expect(
      (await harness.readModel())?.threads
        .find((thread) => thread.id === threadId)
        ?.messages.some((message) => String(message.id).startsWith("browser-tab-cleanup-message:")),
    ).toBe(false);
  });

  it("suppresses a late successful completion after the user stopped the projected turn", async () => {
    const harness = await createHarness();
    const threadId = asThreadId("thread-1");
    const turnId = asTurnId("turn-browser-user-stopped");
    harness.openPreviewTab(threadId);

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-browser-user-stopped-started"),
      provider: ProviderDriverKind.make("codex"),
      threadId,
      createdAt: "2026-08-25T14:00:00.000Z",
      turnId,
    });
    await harness.drain();
    harness.openPreviewTab(threadId);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-browser-user-stopped"),
        threadId,
        turnId,
        createdAt: "2026-08-25T14:01:00.000Z",
      }),
    );
    expect(
      (await harness.readModel()).threads.find((thread) => thread.id === threadId)?.latestTurn
        ?.state,
    ).toBe("interrupted");

    // Providers can race Stop and still emit a raw success. The cleanup hook
    // must consult the projection after ingestion instead of trusting it.
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-browser-user-stopped-late-completed"),
      provider: ProviderDriverKind.make("codex"),
      threadId,
      createdAt: "2026-08-25T14:02:00.000Z",
      turnId,
      payload: { state: "completed" },
    });
    await harness.drain();

    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(thread?.latestTurn?.state).toBe("interrupted");
    expect(
      thread?.messages.some((message) =>
        String(message.id).startsWith("browser-tab-cleanup-message:"),
      ),
    ).toBe(false);
  });

  it("does not enqueue browser cleanup after a streamed Agent stop and late success", async () => {
    const harness = await createHarness({ interactionMode: "agent" });
    const threadId = asThreadId("thread-1");
    const turnId = asTurnId("turn-browser-agent-stopped");
    harness.openPreviewTab(threadId);

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-browser-agent-stopped-started"),
      provider: ProviderDriverKind.make("grok"),
      threadId,
      createdAt: "2026-08-25T15:00:00.000Z",
      turnId,
    });
    await harness.drain();
    harness.openPreviewTab(threadId);

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-browser-agent-stopped-delta"),
      provider: ProviderDriverKind.make("grok"),
      threadId,
      createdAt: "2026-08-25T15:00:30.000Z",
      turnId,
      itemId: asItemId("item-browser-agent-stopped"),
      payload: {
        streamKind: "assistant_text",
        delta: "Everything requested is complete.\n\nAGENT_STOP",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-browser-agent-stopped-item-completed"),
      provider: ProviderDriverKind.make("grok"),
      threadId,
      createdAt: "2026-08-25T15:00:31.000Z",
      turnId,
      itemId: asItemId("item-browser-agent-stopped"),
      payload: { itemType: "assistant_message", status: "completed" },
    });
    await harness.drain();
    expect(harness.interruptTurnCalls).toEqual([{ threadId, turnId }]);

    // Grok's cancelled prompt can still settle its ACP request as a late
    // success. The streamed control stop is authoritative for housekeeping,
    // but it is not a failed user turn: keep the successful terminal state and
    // suppress only synthetic cleanup/continuation work.
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-browser-agent-stopped-late-success"),
      provider: ProviderDriverKind.make("grok"),
      threadId,
      createdAt: "2026-08-25T15:01:00.000Z",
      turnId,
      payload: { state: "completed" },
    });
    await harness.drain();

    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(thread?.session?.status).toBe("ready");
    expect(thread?.latestTurn?.state).toBe("completed");
    expect(
      thread?.messages.some((message) =>
        String(message.id).startsWith("browser-tab-cleanup-message:"),
      ),
    ).toBe(false);
    expect(await harness.readThreadWork(threadId)).toEqual([]);
    expect(await harness.readBrowserTabCleanupState(threadId)).toEqual([
      {
        tabSetJson: '["tab-test-1"]',
        lastProcessedTurnId: null,
        lastProcessedStartSequence: 0,
      },
    ]);
  });

  it("releases the thread when usage is exhausted and no failover target has quota", async () => {
    // Observed 2026-08-06: with every provider spent, the handler recorded the
    // "usage limit reached" activity and returned, leaving the session on
    // `running`. The silence watchdog then restarted the dead turn every ~4m36s
    // and the thread kept a working spinner nobody could clear. The row must be
    // released so the spinner stops and nothing restarts it.
    const harness = await createHarness({
      providers: [
        makeProviderSnapshot({
          instanceId: "codex",
          driver: "codex",
          model: "gpt-5-codex",
        }),
      ],
    });
    const now = "2026-01-01T00:00:10.000Z";
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-active-codex-no-target"),
        threadId: asThreadId("thread-1"),
        session: {
          threadId: asThreadId("thread-1"),
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-exhausted"),
          updatedAt: now,
          lastError: null,
        },
        createdAt: now,
      }),
    );

    harness.emit({
      type: "account.rate-limits.updated" as const,
      eventId: asEventId("evt-codex-limit-no-target"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: now,
      turnId: asTurnId("turn-exhausted"),
      payload: {
        rateLimits: {
          rateLimits: {
            rateLimitReachedType: "rate_limit_reached",
            primary: { usedPercent: 100, resetsAt: 1_800_000_000 },
          },
        },
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.activities.some((activity) => activity.kind === "provider.failover.unavailable") &&
        entry.session?.status === "error",
      10_000,
    );

    // Released: no active turn, and a status the spinner and the watchdog both
    // read as "not working".
    expect(thread.session?.activeTurnId).toBeNull();
    expect(thread.session?.lastError).toContain("usage limit reached");
    // Nothing was started anywhere else — there was nowhere to go.
    expect(harness.startSessionCalls).toHaveLength(0);
  });

  it("fails over exactly once from an exhausted active provider and hands off bounded JSON", async () => {
    const harness = await createHarness({
      providers: [
        makeProviderSnapshot({
          instanceId: "codex",
          driver: "codex",
          model: "gpt-5-codex",
        }),
        makeProviderSnapshot({
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          model: "claude-sonnet",
        }),
      ],
    });
    const now = "2026-01-01T00:00:10.000Z";
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-active-codex-for-failover"),
        threadId: asThreadId("thread-1"),
        session: {
          threadId: asThreadId("thread-1"),
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-exhausted"),
          updatedAt: now,
          lastError: null,
        },
        createdAt: now,
      }),
    );
    harness.setProviderSession({
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      threadId: asThreadId("thread-1"),
      activeTurnId: asTurnId("turn-exhausted"),
      cwd: process.cwd(),
      resumeCursor: { threadId: "codex-native-thread" },
      createdAt: now,
      updatedAt: now,
    });

    const exhaustedEvent = {
      type: "account.rate-limits.updated" as const,
      eventId: asEventId("evt-codex-limit-exhausted"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: now,
      turnId: asTurnId("turn-exhausted"),
      payload: {
        rateLimits: {
          rateLimits: {
            rateLimitReachedType: "rate_limit_reached",
            primary: { usedPercent: 100, resetsAt: 1_800_000_000 },
          },
        },
      },
    };
    harness.emit(exhaustedEvent);
    harness.emit({ ...exhaustedEvent, eventId: asEventId("evt-codex-limit-exhausted-replay") });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.modelSelection.instanceId === "claudeAgent" &&
        entry.session?.providerInstanceId === "claudeAgent" &&
        entry.activities.some((activity) => activity.kind === "provider.failover.completed"),
      10_000,
    );

    expect(thread.modelSelection).toEqual({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet",
    });
    expect(harness.startSessionCalls).toHaveLength(1);
    expect(harness.startSessionCalls[0]?.input.providerInstanceId).toBe("claudeAgent");
    expect(harness.sendTurnCalls).toHaveLength(1);
    const handoff = JSON.parse(harness.sendTurnCalls[0]?.input ?? "{}") as {
      kind?: string;
      handoff?: { from?: { instanceId?: string }; to?: { instanceId?: string } };
    };
    expect(handoff.kind).toBe("t3.provider-handoff");
    expect(handoff.handoff?.from?.instanceId).toBe("codex");
    expect(handoff.handoff?.to?.instanceId).toBe("claudeAgent");
  });

  it("does not fail over for a stale instance or an unsupported provider limit shape", async () => {
    const harness = await createHarness({
      providers: [
        makeProviderSnapshot({
          instanceId: "codex",
          driver: "codex",
          model: "gpt-5-codex",
        }),
        makeProviderSnapshot({
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          model: "claude-sonnet",
        }),
      ],
    });
    harness.emit({
      type: "account.rate-limits.updated",
      eventId: asEventId("evt-stale-codex-limit"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex_work"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:10.000Z",
      payload: {
        rateLimits: {
          rateLimits: {
            rateLimitReachedType: "rate_limit_reached",
          },
        },
      },
    });
    harness.emit({
      type: "account.rate-limits.updated",
      eventId: asEventId("evt-unsupported-cursor-limit"),
      provider: ProviderDriverKind.make("cursor"),
      providerInstanceId: ProviderInstanceId.make("cursor"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:11.000Z",
      payload: {
        rateLimits: {
          rate_limit_info: { status: "rejected" },
        },
      },
    });

    await Effect.runPromise(Effect.yieldNow);
    await harness.drain();
    await Effect.runPromise(Effect.yieldNow);
    await harness.drain();
    expect(harness.startSessionCalls).toHaveLength(0);
    expect(harness.sendTurnCalls).toHaveLength(0);
  });

  it("restores the previous session and leaves model selection unchanged when handoff send fails", async () => {
    const harness = await createHarness({
      providers: [
        makeProviderSnapshot({
          instanceId: "codex",
          driver: "codex",
          model: "gpt-5-codex",
        }),
        makeProviderSnapshot({
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          model: "claude-sonnet",
        }),
      ],
    });
    const now = "2026-01-01T00:00:10.000Z";
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-active-codex-for-rollback"),
        threadId: asThreadId("thread-1"),
        session: {
          threadId: asThreadId("thread-1"),
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-exhausted-rollback"),
          updatedAt: now,
          lastError: null,
        },
        createdAt: now,
      }),
    );
    harness.setProviderSession({
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      threadId: asThreadId("thread-1"),
      activeTurnId: asTurnId("turn-exhausted-rollback"),
      cwd: process.cwd(),
      resumeCursor: { threadId: "codex-native-thread" },
      createdAt: now,
      updatedAt: now,
    });
    harness.failNextSendTurn();
    harness.emit({
      type: "account.rate-limits.updated",
      eventId: asEventId("evt-codex-limit-handoff-fails"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: now,
      turnId: asTurnId("turn-exhausted-rollback"),
      payload: {
        rateLimits: {
          rateLimits: {
            rateLimitReachedType: "rate_limit_reached",
          },
        },
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.activities.some(
          (activity) =>
            activity.kind === "provider.failover.handoff.failed" &&
            (activity.payload as { rolledBack?: boolean }).rolledBack === true,
        ),
      10_000,
    );
    expect(thread.modelSelection).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    });
    expect(harness.startSessionCalls.map((call) => call.input.providerInstanceId)).toEqual([
      "claudeAgent",
      "codex",
    ]);
    expect(harness.startSessionCalls[1]?.input.resumeCursor).toEqual({
      threadId: "codex-native-thread",
    });
    expect(harness.sendTurnCalls).toHaveLength(1);
  });

  it("applies provider session.state.changed transitions directly", async () => {
    const harness = await createHarness();
    const waitingAt = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-waiting"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: waitingAt,
      payload: {
        state: "waiting",
        reason: "awaiting approval",
      },
    });

    let thread = await waitForThread(
      harness.readModel,
      (entry) => entry.session?.status === "running" && entry.session?.activeTurnId === null,
    );
    expect(thread.session?.status).toBe("running");
    expect(thread.session?.lastError).toBeNull();

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-error"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {
        state: "error",
        reason: "provider crashed",
      },
    });

    thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "provider crashed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("provider crashed");

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-stopped"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {
        state: "stopped",
      },
    });

    thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "stopped" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "provider crashed",
    );
    expect(thread.session?.status).toBe("stopped");
    expect(thread.session?.lastError).toBe("provider crashed");

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-ready"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {
        state: "ready",
      },
    });

    thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "ready" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === null,
    );
    expect(thread.session?.status).toBe("ready");
    expect(thread.session?.lastError).toBeNull();
  });

  it("clears active turn when provider session becomes ready", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-session-ready"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-session-ready"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-session-ready",
      10_000,
    );

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-ready-with-active-turn"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:01.000Z",
      payload: {
        state: "ready",
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "ready" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === null,
      10_000,
    );
    expect(thread.session?.status).toBe("ready");
    expect(thread.session?.activeTurnId).toBeNull();
    expect(thread.session?.lastError).toBeNull();
  });

  effectIt.effect(
    "keeps a reconnecting pending turn starting while ready clears stale active state",
    () =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() => createHarness());
        const threadId = asThreadId("thread-1");
        const staleTurnId = asTurnId("turn-stale-before-reconnect");

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-pending-reconnect"),
          threadId,
          message: {
            messageId: MessageId.make("message-pending-reconnect"),
            role: "user",
            text: "resume after reconnect",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: "2026-01-01T00:00:01.000Z",
        });
        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-starting-pending-reconnect"),
          threadId,
          session: {
            threadId,
            status: "starting",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: staleTurnId,
            lastError: null,
            updatedAt: "2026-01-01T00:00:01.000Z",
          },
          createdAt: "2026-01-01T00:00:01.000Z",
        });

        harness.emit({
          type: "session.state.changed",
          eventId: asEventId("evt-session-ready-pending-reconnect"),
          provider: ProviderDriverKind.make("codex"),
          threadId,
          createdAt: "2026-01-01T00:00:02.000Z",
          payload: { state: "ready" },
        });

        let thread = yield* Effect.promise(() =>
          waitForThread(
            harness.readModel,
            (entry) => entry.session?.status === "starting" && entry.session.activeTurnId === null,
          ),
        );
        expect(thread.session?.status).toBe("starting");
        expect(thread.session?.activeTurnId).toBeNull();

        harness.emit({
          type: "session.started",
          eventId: asEventId("evt-session-started-pending-reconnect"),
          provider: ProviderDriverKind.make("codex"),
          threadId,
          createdAt: "2026-01-01T00:00:03.000Z",
        });
        yield* Effect.promise(() => harness.drain());
        thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
          (entry) => entry.id === threadId,
        )!;
        expect(thread.session?.status).toBe("starting");
        expect(thread.session?.activeTurnId).toBeNull();

        harness.emit({
          type: "turn.started",
          eventId: asEventId("evt-turn-started-pending-reconnect"),
          provider: ProviderDriverKind.make("codex"),
          threadId,
          turnId: asTurnId("turn-after-reconnect"),
          createdAt: "2026-01-01T00:00:04.000Z",
        });
        thread = yield* Effect.promise(() =>
          waitForThread(
            harness.readModel,
            (entry) =>
              entry.session?.status === "running" &&
              entry.session.activeTurnId === asTurnId("turn-after-reconnect"),
          ),
        );
        expect(thread.session?.status).toBe("running");

        harness.emit({
          type: "session.started",
          eventId: asEventId("evt-session-started-duplicate-midturn"),
          provider: ProviderDriverKind.make("codex"),
          threadId,
          createdAt: "2026-01-01T00:00:05.000Z",
        });
        yield* Effect.promise(() => harness.drain());
        thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
          (entry) => entry.id === threadId,
        )!;
        expect(thread.session?.status).toBe("running");
        expect(thread.session?.activeTurnId).toBe(asTurnId("turn-after-reconnect"));
      }),
  );

  effectIt.effect("keeps an aborted pending start stopped across duplicate exit events", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() => createHarness());
      const threadId = asThreadId("thread-1");
      const stoppedAt = "2026-01-01T00:00:02.000Z";

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-stop"),
        threadId,
        message: {
          messageId: MessageId.make("message-before-stop"),
          role: "user",
          text: "stop this startup",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-starting-before-stop"),
        threadId,
        session: {
          threadId,
          status: "starting",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-stop-pending-start"),
        threadId,
        session: {
          threadId,
          status: "stopped",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: stoppedAt,
        },
        createdAt: stoppedAt,
      });

      harness.emit({
        type: "session.exited",
        eventId: asEventId("evt-session-exited-after-stop"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: "2026-01-01T00:00:03.000Z",
      });
      harness.emit({
        type: "session.exited",
        eventId: asEventId("evt-duplicate-session-exited-after-stop"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: "2026-01-01T00:00:04.000Z",
      });

      yield* Effect.promise(() => harness.drain());
      const thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (entry) => entry.id === threadId,
      );
      expect(thread?.session?.status).toBe("stopped");
      expect(thread?.session?.activeTurnId).toBeNull();
    }),
  );

  it("does not clear active turn when session/thread started arrives mid-turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-midturn-lifecycle"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-midturn-lifecycle"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-midturn-lifecycle",
      10_000,
    );

    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-started-midturn-lifecycle"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
    });
    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-session-started-midturn-lifecycle"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
    });

    await harness.drain();
    const midReadModel = await harness.readModel();
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-midturn-lifecycle");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-midturn-lifecycle"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-midturn-lifecycle"),
      status: "completed",
    });

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
      10_000,
    );
  });

  it("accepts claude turn lifecycle when seeded thread id is a synthetic placeholder", async () => {
    const harness = await createHarness();
    const seededAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-seed-claude-placeholder"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: seededAt,
          lastError: null,
        },
        createdAt: seededAt,
      }),
    );

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-claude-placeholder"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-placeholder"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-claude-placeholder",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-claude-placeholder"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-placeholder"),
      status: "completed",
    });

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("ignores auxiliary turn completions from a different provider thread", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-primary"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-primary"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-primary",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-aux"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-aux"),
      status: "completed",
    });

    await harness.drain();
    const midReadModel = await harness.readModel();
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-primary");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-primary"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-primary"),
      status: "completed",
    });

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("ignores non-active turn completion when runtime omits thread id", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-guarded"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-main"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-guarded-main",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-guarded-other"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-other"),
      status: "completed",
    });

    await harness.drain();
    const midReadModel = await harness.readModel();
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-guarded-main");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-guarded-main"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-main"),
      status: "completed",
    });

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("maps canonical content delta/item completed into finalized assistant messages", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-1"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-2"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        streamKind: "assistant_text",
        delta: " world",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-1" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-1",
    );
    expect(message?.text).toBe("hello world");
    expect(message?.streaming).toBe(false);
  });

  it("interrupts Agent mode at a streamed stop token and drops concatenated prose", async () => {
    const harness = await createHarness({ interactionMode: "agent" });
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-agent-stop-prefix"),
      provider: ProviderDriverKind.make("grok"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-agent-stop"),
      itemId: asItemId("item-agent-stop"),
      payload: {
        streamKind: "assistant_text",
        delta: "Finished.\n\nAGENT_",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-agent-stop-suffix"),
      provider: ProviderDriverKind.make("grok"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-agent-stop"),
      itemId: asItemId("item-agent-stop"),
      payload: {
        streamKind: "assistant_text",
        delta: "STOPI'll continue working.",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-agent-stop-late-delta"),
      provider: ProviderDriverKind.make("grok"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-agent-stop"),
      itemId: asItemId("item-agent-stop"),
      payload: {
        streamKind: "assistant_text",
        delta: " This must not be projected.",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-agent-stop-completed"),
      provider: ProviderDriverKind.make("grok"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-agent-stop"),
      itemId: asItemId("item-agent-stop"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });
    await harness.drain();

    const snapshot = await harness.readModel();
    const thread = snapshot.threads.find((entry) => entry.id === "thread-1");
    expect(
      thread?.messages.find((message) => message.id === "assistant:item-agent-stop")?.text,
    ).toBe("Finished.\n\nAGENT_STOP");
    expect(harness.interruptTurnCalls).toEqual([
      {
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-agent-stop"),
      },
    ]);
  });

  it("does not interrupt Agent mode for a stop-token mention in progress prose", async () => {
    const harness = await createHarness({ interactionMode: "agent" });
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-agent-stop-progress-mention"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-agent-stop-progress-mention"),
      itemId: asItemId("item-agent-stop-progress-mention"),
      payload: {
        streamKind: "assistant_text",
        delta:
          "I’m auditing the microphone and queued follow-ups/AGENT_STOP before the browser pass.",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-agent-stop-progress-mention-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-agent-stop-progress-mention"),
      itemId: asItemId("item-agent-stop-progress-mention"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });
    await harness.drain();

    const snapshot = await harness.readModel();
    const thread = snapshot.threads.find((entry) => entry.id === "thread-1");
    expect(
      thread?.messages.find(
        (message) => message.id === "assistant:item-agent-stop-progress-mention",
      )?.text,
    ).toBe("I’m auditing the microphone and queued follow-ups/AGENT_STOP before the browser pass.");
    expect(harness.interruptTurnCalls).toEqual([]);
  });

  it("uses assistant item completion detail when no assistant deltas were streamed", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-assistant-item-completed-no-delta"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-no-delta"),
      itemId: asItemId("item-no-delta"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "assistant-only final text",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-no-delta" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-no-delta",
    );
    expect(message?.text).toBe("assistant-only final text");
    expect(message?.streaming).toBe(false);
  });

  it("preserves completed tool metadata on projected tool activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-tool-completed-with-data"),
      provider: ProviderDriverKind.make("cursor"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-tool-completed"),
      itemId: asItemId("item-tool-completed"),
      payload: {
        itemType: "dynamic_tool_call",
        status: "completed",
        title: "Read file",
        data: {
          toolCallId: "tool-read-1",
          kind: "read",
          rawOutput: {
            content: 'import * as Effect from "effect/Effect"\n',
          },
        },
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-tool-completed-with-data",
      ),
    );
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-tool-completed-with-data",
    );
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;
    const data =
      payload?.data && typeof payload.data === "object"
        ? (payload.data as Record<string, unknown>)
        : undefined;
    const rawOutput =
      data?.rawOutput && typeof data.rawOutput === "object"
        ? (data.rawOutput as Record<string, unknown>)
        : undefined;

    expect(activity?.kind).toBe("tool.completed");
    expect(activity?.summary).toBe("Read file");
    expect(payload?.itemType).toBe("dynamic_tool_call");
    expect(payload?.detail).toBeUndefined();
    expect(data?.toolCallId).toBe("tool-read-1");
    expect(data?.kind).toBe("read");
    expect(rawOutput?.content).toBe('import * as Effect from "effect/Effect"\n');
  });

  it("normalizes command execution activities to ran-command summaries", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-completed"),
      provider: ProviderDriverKind.make("cursor"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-completed"),
      itemId: asItemId("item-command-completed"),
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "Ran command",
        detail: "bun run lint",
        data: {
          toolCallId: "tool-command-1",
          kind: "execute",
          command: "bun run lint",
        },
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-command-completed",
      ),
    );
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-command-completed",
    );
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;

    expect(activity?.summary).toBe("Ran command");
    expect(payload?.detail).toBe("bun run lint");
  });

  it("uses structured read-file paths when available", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-read-path-completed"),
      provider: ProviderDriverKind.make("cursor"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-read-path"),
      itemId: asItemId("item-read-path"),
      payload: {
        itemType: "dynamic_tool_call",
        status: "completed",
        title: "Read file",
        detail: "/tmp/app.ts",
        data: {
          toolCallId: "tool-read-path-1",
          kind: "read",
          locations: [{ path: "/tmp/app.ts" }],
        },
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-read-path-completed",
      ),
    );
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-read-path-completed",
    );
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;

    expect(activity?.summary).toBe("Read file");
    expect(payload?.detail).toBe("/tmp/app.ts");
  });

  it("projects completed plan items into first-class proposed plans", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-item-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-final"),
      payload: {
        planMarkdown: "## Ship plan\n\n- wire projection\n- render follow-up",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.proposedPlans.some(
        (proposedPlan: ProviderRuntimeTestProposedPlan) =>
          proposedPlan.id === "plan:thread-1:turn:turn-plan-final",
      ),
    );
    const proposedPlan = thread.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) => entry.id === "plan:thread-1:turn:turn-plan-final",
    );
    expect(proposedPlan?.planMarkdown).toBe(
      "## Ship plan\n\n- wire projection\n- render follow-up",
    );
  });

  it("marks the source proposed plan implemented only after the target turn starts", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-plan");
    const targetThreadId = asThreadId("thread-implement");
    const sourceTurnId = asTurnId("turn-plan-source");
    const targetTurnId = asTurnId("turn-plan-implement");
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create-plan-source"),
        threadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Source",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-plan-source"),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create-plan-target"),
        threadId: targetThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Target",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-plan-target"),
        threadId: targetThreadId,
        session: {
          threadId: targetThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    harness.setProviderSession({
      provider: ProviderDriverKind.make("codex"),
      status: "ready",
      runtimeMode: "approval-required",
      threadId: targetThreadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId: targetTurnId,
    });

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-source-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Source plan",
      },
    });

    const sourceThreadWithPlan = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
            proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-plan:turn:turn-plan-source",
    );
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) {
      throw new Error("Expected source plan to exist.");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-plan-target"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-target"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const sourceThreadBeforeStart = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === sourcePlan.id && proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    expect(
      sourceThreadBeforeStart.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-plan-target-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: targetThreadId,
      turnId: targetTurnId,
    });

    const sourceThreadAfterStart = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === sourcePlan.id &&
            proposedPlan.implementedAt !== null &&
            proposedPlan.implementationThreadId === targetThreadId,
        ),
      2_000,
      sourceThreadId,
    );
    expect(
      sourceThreadAfterStart.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementationThreadId: "thread-implement",
    });
  });

  it("does not mark the source proposed plan implemented for a rejected turn.started event", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-plan");
    const targetThreadId = asThreadId("thread-1");
    const sourceTurnId = asTurnId("turn-plan-source");
    const activeTurnId = asTurnId("turn-already-running");
    const staleTurnId = asTurnId("turn-stale-start");
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      Effect.andThen(
        harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-create-plan-source-guarded"),
          threadId: sourceThreadId,
          projectId: asProjectId("project-1"),
          title: "Plan Source",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "plan",
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set-plan-source-guarded"),
          threadId: sourceThreadId,
          session: {
            threadId: sourceThreadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            updatedAt: createdAt,
            lastError: null,
          },
          createdAt,
        }),
      ),
    );
    harness.setProviderSession({
      provider: ProviderDriverKind.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      threadId: targetThreadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId,
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-already-running"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: targetThreadId,
      turnId: activeTurnId,
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === activeTurnId,
      2_000,
      targetThreadId,
    );

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-source-completed-guarded"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Source plan",
      },
    });

    const sourceThreadWithPlan = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
            proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-plan:turn:turn-plan-source",
    );
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) {
      throw new Error("Expected source plan to exist.");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-plan-target-guarded"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-target-guarded"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-stale-plan-implementation"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: targetThreadId,
      turnId: staleTurnId,
    });

    await harness.drain();

    const readModel = await harness.readModel();
    const sourceThreadAfterRejectedStart = readModel.threads.find(
      (entry) => entry.id === sourceThreadId,
    );
    expect(
      sourceThreadAfterRejectedStart?.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    });

    const targetThreadAfterRejectedStart = readModel.threads.find(
      (entry) => entry.id === targetThreadId,
    );
    expect(targetThreadAfterRejectedStart?.session?.status).toBe("running");
    expect(targetThreadAfterRejectedStart?.session?.activeTurnId).toBe(activeTurnId);
  });

  it("accepts a conflicting turn.started for a pending turn start when the provider expects that turn", async () => {
    // Steering a running turn: the server requests a new turn while the old
    // one is still active, and providers like opencode open the new turn
    // without ever completing the superseded one. The new turn.started must
    // replace the active turn instead of being rejected as stale.
    const harness = await createHarness();
    const threadId = asThreadId("thread-1");
    const oldTurnId = asTurnId("turn-steered-over");
    const newTurnId = asTurnId("turn-from-steer");
    const createdAt = "2026-01-01T00:00:00.000Z";

    harness.setProviderSession({
      provider: ProviderDriverKind.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      threadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId: oldTurnId,
    });
    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-steered-over"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId: oldTurnId,
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === oldTurnId,
      2_000,
      threadId,
    );

    // The steer: a user-requested turn start while the old turn still runs.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-steer"),
        threadId,
        message: {
          messageId: asMessageId("msg-steer"),
          role: "user",
          text: "actually, do 15 instead",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    // The provider session tracks the new turn before emitting turn.started
    // (sendTurn updates the session first).
    harness.setProviderSession({
      provider: ProviderDriverKind.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      threadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId: newTurnId,
    });
    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-from-steer"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId: newTurnId,
    });

    const threadAfterSteer = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === newTurnId,
      2_000,
      threadId,
    );
    expect(threadAfterSteer.session?.activeTurnId).toBe(newTurnId);
    expect(threadAfterSteer.latestTurn?.turnId).toBe(newTurnId);
    expect(threadAfterSteer.latestTurn?.state).toBe("running");
  });

  it("does not attribute a newer pending plan to a replayed turn.started event", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-plan-replayed-start");
    const targetThreadId = asThreadId("thread-1");
    const sourceTurnId = asTurnId("turn-plan-replayed-start-source");
    const activeTurnId = asTurnId("turn-plan-replayed-start-active");
    const pendingTurnId = asTurnId("turn-plan-replayed-start-pending");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create-plan-replayed-start-source"),
        threadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        title: "Replayed Start Plan Source",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-replayed-start-source-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.500Z",
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: { planMarkdown: "# Preserve this pending plan" },
    });

    const sourceThreadWithPlan = await waitForThread(
      harness.readModel,
      (thread) => thread.proposedPlans.length === 1,
      2_000,
      sourceThreadId,
    );
    const sourcePlan = sourceThreadWithPlan.proposedPlans[0];
    expect(sourcePlan).toBeDefined();
    if (sourcePlan === undefined) {
      throw new Error("Expected source plan to exist.");
    }

    harness.setProviderSession({
      provider: ProviderDriverKind.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      threadId: targetThreadId,
      createdAt: "2026-01-01T00:00:01.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      activeTurnId,
    });
    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-plan-replayed-start-active-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:01.000Z",
      threadId: targetThreadId,
      turnId: activeTurnId,
    });
    await waitForThread(
      harness.readModel,
      (thread) => thread.latestTurn?.turnId === activeTurnId,
      2_000,
      targetThreadId,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-plan-replayed-start-pending"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-replayed-start-pending"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Preserve this pending plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );

    // Some providers replay turn.started for the already-running turn. That
    // event predates the queued message and must not steal its proposed-plan
    // reference merely because it is currently the oldest pending start.
    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-plan-replayed-start-active-repeated"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:03.000Z",
      threadId: targetThreadId,
      turnId: activeTurnId,
    });
    await harness.drain();

    const afterRepeatedStart = await harness.readModel();
    expect(
      afterRepeatedStart.threads
        .find((thread) => thread.id === sourceThreadId)
        ?.proposedPlans.find((plan) => plan.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    });

    // The later real start for B must still find the pending source reference,
    // proving the replay neither attributed nor consumed it.
    harness.setProviderSession({
      provider: ProviderDriverKind.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      threadId: targetThreadId,
      createdAt: "2026-01-01T00:00:01.000Z",
      updatedAt: "2026-01-01T00:00:04.000Z",
      activeTurnId: pendingTurnId,
    });
    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-plan-replayed-start-pending-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:04.000Z",
      threadId: targetThreadId,
      turnId: pendingTurnId,
    });

    const sourceThreadAfterPendingStart = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.proposedPlans.some(
          (plan) =>
            plan.id === sourcePlan.id &&
            plan.implementationThreadId === targetThreadId &&
            plan.implementedAt !== null,
        ),
      2_000,
      sourceThreadId,
    );
    expect(
      sourceThreadAfterPendingStart.proposedPlans.find((plan) => plan.id === sourcePlan.id),
    ).toMatchObject({
      implementationThreadId: targetThreadId,
    });
  });

  it("does not mark the source proposed plan implemented for an unrelated turn.started when no thread active turn is tracked", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-plan");
    const targetThreadId = asThreadId("thread-implement");
    const sourceTurnId = asTurnId("turn-plan-source");
    const expectedTurnId = asTurnId("turn-plan-implement");
    const replayedTurnId = asTurnId("turn-replayed");
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create-plan-source-unrelated"),
        threadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Source",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-plan-source-unrelated"),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create-plan-target-unrelated"),
        threadId: targetThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Target",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-plan-target-unrelated"),
        threadId: targetThreadId,
        session: {
          threadId: targetThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-source-completed-unrelated"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Source plan",
      },
    });

    const sourceThreadWithPlan = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
            proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-plan:turn:turn-plan-source",
    );
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) {
      throw new Error("Expected source plan to exist.");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-plan-target-unrelated"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-target-unrelated"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    harness.setProviderSession({
      provider: ProviderDriverKind.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      threadId: targetThreadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId: expectedTurnId,
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-unrelated-plan-implementation"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: targetThreadId,
      turnId: replayedTurnId,
    });

    await harness.drain();

    const readModel = await harness.readModel();
    const sourceThreadAfterUnrelatedStart = readModel.threads.find(
      (entry) => entry.id === sourceThreadId,
    );
    expect(
      sourceThreadAfterUnrelatedStart?.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    });
  });

  it("finalizes buffered proposed-plan deltas into a first-class proposed plan on turn completion", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-plan-buffer"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-plan-buffer",
    );

    harness.emit({
      type: "turn.proposed.delta",
      eventId: asEventId("evt-plan-delta-1"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        delta: "## Buffered plan\n\n- first",
      },
    });
    harness.emit({
      type: "turn.proposed.delta",
      eventId: asEventId("evt-plan-delta-2"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        delta: "\n- second",
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-plan-buffer"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        state: "completed",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.proposedPlans.some(
        (proposedPlan: ProviderRuntimeTestProposedPlan) =>
          proposedPlan.id === "plan:thread-1:turn:turn-plan-buffer",
      ),
    );
    const proposedPlan = thread.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-1:turn:turn-plan-buffer",
    );
    expect(proposedPlan?.planMarkdown).toBe("## Buffered plan\n\n- first\n- second");
  });

  it("buffers assistant deltas by default until completion", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-buffered",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered"),
      itemId: asItemId("item-buffered"),
      payload: {
        streamKind: "assistant_text",
        delta: "buffer me",
      },
    });

    await harness.drain();
    const midReadModel = await harness.readModel();
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(
      midThread?.messages.some(
        (message: ProviderRuntimeTestMessage) => message.id === "assistant:item-buffered",
      ),
    ).toBe(false);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffered"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered"),
      itemId: asItemId("item-buffered"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffered",
    );
    expect(message?.text).toBe("buffer me");
    expect(message?.streaming).toBe(false);
  });

  it("flushes and completes buffered assistant text when an approval request opens", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered-request-flush"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-flush"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffered-request-flush",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered-request-flush"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-flush"),
      itemId: asItemId("item-buffered-request-flush"),
      payload: {
        streamKind: "assistant_text",
        delta: "visible before approval",
      },
    });
    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-request-opened-buffered-request-flush"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-flush"),
      requestId: ApprovalRequestId.make("req-buffered-request-flush"),
      payload: {
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered-request-flush" &&
          !message.streaming &&
          message.text === "visible before approval",
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffered-request-flush",
    );
    expect(message?.streaming).toBe(false);
  });

  it("flushes and completes buffered assistant text when user input is requested", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered-user-input-flush"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-user-input-flush"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffered-user-input-flush",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered-user-input-flush"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-user-input-flush"),
      itemId: asItemId("item-buffered-user-input-flush"),
      payload: {
        streamKind: "assistant_text",
        delta: "visible before user input",
      },
    });
    harness.emit({
      type: "user-input.requested",
      eventId: asEventId("evt-user-input-requested-buffered-user-input-flush"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-user-input-flush"),
      requestId: ApprovalRequestId.make("req-buffered-user-input-flush"),
      payload: {
        questions: [
          {
            id: "choice",
            header: "Choice",
            question: "Pick one",
            options: [{ label: "A", description: "Option A" }],
          },
        ],
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered-user-input-flush" &&
          !message.streaming &&
          message.text === "visible before user input",
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) =>
        entry.id === "assistant:item-buffered-user-input-flush",
    );
    expect(message?.streaming).toBe(false);
  });

  it("does not create assistant segments for whitespace-only buffered text at approval boundaries", async () => {
    const harness = await createHarness();
    const startedAt = "2026-03-28T06:28:00.000Z";
    const pausedAt = "2026-03-28T06:28:01.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered-whitespace-request"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: startedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-whitespace-request"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffered-whitespace-request",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered-whitespace-request"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: startedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-whitespace-request"),
      itemId: asItemId("item-buffered-whitespace-request"),
      payload: {
        streamKind: "assistant_text",
        delta: "\n\n\n",
      },
    });
    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-request-opened-buffered-whitespace-request"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: pausedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-whitespace-request"),
      requestId: ApprovalRequestId.make("req-buffered-whitespace-request"),
      payload: {
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "approval.requested",
      ),
    );
    expect(
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered-whitespace-request",
      ),
    ).toBe(false);
  });

  it("starts a new buffered assistant message segment after approval and completes without duplication", async () => {
    const harness = await createHarness();
    const startedAt = "2026-03-28T06:07:00.000Z";
    const pausedAt = "2026-03-28T06:07:01.000Z";
    const resumedAt = "2026-03-28T06:07:02.000Z";
    const completedAt = "2026-03-28T06:07:03.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered-request-append"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: startedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-append"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffered-request-append",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered-request-append-initial"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: startedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-append"),
      itemId: asItemId("item-buffered-request-append"),
      payload: {
        streamKind: "assistant_text",
        delta: "first half",
      },
    });
    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-request-opened-buffered-request-append"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: pausedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-append"),
      requestId: ApprovalRequestId.make("req-buffered-request-append"),
      payload: {
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    });

    await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered-request-append" &&
          !message.streaming &&
          message.text === "first half",
      ),
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered-request-append-followup"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: resumedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-append"),
      itemId: asItemId("item-buffered-request-append"),
      payload: {
        streamKind: "assistant_text",
        delta: " second half",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffered-request-append"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: completedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-append"),
      itemId: asItemId("item-buffered-request-append"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered-request-append:segment:1" &&
          !message.streaming &&
          message.text === " second half",
      ),
    );
    const firstMessage = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffered-request-append",
    );
    const resumedMessage = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) =>
        entry.id === "assistant:item-buffered-request-append:segment:1",
    );
    expect(firstMessage?.text).toBe("first half");
    expect(firstMessage?.streaming).toBe(false);
    expect(resumedMessage?.text).toBe(" second half");
    expect(resumedMessage?.streaming).toBe(false);

    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const assistantEvents = events.filter(
      (event): event is Extract<(typeof events)[number], { type: "thread.message-sent" }> =>
        event.type === "thread.message-sent" &&
        event.payload.messageId.startsWith("assistant:item-buffered-request-append"),
    );
    expect(assistantEvents).toHaveLength(4);
    expect(assistantEvents[0]?.payload.streaming).toBe(true);
    expect(assistantEvents[0]?.payload.text).toBe("first half");
    expect(assistantEvents[1]?.payload.streaming).toBe(false);
    expect(assistantEvents[1]?.payload.text).toBe("");
    expect(assistantEvents[2]?.payload.messageId).toBe(
      "assistant:item-buffered-request-append:segment:1",
    );
    expect(assistantEvents[2]?.payload.streaming).toBe(true);
    expect(assistantEvents[2]?.payload.text).toBe(" second half");
    expect(assistantEvents[3]?.payload.messageId).toBe(
      "assistant:item-buffered-request-append:segment:1",
    );
    expect(assistantEvents[3]?.payload.streaming).toBe(false);
    expect(assistantEvents[3]?.payload.text).toBe("");
  });

  it("starts a new streaming assistant message segment after approval", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
    const startedAt = "2026-03-28T07:00:00.000Z";
    const pausedAt = "2026-03-28T07:00:01.000Z";
    const resumedAt = "2026-03-28T07:00:02.000Z";
    const completedAt = "2026-03-28T07:00:03.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-streaming-request-segment"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: startedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-request-segment"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-streaming-request-segment",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-request-segment-initial"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: startedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-request-segment"),
      itemId: asItemId("item-streaming-request-segment"),
      payload: {
        streamKind: "assistant_text",
        delta: "before approval",
      },
    });
    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-request-opened-streaming-request-segment"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: pausedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-request-segment"),
      requestId: ApprovalRequestId.make("req-streaming-request-segment"),
      payload: {
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    });

    await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-request-segment" &&
          !message.streaming &&
          message.text === "before approval",
      ),
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-request-segment-followup"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: resumedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-request-segment"),
      itemId: asItemId("item-streaming-request-segment"),
      payload: {
        streamKind: "assistant_text",
        delta: " after approval",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-streaming-request-segment"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: completedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-request-segment"),
      itemId: asItemId("item-streaming-request-segment"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-request-segment:segment:1" &&
          !message.streaming &&
          message.text === " after approval",
      ),
    );
    expect(
      thread.messages.find(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-request-segment",
      )?.text,
    ).toBe("before approval");
    expect(
      thread.messages.find(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-request-segment:segment:1",
      )?.text,
    ).toBe(" after approval");
  });

  it("streams assistant deltas when thread.turn.start requests streaming mode", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-streaming-mode"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("message-streaming-mode"),
          role: "user",
          text: "stream please",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-streaming-mode"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-streaming-mode",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-mode"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
      itemId: asItemId("item-streaming-mode"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello live",
      },
    });

    const liveThread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-mode" &&
          message.streaming &&
          message.text === "hello live",
      ),
    );
    const liveMessage = liveThread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-streaming-mode",
    );
    expect(liveMessage?.streaming).toBe(true);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-streaming-mode"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
      itemId: asItemId("item-streaming-mode"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "hello live",
      },
    });

    const finalThread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-mode" && !message.streaming,
      ),
    );
    const finalMessage = finalThread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-streaming-mode",
    );
    expect(finalMessage?.text).toBe("hello live");
    expect(finalMessage?.streaming).toBe(false);
  });

  it("spills oversized buffered deltas and still finalizes full assistant text", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const oversizedText = "x".repeat(40_000);

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffer-spill"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffer-spill",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffer-spill"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
      itemId: asItemId("item-buffer-spill"),
      payload: {
        streamKind: "assistant_text",
        delta: oversizedText,
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffer-spill"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
      itemId: asItemId("item-buffer-spill"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffer-spill" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffer-spill",
    );
    expect(message?.text.length).toBe(oversizedText.length);
    expect(message?.text).toBe(oversizedText);
    expect(message?.streaming).toBe(false);
  });

  it("does not duplicate assistant completion when item.completed is followed by turn.completed", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-for-complete-dedup"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-complete-dedup",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-for-complete-dedup"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      itemId: asItemId("item-complete-dedup"),
      payload: {
        streamKind: "assistant_text",
        delta: "done",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-for-complete-dedup"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      itemId: asItemId("item-complete-dedup"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-for-complete-dedup"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      payload: {
        state: "completed",
      },
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "ready" &&
        thread.session?.activeTurnId === null &&
        thread.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-complete-dedup" && !message.streaming,
        ),
    );

    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const completionEvents = events.filter((event) => {
      if (event.type !== "thread.message-sent") {
        return false;
      }
      return (
        event.payload.messageId === "assistant:item-complete-dedup" &&
        event.payload.streaming === false
      );
    });
    expect(completionEvents).toHaveLength(1);
  });

  it("maps canonical request events into approval activities with requestKind", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-request-opened"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      requestId: ApprovalRequestId.make("req-open"),
      payload: {
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    });

    harness.emit({
      type: "request.resolved",
      eventId: asEventId("evt-request-resolved"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      requestId: ApprovalRequestId.make("req-open"),
      payload: {
        requestType: "command_execution_approval",
        decision: "accept",
      },
    });

    await waitForThread(
      harness.readModel,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "approval.requested",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "approval.resolved",
        ),
    );

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread).toBeDefined();

    const requested = thread?.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-request-opened",
    );
    const requestedPayload =
      requested?.payload && typeof requested.payload === "object"
        ? (requested.payload as Record<string, unknown>)
        : undefined;
    expect(requestedPayload?.requestKind).toBe("command");
    expect(requestedPayload?.requestType).toBe("command_execution_approval");

    const resolved = thread?.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-request-resolved",
    );
    const resolvedPayload =
      resolved?.payload && typeof resolved.payload === "object"
        ? (resolved.payload as Record<string, unknown>)
        : undefined;
    expect(resolvedPayload?.requestKind).toBe("command");
    expect(resolvedPayload?.requestType).toBe("command_execution_approval");
  });

  it("maps runtime.error into errored session state", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-3"),
      payload: {
        message: "runtime exploded",
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === "turn-3" &&
        entry.session?.lastError === "runtime exploded",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("runtime exploded");
  });

  it("records runtime.error activities from the typed payload message", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error-activity"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-runtime-error-activity"),
      payload: {
        message: "runtime activity exploded",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.id === "evt-runtime-error-activity"),
    );
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-runtime-error-activity",
    );
    const activityPayload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;

    expect(activity?.kind).toBe("runtime.error");
    expect(activityPayload?.message).toBe("runtime activity exploded");
  });

  it("keeps the session running when a runtime.warning arrives during an active turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-warning-turn-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-warning"),
      payload: {},
    });

    harness.emit({
      type: "runtime.warning",
      eventId: asEventId("evt-warning-runtime"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-warning"),
      payload: {
        message: "Reconnecting... 2/5",
        detail: {
          willRetry: true,
        },
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "running" &&
        entry.session?.activeTurnId === "turn-warning" &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) =>
            activity.id === "evt-warning-runtime" && activity.kind === "runtime.warning",
        ),
    );
    expect(thread.session?.status).toBe("running");
    expect(thread.session?.activeTurnId).toBe("turn-warning");
    expect(thread.session?.lastError).toBeNull();
  });

  it("maps session/thread lifecycle and item.started into session/activity projections", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-session-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      message: "session started",
    });
    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
    });
    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-tool-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-9"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Read file",
        detail: "/tmp/file.ts",
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "ready" &&
        entry.session?.activeTurnId === null &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.started",
        ),
    );

    expect(thread.session?.status).toBe("ready");
    expect(
      thread.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.started",
      ),
    ).toBe(true);
  });

  it("consumes P1 runtime events into thread metadata, diff checkpoints, and activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "thread.metadata.updated",
      eventId: asEventId("evt-thread-metadata-updated"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        name: "Renamed by provider",
        metadata: { source: "provider" },
      },
    });

    harness.emit({
      type: "turn.plan.updated",
      eventId: asEventId("evt-turn-plan-updated"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      payload: {
        explanation: "Working through the plan",
        plan: [
          { step: "Inspect files", status: "completed" },
          { step: "Apply patch", status: "in_progress" },
        ],
      },
    });

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-item-updated"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      itemId: asItemId("item-p1-tool"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run tests",
        detail: "bun test",
        data: { pid: 123 },
      },
    });

    harness.emit({
      type: "runtime.warning",
      eventId: asEventId("evt-runtime-warning"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      payload: {
        message: "Provider got slow",
        detail: { latencyMs: 1500 },
      },
    });

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-turn-diff-updated"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      itemId: asItemId("item-p1-assistant"),
      payload: {
        unifiedDiff: "diff --git a/file.txt b/file.txt\n+hello\n",
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.title === "Renamed by provider" &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "turn.plan.updated",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.updated",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "runtime.warning",
        ) &&
        entry.checkpoints.some(
          (checkpoint: ProviderRuntimeTestCheckpoint) => checkpoint.turnId === "turn-p1",
        ),
    );

    expect(thread.title).toBe("Renamed by provider");

    const planActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-turn-plan-updated",
    );
    const planPayload =
      planActivity?.payload && typeof planActivity.payload === "object"
        ? (planActivity.payload as Record<string, unknown>)
        : undefined;
    expect(planActivity?.kind).toBe("turn.plan.updated");
    expect(Array.isArray(planPayload?.plan)).toBe(true);

    const toolUpdate = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-item-updated",
    );
    const toolUpdatePayload =
      toolUpdate?.payload && typeof toolUpdate.payload === "object"
        ? (toolUpdate.payload as Record<string, unknown>)
        : undefined;
    expect(toolUpdate?.kind).toBe("tool.updated");
    expect(toolUpdatePayload?.itemType).toBe("command_execution");
    expect(toolUpdatePayload?.status).toBe("in_progress");

    const warning = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-runtime-warning",
    );
    const warningPayload =
      warning?.payload && typeof warning.payload === "object"
        ? (warning.payload as Record<string, unknown>)
        : undefined;
    expect(warning?.kind).toBe("runtime.warning");
    expect(warningPayload?.message).toBe("Provider got slow");

    const checkpoint = thread.checkpoints.find(
      (entry: ProviderRuntimeTestCheckpoint) => entry.turnId === "turn-p1",
    );
    expect(checkpoint?.status).toBe("missing");
    expect(checkpoint?.assistantMessageId).toBe("assistant:item-p1-assistant");
    expect(checkpoint?.checkpointRef).toBe("provider-diff:evt-turn-diff-updated");
  });

  it("projects context window updates into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 1075,
          totalProcessedTokens: 10_200,
          maxTokens: 128_000,
          inputTokens: 1000,
          cachedInputTokens: 500,
          outputTokens: 50,
          reasoningOutputTokens: 25,
          lastUsedTokens: 1075,
          lastInputTokens: 1000,
          lastCachedInputTokens: 500,
          lastOutputTokens: 50,
          lastReasoningOutputTokens: 25,
          compactsAutomatically: true,
        },
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity).toBeDefined();
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 1075,
      totalProcessedTokens: 10_200,
      maxTokens: 128_000,
      inputTokens: 1000,
      cachedInputTokens: 500,
      outputTokens: 50,
      reasoningOutputTokens: 25,
      lastUsedTokens: 1075,
      compactsAutomatically: true,
    });
  });

  it("projects Codex camelCase token usage payloads into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated-camel"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 126,
          totalProcessedTokens: 11_839,
          maxTokens: 258_400,
          inputTokens: 120,
          cachedInputTokens: 0,
          outputTokens: 6,
          reasoningOutputTokens: 0,
          lastUsedTokens: 126,
          lastInputTokens: 120,
          lastCachedInputTokens: 0,
          lastOutputTokens: 6,
          lastReasoningOutputTokens: 0,
          compactsAutomatically: true,
        },
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 126,
      totalProcessedTokens: 11_839,
      maxTokens: 258_400,
      inputTokens: 120,
      cachedInputTokens: 0,
      outputTokens: 6,
      reasoningOutputTokens: 0,
      lastUsedTokens: 126,
      lastInputTokens: 120,
      lastOutputTokens: 6,
      compactsAutomatically: true,
    });
  });

  it("projects Claude usage snapshots with context window into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated-claude-window"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 31_251,
          lastUsedTokens: 31_251,
          maxTokens: 200_000,
          toolUses: 25,
          durationMs: 43_567,
        },
      },
      raw: {
        source: "claude.sdk.message",
        method: "claude/result/success",
        payload: {},
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 31_251,
      lastUsedTokens: 31_251,
      maxTokens: 200_000,
      toolUses: 25,
      durationMs: 43_567,
    });
  });

  it("projects compacted thread state into context compaction activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "thread.state.changed",
      eventId: asEventId("evt-thread-compacted"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: {
        state: "compacted",
        detail: { source: "provider" },
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-compaction",
      ),
    );

    const activity = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) => candidate.kind === "context-compaction",
    );
    expect(activity?.summary).toBe("Context compacted");
    expect(activity?.tone).toBe("info");
  });

  it("records context compaction duration from server-owned runtime events", async () => {
    const harness = await createHarness();
    const providerInstanceId = ProviderInstanceId.make("compaction-metrics-provider");

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-context-compaction-metric-started"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId,
      createdAt: "2026-01-01T00:00:01.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-context-compaction-metric"),
      itemId: asItemId("context-compaction-metric-item"),
      payload: { itemType: "context_compaction", status: "inProgress" },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-context-compaction-metric-completed"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId,
      createdAt: "2026-01-01T00:00:03.500Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-context-compaction-metric"),
      itemId: asItemId("context-compaction-metric-item"),
      payload: { itemType: "context_compaction", status: "completed" },
    });
    await harness.drain();

    const snapshots = await runtime!.runPromise(Metric.snapshot);
    const snapshot = snapshots.find(
      (candidate): candidate is Extract<Metric.Metric.Snapshot, { readonly type: "Histogram" }> =>
        candidate.type === "Histogram" &&
        candidate.id === "t3_background_context_compaction_duration" &&
        candidate.attributes?.provider === providerInstanceId,
    );
    expect(snapshot?.state.count).toBe(1);
    expect(snapshot?.state.sum).toBe(2_500);
  });

  it("projects Codex task lifecycle chunks into thread activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "task.started",
      eventId: asEventId("evt-task-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        taskType: "plan",
      },
    });

    harness.emit({
      type: "task.progress",
      eventId: asEventId("evt-task-progress"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        description: "Comparing the desktop rollout chunks to the app-server stream.",
        summary: "Code reviewer is validating the desktop rollout chunks.",
      },
    });

    harness.emit({
      type: "task.completed",
      eventId: asEventId("evt-task-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        status: "completed",
        summary: "<proposed_plan>\n# Plan title\n</proposed_plan>",
      },
    });
    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-task-proposed-plan-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        planMarkdown: "# Plan title",
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "task.completed",
        ) &&
        entry.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-1:turn:turn-task-1",
        ),
    );

    const started = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-started",
    );
    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-progress",
    );
    const completed = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-completed",
    );

    const progressPayload =
      progress?.payload && typeof progress.payload === "object"
        ? (progress.payload as Record<string, unknown>)
        : undefined;
    const completedPayload =
      completed?.payload && typeof completed.payload === "object"
        ? (completed.payload as Record<string, unknown>)
        : undefined;

    expect(started?.kind).toBe("task.started");
    expect(started?.summary).toBe("Plan task started");
    expect(progress?.kind).toBe("task.progress");
    expect(progressPayload?.detail).toBe("Code reviewer is validating the desktop rollout chunks.");
    expect(progressPayload?.summary).toBe(
      "Code reviewer is validating the desktop rollout chunks.",
    );
    expect(completed?.kind).toBe("task.completed");
    expect(completedPayload?.detail).toBe("<proposed_plan>\n# Plan title\n</proposed_plan>");
    expect(
      thread.proposedPlans.find(
        (entry: ProviderRuntimeTestProposedPlan) => entry.id === "plan:thread-1:turn:turn-task-1",
      )?.planMarkdown,
    ).toBe("# Plan title");
  });

  it("titles task activities with the task description, including on completion", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "task.started",
      eventId: asEventId("evt-named-task-started"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-named-task"),
      payload: {
        taskId: "named-task-1",
        description: "Typecheck mobile app",
        taskType: "local_bash",
      },
    });

    harness.emit({
      type: "task.progress",
      eventId: asEventId("evt-named-task-progress"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-named-task"),
      payload: {
        taskId: "named-task-1",
        description: "Typecheck mobile app",
        summary: "Running tsc across the mobile workspace.",
      },
    });

    harness.emit({
      type: "task.completed",
      eventId: asEventId("evt-named-task-completed"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-named-task"),
      payload: {
        taskId: "named-task-1",
        status: "completed",
        summary: "Typecheck finished without errors.",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-named-task-completed",
      ),
    );

    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-named-task-progress",
    );
    const completed = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-named-task-completed",
    );

    const progressPayload =
      progress?.payload && typeof progress.payload === "object"
        ? (progress.payload as Record<string, unknown>)
        : undefined;
    const completedPayload =
      completed?.payload && typeof completed.payload === "object"
        ? (completed.payload as Record<string, unknown>)
        : undefined;

    expect(progress?.summary).toBe("Typecheck mobile app");
    expect(progressPayload?.title).toBe("Typecheck mobile app");
    expect(completed?.summary).toBe("Task completed");
    expect(completedPayload?.title).toBe("Typecheck mobile app");
    expect(completedPayload?.summary).toBe("Typecheck finished without errors.");
    expect(completedPayload?.detail).toBe("Typecheck finished without errors.");
  });

  it("titles task completion from task.started when no progress event carried the name", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "task.started",
      eventId: asEventId("evt-fast-task-started"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-fast-task"),
      payload: {
        taskId: "fast-task-1",
        description: "wait for codex review to finish",
        taskType: "local_bash",
      },
    });

    harness.emit({
      type: "task.completed",
      eventId: asEventId("evt-fast-task-completed"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-fast-task"),
      payload: {
        taskId: "fast-task-1",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-fast-task-completed",
      ),
    );

    const completed = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-fast-task-completed",
    );
    const completedPayload =
      completed?.payload && typeof completed.payload === "object"
        ? (completed.payload as Record<string, unknown>)
        : undefined;

    expect(completedPayload?.title).toBe("wait for codex review to finish");
  });

  it("titles task completion from persisted activities after the description cache is swept", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "task.progress",
      eventId: asEventId("evt-swept-task-progress"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-swept-task"),
      payload: {
        taskId: "swept-task-1",
        description: "Watch round-3 CI and bots",
        summary: "Polling CI checks.",
      },
    });

    await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-swept-task-progress",
      ),
    );

    // session.exited sweeps the in-memory description cache; the completion
    // that follows must recover the name from persisted activities.
    harness.emit({
      type: "session.exited",
      eventId: asEventId("evt-swept-task-session-exited"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {},
    });

    harness.emit({
      type: "task.completed",
      eventId: asEventId("evt-swept-task-completed"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-swept-task"),
      payload: {
        taskId: "swept-task-1",
        status: "completed",
        summary: "CI is green.",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-swept-task-completed",
      ),
    );

    const completed = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-swept-task-completed",
    );
    const completedPayload =
      completed?.payload && typeof completed.payload === "object"
        ? (completed.payload as Record<string, unknown>)
        : undefined;

    expect(completedPayload?.title).toBe("Watch round-3 CI and bots");
  });

  it("projects structured user input request and resolution as thread activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "user-input.requested",
      eventId: asEventId("evt-user-input-requested"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-user-input"),
      requestId: ApprovalRequestId.make("req-user-input-1"),
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow workspace writes only",
              },
            ],
          },
        ],
      },
    });

    harness.emit({
      type: "user-input.resolved",
      eventId: asEventId("evt-user-input-resolved"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-user-input"),
      requestId: ApprovalRequestId.make("req-user-input-1"),
      payload: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "user-input.requested",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "user-input.resolved",
        ),
    );

    const requested = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-user-input-requested",
    );
    expect(requested?.kind).toBe("user-input.requested");

    const resolved = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-user-input-resolved",
    );
    const resolvedPayload =
      resolved?.payload && typeof resolved.payload === "object"
        ? (resolved.payload as Record<string, unknown>)
        : undefined;
    expect(resolved?.kind).toBe("user-input.resolved");
    expect(resolvedPayload?.answers).toEqual({
      sandbox_mode: "workspace-write",
    });
  });

  it("continues processing runtime events after a single event handler failure", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-invalid-delta"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-invalid"),
      itemId: asItemId("item-invalid"),
      payload: {
        streamKind: "assistant_text",
        delta: undefined,
      },
    } as unknown as ProviderRuntimeEvent);

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error-after-failure"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-after-failure"),
      payload: {
        message: "runtime still processed",
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === "turn-after-failure" &&
        entry.session?.lastError === "runtime still processed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("runtime still processed");
  });
});
