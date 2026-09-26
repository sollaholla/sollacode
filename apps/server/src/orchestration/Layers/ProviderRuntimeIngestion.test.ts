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
  RuntimeItemId,
  type ServerSettings,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Metric from "effect/Metric";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
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
  ProviderRuntimeIngestionOptions,
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
import { ProviderUsageGuardNoop } from "./ProviderUsageGuard.ts";

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
        summary: "Provider slow — retrying shortly",
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
        id: "reasoning:thread-grok:turn-grok:thread-grok:reasoning",
        kind: "reasoning.updated",
        summary: "Thinking",
        turnId: "turn-grok",
      }),
    ]);
    expect(second[0]?.id).toBe(first[0]?.id);
  });

  it("keeps each bridge thought as its own reasoning activity", () => {
    const thought = (index: number, text: string) =>
      runtimeEventToActivities({
        eventId: asEventId(`bridge-thought-${index}`),
        provider: ProviderDriverKind.make("mcpBridge"),
        createdAt: `2026-09-01T22:5${index}:00.000Z`,
        threadId: asThreadId("thread-bridge"),
        turnId: asTurnId("turn-bridge"),
        type: "item.updated",
        itemId: `turn-bridge:thought:${index}` as never,
        payload: {
          itemType: "reasoning",
          status: "inProgress",
          detail: text,
        },
      });
    const first = thought(1, "Checking whether the live run cleared preflight.");
    const second = thought(2, "It did; reading the contract results now.");
    expect(first[0]?.id).toBe("reasoning:thread-bridge:turn-bridge:turn-bridge:thought:1");
    expect(second[0]?.id).toBe("reasoning:thread-bridge:turn-bridge:turn-bridge:thought:2");
    expect(first[0]?.payload).toEqual({
      itemType: "reasoning",
      detail: "Checking whether the live run cleared preflight.",
    });
  });

  it("keeps a whole reasoning sentence instead of the tool-detail cap", () => {
    const detail = "x".repeat(400);
    const [activity] = runtimeEventToActivities({
      eventId: asEventId("bridge-thought-long"),
      provider: ProviderDriverKind.make("mcpBridge"),
      createdAt: "2026-09-01T22:50:00.000Z",
      threadId: asThreadId("thread-bridge"),
      turnId: asTurnId("turn-bridge"),
      type: "item.updated",
      itemId: "turn-bridge:thought:1" as never,
      payload: { itemType: "reasoning", status: "inProgress", detail },
    });
    expect((activity?.payload as { detail?: string } | undefined)?.detail).toBe(detail);
  });

  it("keeps a multi-paragraph thought whole instead of ellipsising it", () => {
    // A thought is drawn in the timeline as full markdown, so truncating it
    // leaves a visible "..." mid-sentence in the transcript.
    const detail = "A thought that runs long. ".repeat(300).trim();
    expect(detail.length).toBeGreaterThan(600);
    const [activity] = runtimeEventToActivities({
      eventId: asEventId("bridge-thought-paragraphs"),
      provider: ProviderDriverKind.make("mcpBridge"),
      createdAt: "2026-09-10T22:50:00.000Z",
      threadId: asThreadId("thread-bridge"),
      turnId: asTurnId("turn-bridge"),
      type: "item.updated",
      itemId: "turn-bridge:thought:9" as never,
      payload: { itemType: "reasoning", status: "inProgress", detail },
    });
    const rendered = (activity?.payload as { detail?: string } | undefined)?.detail;
    expect(rendered).toBe(detail);
    expect(rendered).not.toContain("...");
  });

  it.each([
    { provider: "codex", message: "pxpipe upstream unreachable" },
    {
      provider: "opencode",
      message:
        "OpenCode's model (opencode/union-alpha) returned 15 empty responses in a row; its upstream endpoint is not answering. Resume to try again.",
    },
  ])(
    "does not append a visible error row for a durable $provider upstream retry",
    ({ provider, message }) => {
      expect(
        runtimeEventToActivities({
          eventId: asEventId("retryable-runtime-error"),
          provider: ProviderDriverKind.make(provider),
          createdAt: "2026-07-29T15:00:00.000Z",
          threadId: asThreadId("thread-overload"),
          turnId: asTurnId("turn-overload"),
          type: "runtime.error",
          payload: {
            message,
            class: "provider_error",
            failureKind: "retryable-upstream",
          },
          providerRefs: {},
        }),
      ).toEqual([]);
    },
  );
});

function makeProviderSnapshot(input: {
  readonly instanceId: string;
  readonly driver: string;
  readonly model: string;
  readonly models?: ReadonlyArray<string>;
  readonly accountUsage?: unknown;
}): ServerProvider {
  const slugs = input.models ?? [input.model];
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    ...(input.accountUsage === undefined ? {} : { accountUsage: input.accountUsage }),
    models: slugs.map((slug, index) => ({
      slug,
      name: slug,
      isCustom: false,
      ...(slugs.length === 1 && index === 0 ? { isDefault: true } : {}),
      capabilities:
        slug === "claude-opus-5"
          ? {
              optionDescriptors: [
                {
                  id: "effort",
                  label: "Reasoning",
                  type: "select",
                  currentValue: "high",
                  options: [
                    { id: "low", label: "Low" },
                    { id: "medium", label: "Medium" },
                    { id: "high", label: "High", isDefault: true },
                    { id: "xhigh", label: "Extra High" },
                  ],
                },
              ],
            }
          : null,
    })),
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
  // A held send models an ACP adapter (Grok, Cursor): `sendTurn` resolves only
  // when the turn ends, and admission is reported through onNativeDispatch.
  let shouldHoldNextSendTurn = false;
  const heldSendTurns: Array<{
    readonly release: Deferred.Deferred<void>;
    readonly onNativeDispatch: Effect.Effect<void> | undefined;
  }> = [];

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
    sendTurn: (input, options) =>
      Effect.gen(function* () {
        sendTurnCalls.push(input);
        if (shouldFailNextSendTurn) {
          shouldFailNextSendTurn = false;
          throw new Error("Simulated handoff send failure");
        }
        const turnId = TurnId.make(`handoff-turn-${sendTurnCalls.length}`);
        if (shouldHoldNextSendTurn) {
          shouldHoldNextSendTurn = false;
          const hold = {
            release: yield* Deferred.make<void>(),
            onNativeDispatch: options?.onNativeDispatch,
          };
          heldSendTurns.push(hold);
          yield* Deferred.await(hold.release);
        }
        return {
          threadId: input.threadId,
          turnId,
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
    discardSessionHistory: () => unsupported(),
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
    holdNextSendTurn: () => {
      shouldHoldNextSendTurn = true;
    },
    heldSendTurns,
  };
}

type ProviderRuntimeTestReadModel = OrchestrationReadModel;
type ProviderRuntimeTestThread = ProviderRuntimeTestReadModel["threads"][number];
type ProviderRuntimeTestMessage = ProviderRuntimeTestThread["messages"][number];
type ProviderRuntimeTestProposedPlan = ProviderRuntimeTestThread["proposedPlans"][number];
type ProviderRuntimeTestActivity = ProviderRuntimeTestThread["activities"][number];
type ProviderRuntimeTestCheckpoint = ProviderRuntimeTestThread["checkpoints"][number];

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  while (!predicate()) {
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await Effect.runPromise(Effect.sleep("5 millis"));
  }
}

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
    failoverHandoffAdmissionTimeoutMs?: number;
  }) {
    const workspaceRoot = makeTempDir("t3-provider-project-");
    NodeFS.mkdirSync(NodePath.join(workspaceRoot, ".git"));
    const provider = createProviderServiceHarness();
    const runtimeObservations: Array<Parameters<ThreadWorkSchedulerShape["observeRuntime"]>[0]> =
      [];
    const activeThreadsRef: Array<ThreadId> = [];
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
      snapshot: Effect.sync(() => ({
        activeGlobal: activeThreadsRef.length,
        activeByProvider: {},
        activeRecoveryByProvider: {},
        activeThreads: [...activeThreadsRef],
        schedulerWindowSize: 0,
        runtimeByThread: {},
      })),
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
      Layer.provide(
        Layer.succeed(
          ProviderRuntimeIngestionOptions,
          options?.failoverHandoffAdmissionTimeoutMs === undefined
            ? {}
            : { failoverHandoffAdmissionTimeoutMs: options.failoverHandoffAdmissionTimeoutMs },
        ),
      ),
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(makeProviderRegistryLayer(options?.providers)),
      Layer.provideMerge(threadWorkSchedulerLayer),
      Layer.provideMerge(makeTestServerSettingsLayer(options?.serverSettings)),
      Layer.provideMerge(previewLayer),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ProviderUsageGuardNoop),
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
      holdNextSendTurn: provider.holdNextSendTurn,
      heldSendTurns: provider.heldSendTurns,
      runtimeObservations,
      setActiveThreads: (threadIds: ReadonlyArray<ThreadId>) => {
        activeThreadsRef.length = 0;
        activeThreadsRef.push(...threadIds);
      },
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
    const work = await harness.readThreadWork(threadId);
    expect(work).toContainEqual({
      kind: "active-turn-recovery",
      sourceTurnId: "turn-start:browser-tab-cleanup-message:thread-1:turn-browser-work",
      state: "pending",
    });
    expect(
      work.filter((entry) => entry.kind === "agent-continuation" && entry.state === "pending"),
    ).toEqual([]);
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
    // The active session must belong to the provider emitting this turn.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("seed-grok-agent-stop-session"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "grok",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-08-25T14:59:00.000Z",
        },
        createdAt: "2026-08-25T14:59:00.000Z",
      }),
    );
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

  it("stays silent when the turn a failover replaced reports its own exhaustion error", async () => {
    // Reported twice by the user, most recently with a screenshot: a red
    // "Runtime error" card sitting directly beneath "claude-fable-5-1 usage
    // exhausted · switched to claude-opus-5", for an exhaustion the system had
    // already handled perfectly. The failover points the session at its new
    // handoff turn, so the dying turn's error — which arrives after — matched
    // neither the session's provider instance nor its active turn id, and the
    // suppression declined on that mismatch. An exhausted model must produce no
    // error output at all; the error belongs only to the case where there is
    // nowhere left to fall back to.
    const harness = await createHarness({
      providers: [
        makeProviderSnapshot({ instanceId: "codex", driver: "codex", model: "gpt-5-codex" }),
        makeProviderSnapshot({
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          model: "claude-sonnet",
        }),
      ],
    });
    const now = "2026-01-01T00:00:10.000Z";
    const threadId = asThreadId("thread-1");
    const exhaustedTurnId = asTurnId("turn-superseded-by-failover");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-superseded-turn"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: exhaustedTurnId,
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
      threadId,
      activeTurnId: exhaustedTurnId,
      cwd: process.cwd(),
      resumeCursor: { threadId: "codex-native-thread" },
      createdAt: now,
      updatedAt: now,
    });

    harness.emit({
      type: "account.rate-limits.updated" as const,
      eventId: asEventId("evt-superseded-limit"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      threadId,
      createdAt: now,
      turnId: exhaustedTurnId,
      payload: {
        rateLimits: {
          rateLimits: {
            rateLimitReachedType: "rate_limit_reached",
            primary: { usedPercent: 100, resetsAt: 1_800_000_000 },
          },
        },
      },
    });

    const movedThread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.providerInstanceId === "claudeAgent" &&
        entry.activities.some((activity) => activity.kind === "provider.failover.completed"),
      10_000,
    );
    // The session now names the handoff turn, not the one that was exhausted —
    // the exact condition that used to defeat suppression.
    expect(movedThread.session?.activeTurnId).not.toBe(exhaustedTurnId);

    // The dying turn's error arrives late, from the provider it was exhausted on.
    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-superseded-turn-error"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      threadId,
      createdAt: "2026-01-01T00:00:12.000Z",
      turnId: exhaustedTurnId,
      payload: {
        message:
          "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 19th, 2026 6:19 PM.",
      },
    });

    await harness.drain();
    const settled = await harness.readModel();
    const thread = settled.threads.find((entry) => entry.id === threadId);
    expect(thread?.activities.filter((activity) => activity.kind === "runtime.error")).toEqual([]);
    // The switch notice is the whole story the user should see.
    expect(
      thread?.activities.some((activity) => activity.kind === "provider.failover.completed"),
    ).toBe(true);
  });

  it("fails over when a Codex usage-limit refusal names a spent quota window", async () => {
    // Observed 2026-09-14: Codex refused the turn with "You've hit your usage
    // limit …" while its rate-limit snapshot read 100% with no typed refusal
    // signal (rateLimitReachedType: null). Failover only listened to typed
    // signals, so nothing moved and the thread stalled until a manual switch.
    // The refusal text plus the spent window must fail over; neither alone may.
    const spentCodexUsage = {
      rateLimits: {
        credits: { balance: "0", hasCredits: false, unlimited: false },
        planType: "pro",
        primary: { usedPercent: 100, resetsAt: 1_800_000_000, windowDurationMins: 10080 },
        rateLimitReachedType: null,
        secondary: null,
        spendControlReached: null,
      },
    };
    const harness = await createHarness({
      providers: [
        makeProviderSnapshot({
          instanceId: "codex",
          driver: "codex",
          model: "gpt-5-codex",
          accountUsage: spentCodexUsage,
        }),
        makeProviderSnapshot({
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          model: "claude-sonnet",
        }),
      ],
    });
    const now = "2026-01-01T00:00:10.000Z";
    const threadId = asThreadId("thread-1");
    const turnId = asTurnId("turn-codex-refused");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-active-codex-for-refusal"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: turnId,
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
      threadId,
      activeTurnId: turnId,
      cwd: process.cwd(),
      createdAt: now,
      updatedAt: now,
    });

    // The spent window alone must not move the thread: accounts with fallback
    // credit keep serving past 100%.
    harness.emit({
      type: "account.rate-limits.updated",
      eventId: asEventId("evt-codex-window-spent-no-typed-signal"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      threadId,
      createdAt: now,
      turnId,
      payload: { rateLimits: spentCodexUsage },
    });
    await harness.drain();
    const beforeRefusal = (await harness.readModel()).threads.find(
      (entry) => entry.id === threadId,
    );
    expect(
      beforeRefusal?.activities.some((activity) => activity.kind === "provider.failover.completed"),
    ).toBe(false);
    expect(beforeRefusal?.modelSelection.instanceId).toBe("codex");

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-codex-usage-limit-refusal"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      threadId,
      createdAt: now,
      turnId,
      payload: {
        message:
          "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 19th, 2026 6:19 PM.",
        class: "provider_error",
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.modelSelection.instanceId === "claudeAgent" &&
        entry.session?.providerInstanceId === "claudeAgent" &&
        entry.activities.some((activity) => activity.kind === "provider.failover.completed"),
      10_000,
    );
    expect(harness.startSessionCalls).toHaveLength(1);
    expect(harness.sendTurnCalls).toHaveLength(1);
    expect(thread.session?.status).not.toBe("error");
  });

  it("ignores a Codex runtime error that is not a usage-limit refusal", async () => {
    const harness = await createHarness({
      providers: [
        makeProviderSnapshot({
          instanceId: "codex",
          driver: "codex",
          model: "gpt-5-codex",
          accountUsage: {
            rateLimits: {
              credits: { balance: "0", hasCredits: false, unlimited: false },
              primary: { usedPercent: 100, resetsAt: 1_800_000_000 },
              rateLimitReachedType: null,
              secondary: null,
              spendControlReached: null,
            },
          },
        }),
        makeProviderSnapshot({
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          model: "claude-sonnet",
        }),
      ],
    });
    const now = "2026-01-01T00:00:10.000Z";
    const threadId = asThreadId("thread-1");
    const turnId = asTurnId("turn-codex-crashed");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-active-codex-for-crash"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: turnId,
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
      threadId,
      activeTurnId: turnId,
      cwd: process.cwd(),
      createdAt: now,
      updatedAt: now,
    });

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-codex-unrelated-error"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      threadId,
      createdAt: now,
      turnId,
      payload: {
        message: "Codex process exited unexpectedly (signal SIGKILL).",
        class: "provider_error",
      },
    });
    await harness.drain();
    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(
      thread?.activities.some((activity) => activity.kind === "provider.failover.completed"),
    ).toBe(false);
    expect(thread?.modelSelection.instanceId).toBe("codex");
    expect(harness.startSessionCalls).toHaveLength(0);
  });

  it("ignores a usage-limit refusal when the quota window still has room", async () => {
    const harness = await createHarness({
      providers: [
        makeProviderSnapshot({
          instanceId: "codex",
          driver: "codex",
          model: "gpt-5-codex",
          accountUsage: {
            rateLimits: {
              credits: { balance: "0", hasCredits: false, unlimited: false },
              primary: { usedPercent: 40, resetsAt: 1_800_000_000 },
              rateLimitReachedType: null,
              secondary: null,
              spendControlReached: null,
            },
          },
        }),
        makeProviderSnapshot({
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          model: "claude-sonnet",
        }),
      ],
    });
    const now = "2026-01-01T00:00:10.000Z";
    const threadId = asThreadId("thread-1");
    const turnId = asTurnId("turn-codex-flaky-refusal");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-active-codex-for-flaky-refusal"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: turnId,
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
      threadId,
      activeTurnId: turnId,
      cwd: process.cwd(),
      createdAt: now,
      updatedAt: now,
    });

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-codex-flaky-refusal"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      threadId,
      createdAt: now,
      turnId,
      payload: {
        message: "You've hit your usage limit. Try again in a few minutes.",
        class: "provider_error",
      },
    });
    await harness.drain();
    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(
      thread?.activities.some((activity) => activity.kind === "provider.failover.completed"),
    ).toBe(false);
    expect(thread?.modelSelection.instanceId).toBe("codex");
    expect(harness.startSessionCalls).toHaveLength(0);
  });

  effectIt.effect.each([true, false])(
    "fails over within Antigravity from a 429 pool to Gemini first",
    (supervised) =>
      Effect.gen(function* () {
        // Observed 2026-09-14: Antigravity rejected the turn with
        // RESOURCE_EXHAUSTED (429) and the thread errored with a manual Resume
        // instead of falling back, even though the Gemini pool had quota. The
        // 429 must move the thread, and the surviving Gemini pool must win over
        // any other model.
        const harness = yield* Effect.promise(() =>
          createHarness({
            providers: [
              makeProviderSnapshot({
                instanceId: "antigravity",
                driver: "antigravity",
                model: "claude-opus-4-8",
                models: ["claude-opus-4-8", "gemini-3.8-flash"],
                accountUsage: {
                  windows: [
                    {
                      key: "gemini",
                      family: "gemini",
                      label: "Gemini",
                      remainingPercent: 60,
                      usedPercent: 40,
                      resetsAt: "2026-09-11T18:00:00Z",
                      windowDurationMs: null,
                    },
                    {
                      key: "claude-gpt",
                      family: "claude-gpt",
                      label: "Claude and GPT",
                      remainingPercent: 0,
                      usedPercent: 100,
                      resetsAt: "2026-09-11T18:00:00Z",
                      windowDurationMs: null,
                    },
                  ],
                },
              }),
              makeProviderSnapshot({
                instanceId: "claudeAgent",
                driver: "claudeAgent",
                model: "claude-sonnet",
              }),
            ],
          }),
        );
        const now = "2026-09-10T18:00:10.000Z";
        const threadId = asThreadId("thread-1");
        const turnId = asTurnId("turn-agy-429");
        yield* harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-model-antigravity-opus"),
          threadId,
          modelSelection: {
            instanceId: ProviderInstanceId.make("antigravity"),
            model: "claude-opus-4-8",
          },
        });
        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-active-antigravity"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "antigravity",
            providerInstanceId: ProviderInstanceId.make("antigravity"),
            runtimeMode: "approval-required",
            activeTurnId: turnId,
            updatedAt: now,
            lastError: null,
          },
          createdAt: now,
        });
        harness.setProviderSession({
          provider: ProviderDriverKind.make("antigravity"),
          providerInstanceId: ProviderInstanceId.make("antigravity"),
          status: "running",
          runtimeMode: "approval-required",
          threadId,
          activeTurnId: turnId,
          cwd: process.cwd(),
          createdAt: now,
          updatedAt: now,
        });

        // Both a supervised turn and its unsupervised handoff must recover
        // without leaving a runtime-error card behind.
        harness.setActiveThreads(supervised ? [threadId] : []);
        if (supervised) {
          harness.emit({
            type: "turn.completed",
            eventId: asEventId("evt-agy-429-turn-failed"),
            provider: ProviderDriverKind.make("antigravity"),
            providerInstanceId: ProviderInstanceId.make("antigravity"),
            threadId,
            createdAt: now,
            turnId,
            payload: {
              state: "failed",
              errorMessage:
                "Antigravity was rejected by Google with RESOURCE_EXHAUSTED (429). Check the account quota or switch accounts before retrying.",
            },
          });
          yield* Effect.promise(harness.drain);
          const afterTurnFailed = (yield* Effect.promise(harness.readModel)).threads.find(
            (entry) => entry.id === threadId,
          );
          expect(afterTurnFailed?.session?.status).toBe("running");
          expect(afterTurnFailed?.session?.lastError).toBeNull();
        }
        const receipt = yield* Stream.toQueue(
          harness.engine.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "thread.activity-appended" &&
                event.payload.activity.kind === "provider.failover.completed",
            ),
          ),
          { capacity: "unbounded" },
        ).pipe(Scope.provide(scope!));
        harness.emit({
          type: "runtime.error",
          eventId: asEventId("evt-agy-429"),
          provider: ProviderDriverKind.make("antigravity"),
          providerInstanceId: ProviderInstanceId.make("antigravity"),
          threadId,
          createdAt: now,
          turnId,
          payload: {
            message:
              "Antigravity was rejected by Google with RESOURCE_EXHAUSTED (429). Check the account quota or switch accounts before retrying.",
          },
        });

        yield* Effect.promise(harness.drain);
        yield* Queue.take(receipt);
        const thread = (yield* Effect.promise(harness.readModel)).threads.find(
          (entry) => entry.id === threadId,
        )!;
        expect(thread.modelSelection.model).toBe("gemini-3.8-flash");
        expect(thread.session?.providerInstanceId).toBe("antigravity");
        expect(thread.session?.lastError).toBeNull();
        expect(thread.activities.some((activity) => activity.kind === "runtime.error")).toBe(false);
        expect(harness.startSessionCalls).toHaveLength(1);
        expect(harness.sendTurnCalls).toHaveLength(1);
      }),
  );

  effectIt.effect(
    "reports exhaustion once through the unavailable notice without a scheduler obligation",
    () =>
      Effect.gen(function* () {
        // A direct CLI turn still has ingestion-owned failover. When no target
        // exists, its unavailable receipt is the actionable error.
        const harness = yield* Effect.promise(() =>
          createHarness({
            providers: [
              makeProviderSnapshot({
                instanceId: "antigravity",
                driver: "antigravity",
                model: "claude-opus-4-8",
              }),
            ],
          }),
        );
        const now = "2026-09-10T18:00:10.000Z";
        const threadId = asThreadId("thread-1");
        const turnId = asTurnId("turn-agy-429-unowned");
        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-active-antigravity-unowned"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "antigravity",
            providerInstanceId: ProviderInstanceId.make("antigravity"),
            runtimeMode: "approval-required",
            activeTurnId: turnId,
            updatedAt: now,
            lastError: null,
          },
          createdAt: now,
        });

        yield* harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-unowned-agy-model"),
          threadId,
          modelSelection: {
            instanceId: ProviderInstanceId.make("antigravity"),
            model: "claude-opus-4-8",
          },
        });
        const receipt = yield* Stream.toQueue(
          harness.engine.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "thread.activity-appended" &&
                event.payload.activity.kind === "provider.failover.unavailable",
            ),
          ),
          { capacity: "unbounded" },
        ).pipe(Scope.provide(scope!));
        harness.emit({
          type: "runtime.error",
          eventId: asEventId("evt-agy-429-unowned"),
          provider: ProviderDriverKind.make("antigravity"),
          providerInstanceId: ProviderInstanceId.make("antigravity"),
          threadId,
          createdAt: now,
          turnId,
          payload: {
            message:
              "Antigravity was rejected by Google with RESOURCE_EXHAUSTED (429). Check the account quota or switch accounts before retrying.",
          },
        });
        yield* Effect.promise(harness.drain);
        yield* Queue.take(receipt);
        const thread = (yield* Effect.promise(harness.readModel)).threads.find(
          (entry) => entry.id === threadId,
        );
        expect(thread?.activities.some((activity) => activity.kind === "runtime.error")).toBe(
          false,
        );
        expect(
          thread?.activities.some(
            (activity) =>
              activity.kind === "provider.failover.unavailable" && activity.tone === "error",
          ),
        ).toBe(true);
      }),
  );

  effectIt.effect("does not start an available fallback model denied by global restrictions", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({
          serverSettings: { fallbackModelPolicy: { mode: "allow", models: [] } },
          providers: [
            makeProviderSnapshot({ instanceId: "codex", driver: "codex", model: "gpt-5-codex" }),
            makeProviderSnapshot({
              instanceId: "claudeAgent",
              driver: "claudeAgent",
              model: "claude-opus-4-8",
            }),
          ],
        }),
      );
      const threadId = asThreadId("thread-1");
      const turnId = asTurnId("turn-model-policy-exhausted");
      const now = "2026-09-22T18:00:00.000Z";
      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-policy-active"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          updatedAt: now,
          lastError: null,
        },
        createdAt: now,
      });
      const receipt = yield* Stream.toQueue(
        harness.engine.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "thread.session-set" && event.payload.session.status === "error",
          ),
        ),
        { capacity: "unbounded" },
      ).pipe(Scope.provide(scope!));
      harness.emit({
        type: "account.rate-limits.updated",
        eventId: asEventId("evt-policy-exhaustion"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        threadId,
        createdAt: now,
        turnId,
        payload: {
          rateLimits: {
            rateLimits: {
              rateLimitReachedType: "rate_limit_reached",
              primary: { usedPercent: 100, resetsAt: 1_800_000_000 },
            },
          },
        },
      });
      yield* Effect.promise(harness.drain);
      yield* Queue.take(receipt);
      const thread = (yield* Effect.promise(harness.readModel)).threads.find(
        (entry) => entry.id === threadId,
      )!;
      expect(harness.startSessionCalls).toHaveLength(0);
      expect(harness.sendTurnCalls).toHaveLength(0);
      expect(thread.modelSelection.instanceId).toBe("codex");
      expect(
        thread.activities.some((activity) => activity.kind === "provider.failover.unavailable"),
      ).toBe(true);
      expect(thread.session?.activeTurnId).toBeNull();
      expect(thread.session?.status).toBe("error");
      expect(thread.session?.lastError).toContain("Model restrictions");
    }),
  );

  it("keeps a finished-but-unverified Muse delivery silent while recovery is live", async () => {
    // Observed 2026-09-14: the watchdog's "delivery of its final reply could
    // not be verified" failure flashed a warning even though the turn had
    // finished and a resume recovers the saved response. While an obligation
    // supervises the turn, the failure must leave no error output behind.
    const deliveryFailure =
      "[muse-progress-timeout] Muse finished, but delivery of its final reply could not be verified. Resume to recover the saved response.";
    const harness = await createHarness({
      providers: [
        makeProviderSnapshot({
          instanceId: "muse",
          driver: "muse",
          model: "muse-spark",
        }),
      ],
    });
    const now = "2026-09-10T18:00:10.000Z";
    const threadId = asThreadId("thread-1");
    const turnId = asTurnId("turn-muse-unverified");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-active-muse-unverified"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "muse",
          providerInstanceId: ProviderInstanceId.make("muse"),
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          updatedAt: now,
          lastError: null,
        },
        createdAt: now,
      }),
    );
    harness.setProviderSession({
      provider: ProviderDriverKind.make("muse"),
      providerInstanceId: ProviderInstanceId.make("muse"),
      status: "running",
      runtimeMode: "approval-required",
      threadId,
      activeTurnId: turnId,
      cwd: process.cwd(),
      createdAt: now,
      updatedAt: now,
    });

    harness.setActiveThreads([threadId]);
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-muse-unverified-turn-failed"),
      provider: ProviderDriverKind.make("muse"),
      providerInstanceId: ProviderInstanceId.make("muse"),
      threadId,
      createdAt: now,
      turnId,
      payload: {
        state: "failed",
        errorMessage: deliveryFailure,
      },
    });
    await harness.drain();
    const afterTurnFailed = (await harness.readModel()).threads.find(
      (entry) => entry.id === threadId,
    );
    expect(afterTurnFailed?.session?.status).toBe("running");
    expect(afterTurnFailed?.session?.lastError).toBeNull();
    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-muse-unverified"),
      provider: ProviderDriverKind.make("muse"),
      providerInstanceId: ProviderInstanceId.make("muse"),
      threadId,
      createdAt: now,
      turnId,
      payload: {
        message: deliveryFailure,
      },
    });
    await harness.drain();
    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(thread?.session?.lastError).toBeNull();
    expect(thread?.activities.some((activity) => activity.kind === "runtime.error")).toBe(false);
  });

  it("keeps ingesting runtime events while a failover handoff turn is still running", async () => {
    // Regression for 2026-09-01: a Claude→Grok handoff turn ran for 13m26s
    // inside the single ingestion worker, so every provider's events for every
    // thread were persisted up to 13 minutes late. The handoff must run off
    // the worker and be accepted at prompt admission, not at turn end.
    const harness = await createHarness({
      providers: [
        makeProviderSnapshot({ instanceId: "codex", driver: "codex", model: "gpt-5-codex" }),
        makeProviderSnapshot({ instanceId: "grok", driver: "grok", model: "grok-4.6" }),
      ],
    });
    const now = "2026-01-01T00:00:10.000Z";
    const threadId = asThreadId("thread-1");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-active-codex-for-held-failover"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-exhausted-held"),
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
      threadId,
      activeTurnId: asTurnId("turn-exhausted-held"),
      cwd: process.cwd(),
      createdAt: now,
      updatedAt: now,
    });
    harness.holdNextSendTurn();

    harness.emit({
      type: "account.rate-limits.updated",
      eventId: asEventId("evt-codex-limit-exhausted-held"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      threadId,
      createdAt: now,
      turnId: asTurnId("turn-exhausted-held"),
      payload: {
        rateLimits: {
          rateLimits: {
            rateLimitReachedType: "rate_limit_reached",
            primary: { usedPercent: 100, resetsAt: 1_800_000_000 },
          },
        },
      },
    });
    await waitFor(() => harness.heldSendTurns.length === 1);
    expect(harness.startSessionCalls.map((call) => call.input.providerInstanceId)).toEqual([
      "grok",
    ]);

    // The handoff prompt is in flight and not yet admitted. Ingestion must
    // still be moving: an unrelated runtime event lands while it is pending.
    harness.emit({
      type: "thread.metadata.updated",
      eventId: asEventId("evt-thread-metadata-while-handoff-pending"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId,
      payload: { name: "Renamed while the handoff was pending" },
    });
    const renamed = await waitForThread(
      harness.readModel,
      (entry) => entry.title === "Renamed while the handoff was pending",
      5_000,
    );
    expect(
      renamed.activities.some((activity) => activity.kind === "provider.failover.completed"),
    ).toBe(false);
    expect(renamed.modelSelection.instanceId).toBe("codex");

    // Admission — the prompt entering the provider-native transport — is the
    // acceptance boundary. The turn itself is still running.
    const held = harness.heldSendTurns[0];
    expect(held?.onNativeDispatch).toBeDefined();
    await Effect.runPromise(held?.onNativeDispatch ?? Effect.void);
    const switched = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.modelSelection.instanceId === "grok" &&
        entry.session?.providerInstanceId === "grok" &&
        entry.activities.some((activity) => activity.kind === "provider.failover.completed"),
      5_000,
    );
    expect(switched.session?.status).toBe("starting");
    expect(harness.sendTurnCalls).toHaveLength(1);

    await Effect.runPromise(Deferred.succeed(held!.release, undefined));
  });

  it("gives up on a failover target that never admits the handoff and rolls back", async () => {
    const harness = await createHarness({
      providers: [
        makeProviderSnapshot({ instanceId: "codex", driver: "codex", model: "gpt-5-codex" }),
        makeProviderSnapshot({ instanceId: "grok", driver: "grok", model: "grok-4.6" }),
      ],
      failoverHandoffAdmissionTimeoutMs: 50,
    });
    const now = "2026-01-01T00:00:10.000Z";
    const threadId = asThreadId("thread-1");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-active-codex-for-timeout-failover"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-exhausted-timeout"),
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
      threadId,
      activeTurnId: asTurnId("turn-exhausted-timeout"),
      cwd: process.cwd(),
      resumeCursor: { threadId: "codex-native-thread" },
      createdAt: now,
      updatedAt: now,
    });
    harness.holdNextSendTurn();

    harness.emit({
      type: "account.rate-limits.updated",
      eventId: asEventId("evt-codex-limit-exhausted-timeout"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      threadId,
      createdAt: now,
      turnId: asTurnId("turn-exhausted-timeout"),
      payload: {
        rateLimits: {
          rateLimits: {
            rateLimitReachedType: "rate_limit_reached",
            primary: { usedPercent: 100, resetsAt: 1_800_000_000 },
          },
        },
      },
    });

    const rolledBackHandoff = (activity: ProviderRuntimeTestActivity) =>
      activity.kind === "provider.failover.handoff.failed" &&
      (activity.payload as { rolledBack?: unknown } | undefined)?.rolledBack === true;
    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.activities.some(rolledBackHandoff),
      5_000,
    );
    const handoffFailed = thread.activities.find(rolledBackHandoff);
    const handoffFailedPayload = handoffFailed?.payload as { detail?: unknown } | undefined;
    expect(String(handoffFailedPayload?.detail ?? "")).toContain("did not admit the handoff");
    expect(thread.modelSelection.instanceId).toBe("codex");
    // Rolled back onto the exhausted source with its resume cursor.
    expect(harness.startSessionCalls.map((call) => call.input.providerInstanceId)).toEqual([
      "grok",
      "codex",
    ]);
    expect(harness.startSessionCalls[1]?.input.resumeCursor).toEqual({
      threadId: "codex-native-thread",
    });
  });

  it("fails over to the next enabled provider when Claude and Grok are not configured", async () => {
    const harness = await createHarness({
      providers: [
        makeProviderSnapshot({
          instanceId: "codex",
          driver: "codex",
          model: "gpt-5-codex",
        }),
        makeProviderSnapshot({
          instanceId: "cursor",
          driver: "cursor",
          model: "composer",
        }),
      ],
    });
    const now = "2026-01-01T00:00:10.000Z";
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-active-codex-no-claude-grok"),
        threadId: asThreadId("thread-1"),
        session: {
          threadId: asThreadId("thread-1"),
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-exhausted-partial"),
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
      activeTurnId: asTurnId("turn-exhausted-partial"),
      cwd: process.cwd(),
      createdAt: now,
      updatedAt: now,
    });

    harness.emit({
      type: "account.rate-limits.updated",
      eventId: asEventId("evt-codex-limit-no-claude-grok"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: now,
      turnId: asTurnId("turn-exhausted-partial"),
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
        entry.modelSelection.instanceId === "cursor" &&
        entry.activities.some((activity) => activity.kind === "provider.failover.completed"),
      10_000,
    );

    expect(thread.modelSelection.model).toBe("composer");
    expect(harness.startSessionCalls.map((call) => call.input.providerInstanceId)).toEqual([
      "cursor",
    ]);
  });

  it("fails over from Claude Fable 5 to Claude Opus 5 High instead of Codex", async () => {
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
          model: "claude-fable-5",
          models: ["claude-fable-5", "claude-opus-5", "claude-sonnet-5"],
        }),
      ],
    });
    const now = "2026-01-01T00:00:10.000Z";
    const threadId = asThreadId("thread-1");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-select-claude-fable"),
        threadId,
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-fable-5",
        },
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-active-claude-fable"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "claudeAgent",
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-fable-exhausted"),
          updatedAt: now,
          lastError: null,
        },
        createdAt: now,
      }),
    );
    harness.setProviderSession({
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      status: "running",
      runtimeMode: "approval-required",
      threadId,
      activeTurnId: asTurnId("turn-fable-exhausted"),
      cwd: process.cwd(),
      createdAt: now,
      updatedAt: now,
    });

    harness.emit({
      type: "account.rate-limits.updated",
      eventId: asEventId("evt-fable-limit-exhausted"),
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      threadId,
      createdAt: now,
      turnId: asTurnId("turn-fable-exhausted"),
      payload: {
        rateLimits: {
          type: "rate_limit_event",
          rate_limit_info: {
            status: "rejected",
            rateLimitType: "seven_day_fable",
          },
        },
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.modelSelection.model === "claude-opus-5" &&
        entry.session?.providerInstanceId === "claudeAgent" &&
        entry.activities.some((activity) => activity.kind === "provider.failover.completed"),
      10_000,
    );

    expect(thread.modelSelection).toEqual({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-5",
      options: [{ id: "effort", value: "high" }],
    });
    expect(harness.startSessionCalls).toHaveLength(1);
    expect(harness.startSessionCalls[0]?.input.providerInstanceId).toBe("claudeAgent");
    expect(harness.startSessionCalls[0]?.input.modelSelection?.model).toBe("claude-opus-5");
  });

  it("continues failover to the next enabled provider after Opus 5 is exhausted, then stops", async () => {
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
          model: "claude-fable-5",
          models: ["claude-fable-5", "claude-opus-5"],
        }),
        makeProviderSnapshot({
          instanceId: "grok",
          driver: "grok",
          model: "grok-code",
        }),
      ],
    });
    const now = "2026-01-01T00:00:10.000Z";
    const threadId = asThreadId("thread-1");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-select-claude-fable-chain"),
        threadId,
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-fable-5",
        },
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-active-claude-fable-chain"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "claudeAgent",
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-fable-chain"),
          updatedAt: now,
          lastError: null,
        },
        createdAt: now,
      }),
    );
    harness.setProviderSession({
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      status: "running",
      runtimeMode: "approval-required",
      threadId,
      activeTurnId: asTurnId("turn-fable-chain"),
      cwd: process.cwd(),
      createdAt: now,
      updatedAt: now,
    });

    harness.emit({
      type: "account.rate-limits.updated",
      eventId: asEventId("evt-fable-chain-exhausted"),
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      threadId,
      createdAt: now,
      turnId: asTurnId("turn-fable-chain"),
      payload: {
        rateLimits: {
          type: "rate_limit_event",
          rate_limit_info: {
            status: "rejected",
            rateLimitType: "seven_day_fable",
          },
        },
      },
    });

    const afterFable = await waitForThread(
      harness.readModel,
      (entry) => entry.modelSelection.model === "claude-opus-5",
      10_000,
    );
    expect(afterFable.session?.providerInstanceId).toBe("claudeAgent");
    const opusTurnId = afterFable.session?.activeTurnId;
    expect(opusTurnId).toBeTruthy();

    harness.setProviderSession({
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      status: "running",
      runtimeMode: "approval-required",
      threadId,
      activeTurnId: opusTurnId ?? undefined,
      cwd: process.cwd(),
      createdAt: now,
      updatedAt: now,
    });

    harness.emit({
      type: "account.rate-limits.updated",
      eventId: asEventId("evt-opus-chain-exhausted"),
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      threadId,
      createdAt: "2026-01-01T00:00:20.000Z",
      turnId: opusTurnId ?? undefined,
      payload: {
        rateLimits: {
          type: "rate_limit_event",
          rate_limit_info: {
            status: "rejected",
            rateLimitType: "seven_day_opus",
          },
        },
      },
    });

    const afterOpus = await waitForThread(
      harness.readModel,
      (entry) => entry.session?.providerInstanceId === "codex",
      10_000,
    );
    expect(afterOpus.modelSelection.model).toBe("gpt-5-codex");
    const codexTurnId = afterOpus.session?.activeTurnId;
    expect(codexTurnId).toBeTruthy();

    harness.setProviderSession({
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      threadId,
      activeTurnId: codexTurnId ?? undefined,
      cwd: process.cwd(),
      createdAt: now,
      updatedAt: now,
    });

    harness.emit({
      type: "account.rate-limits.updated",
      eventId: asEventId("evt-codex-chain-exhausted"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      threadId,
      createdAt: "2026-01-01T00:00:30.000Z",
      turnId: codexTurnId ?? undefined,
      payload: {
        rateLimits: {
          rateLimits: {
            rateLimitReachedType: "rate_limit_reached",
            primary: { usedPercent: 100, resetsAt: 1_800_000_000 },
          },
        },
      },
    });

    const afterCodex = await waitForThread(
      harness.readModel,
      (entry) => entry.session?.providerInstanceId === "grok",
      10_000,
    );
    expect(afterCodex.modelSelection.model).toBe("grok-code");
    const grokTurnId = afterCodex.session?.activeTurnId;
    expect(grokTurnId).toBeTruthy();

    harness.setProviderSession({
      provider: ProviderDriverKind.make("grok"),
      providerInstanceId: ProviderInstanceId.make("grok"),
      status: "running",
      runtimeMode: "approval-required",
      threadId,
      activeTurnId: grokTurnId ?? undefined,
      cwd: process.cwd(),
      createdAt: now,
      updatedAt: now,
    });

    harness.emit({
      type: "account.rate-limits.updated",
      eventId: asEventId("evt-grok-chain-exhausted"),
      provider: ProviderDriverKind.make("grok"),
      providerInstanceId: ProviderInstanceId.make("grok"),
      threadId,
      createdAt: "2026-01-01T00:00:40.000Z",
      turnId: grokTurnId ?? undefined,
      payload: {
        rateLimits: {
          config: {
            creditUsagePercent: 100,
            currentPeriod: { end: "2026-08-22T00:00:00+00:00" },
          },
        },
      },
    });

    const stopped = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "error" &&
        entry.activities.some((activity) => activity.kind === "provider.failover.unavailable"),
      10_000,
    );
    expect(stopped.session?.providerInstanceId).toBe("grok");
    expect(stopped.modelSelection.model).toBe("grok-code");
    expect(harness.startSessionCalls.map((call) => call.input.providerInstanceId)).toEqual([
      "claudeAgent",
      "codex",
      "grok",
    ]);
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

    await harness.drain();
    const stopped = (await harness.readModel()).threads.find(
      (entry) => entry.id === asThreadId("thread-1"),
    );
    expect(stopped?.session?.status).toBe("stopped");
    expect(stopped?.session?.lastError).toBe("provider crashed");
  });

  it.each([
    { oldDriver: "claudeAgent", oldInstance: "claudeAgent", exitedAt: "2026-01-01T00:00:03.000Z" },
    { oldDriver: "codex", oldInstance: "other-codex", exitedAt: "2026-01-01T00:00:03.000Z" },
    { oldDriver: "codex", oldInstance: "codex", exitedAt: "2026-01-01T00:00:01.000Z" },
  ])(
    "keeps the new session starting when a replaced session exits ($oldDriver/$oldInstance)",
    async ({ oldDriver, oldInstance, exitedAt }) => {
      const harness = await createHarness();
      const threadId = asThreadId("thread-1");
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("handoff-pending-command"),
          threadId,
          message: {
            messageId: MessageId.make("handoff-pending-message"),
            role: "user",
            text: "continue with this provider",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          createdAt: "2026-01-01T00:00:02.000Z",
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("handoff-target-starting"),
          threadId,
          session: {
            threadId,
            status: "starting",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:00:02.000Z",
          },
          createdAt: "2026-01-01T00:00:02.000Z",
        }),
      );
      harness.emit({
        type: "session.exited",
        eventId: asEventId("replaced-session-exited"),
        provider: ProviderDriverKind.make(oldDriver),
        providerInstanceId: ProviderInstanceId.make(oldInstance),
        threadId,
        createdAt: exitedAt,
      });
      await harness.drain();
      let thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
      expect(thread?.session?.status).toBe("starting");
      expect(thread?.session?.providerInstanceId).toBe("codex");
      harness.emit({
        type: "turn.started",
        eventId: asEventId("replacement-turn-started"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        threadId,
        turnId: asTurnId("replacement-turn"),
        createdAt: "2026-01-01T00:00:04.000Z",
      });
      await harness.drain();
      thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
      expect(thread?.session?.status).toBe("running");
      expect(thread?.session?.activeTurnId).toBe("replacement-turn");
    },
  );

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
    "keeps native ready separate from pending launch ownership while clearing stale active state",
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
            (entry) => entry.session?.status === "ready" && entry.session.activeTurnId === null,
          ),
        );
        expect(thread.session?.status).toBe("ready");
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
        expect(thread.session?.status).toBe("ready");
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

  effectIt.effect(
    "keeps Stop authoritative over late lifecycle events and accepts a new explicit send",
    () =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() => createHarness());
        const threadId = asThreadId("thread-1");
        const stoppedAt = "2026-01-01T00:00:02.000Z";
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("pending-before-user-stop"),
          threadId,
          message: {
            messageId: MessageId.make("pending-before-user-stop"),
            role: "user",
            text: "Begin",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: "2026-01-01T00:00:01.000Z",
        });
        yield* harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.make("actual-user-stop-clears-pending"),
          threadId,
          createdAt: stoppedAt,
        });
        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-stop-before-late-events"),
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
        const events = [
          { type: "session.started" },
          { type: "thread.started" },
          { type: "session.state.changed", payload: { state: "ready" } },
          { type: "session.state.changed", payload: { state: "running" } },
          { type: "turn.started", turnId: asTurnId("turn-late-after-stop") },
          {
            type: "turn.completed",
            turnId: asTurnId("turn-late-after-stop"),
            payload: { state: "completed" },
          },
          {
            type: "runtime.error",
            turnId: asTurnId("turn-late-after-stop"),
            payload: { message: "late error" },
          },
        ] as const;
        for (const [index, event] of events.entries()) {
          harness.emit({
            ...event,
            eventId: asEventId(`evt-late-after-stop-${index}`),
            provider: ProviderDriverKind.make("codex"),
            threadId,
            createdAt: "2026-01-01T00:00:03.000Z",
          });
          yield* Effect.promise(() => harness.drain());
          const thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
            (entry) => entry.id === threadId,
          );
          expect(thread?.session?.status, event.type).toBe("stopped");
          expect(thread?.session?.activeTurnId, event.type).toBeNull();
        }
        expect(harness.runtimeObservations).toEqual([]);

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-new-send-after-stop"),
          threadId,
          message: {
            messageId: MessageId.make("message-new-after-stop"),
            role: "user",
            text: "Continue now",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: "2026-01-01T00:00:04.000Z",
        });
        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-new-session-after-stop"),
          threadId,
          session: {
            threadId,
            status: "starting",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:00:04.000Z",
          },
          createdAt: "2026-01-01T00:00:04.000Z",
        });
        harness.emit({
          type: "turn.started",
          eventId: asEventId("evt-new-turn-after-stop"),
          provider: ProviderDriverKind.make("codex"),
          threadId,
          turnId: asTurnId("turn-new-after-stop"),
          createdAt: "2026-01-01T00:00:05.000Z",
        });
        yield* Effect.promise(() => harness.drain());
        const thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
          (entry) => entry.id === threadId,
        );
        expect(thread?.session?.status).toBe("running");
        expect(thread?.session?.activeTurnId).toBe("turn-new-after-stop");
      }),
  );

  it.each(["starting", "ready"] as const)(
    "keeps an approval restart running after an interrupted turn and startup ready events (%s)",
    async (initialStatus) => {
      const harness = await createHarness();
      const threadId = asThreadId("thread-1");
      const oldTurnId = asTurnId("turn-before-approval");
      const newTurnId = asTurnId("turn-after-approval");
      const base = { provider: ProviderDriverKind.make("codex"), threadId };
      harness.emit({
        ...base,
        type: "turn.started",
        eventId: asEventId("approval-old-start"),
        turnId: oldTurnId,
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      await harness.drain();
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.make("approval-old-stop"),
          threadId,
          turnId: oldTurnId,
          createdAt: "2026-01-01T00:00:02.000Z",
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("approval-new-request"),
          threadId,
          message: {
            messageId: MessageId.make("action-approval-response:test"),
            role: "user",
            text: "Proceed with the approved action",
            attachments: [],
          },
          interactionMode: "default",
          runtimeMode: "approval-required",
          createdAt: "2026-01-01T00:00:03.000Z",
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("approval-new-session"),
          threadId,
          session: {
            threadId,
            status: initialStatus,
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:00:03.000Z",
          },
          createdAt: "2026-01-01T00:00:03.000Z",
        }),
      );
      harness.emit({
        ...base,
        type: "session.started",
        eventId: asEventId("approval-session-start"),
        createdAt: "2026-01-01T00:00:04.000Z",
      });
      harness.emit({
        ...base,
        type: "session.state.changed",
        eventId: asEventId("approval-session-ready"),
        payload: { state: "ready" },
        createdAt: "2026-01-01T00:00:04.001Z",
      });
      harness.emit({
        ...base,
        type: "turn.completed",
        eventId: asEventId("approval-startup-result"),
        payload: { state: "completed" },
        createdAt: "2026-01-01T00:00:04.002Z",
      });
      harness.emit({
        ...base,
        type: "turn.completed",
        eventId: asEventId("approval-old-result"),
        turnId: oldTurnId,
        payload: { state: "completed" },
        createdAt: "2026-01-01T00:00:04.003Z",
      });
      await harness.drain();
      expect(
        (await harness.readModel()).threads.find((t) => t.id === threadId)?.session?.status,
      ).toBe("ready");
      harness.setProviderSession({
        ...base,
        status: "running",
        runtimeMode: "approval-required",
        activeTurnId: newTurnId,
        createdAt: "2026-01-01T00:00:04.000Z",
        updatedAt: "2026-01-01T00:00:05.000Z",
      });
      harness.emit({
        ...base,
        type: "turn.started",
        eventId: asEventId("approval-new-start"),
        turnId: newTurnId,
        createdAt: "2026-01-01T00:00:05.000Z",
      });
      await harness.drain();
      const thread = (await harness.readModel()).threads.find((t) => t.id === threadId);
      expect(thread?.session?.status).toBe("running");
      expect(thread?.session?.activeTurnId).toBe(newTurnId);
      expect(thread?.latestTurn?.state).toBe("running");
      harness.emit({
        ...base,
        type: "content.delta",
        eventId: asEventId("approval-commentary"),
        turnId: newTurnId,
        itemId: asItemId("approval-commentary"),
        payload: { streamKind: "assistant_text", delta: "Let me read the exact page." },
        createdAt: "2026-01-01T00:00:06.000Z",
      });
      harness.emit({
        ...base,
        type: "item.completed",
        eventId: asEventId("approval-commentary-done"),
        turnId: newTurnId,
        itemId: asItemId("approval-commentary"),
        payload: { itemType: "assistant_message", status: "completed" },
        createdAt: "2026-01-01T00:00:07.000Z",
      });
      await harness.drain();
      const afterCommentary = (await harness.readModel()).threads.find((t) => t.id === threadId);
      expect(afterCommentary?.session?.status).toBe("running");
      expect(afterCommentary?.latestTurn?.completedAt).toBeNull();
      harness.emit({
        ...base,
        type: "turn.completed",
        eventId: asEventId("approval-actual-done"),
        turnId: newTurnId,
        payload: { state: "completed" },
        createdAt: "2026-01-01T00:00:08.000Z",
      });
      await harness.drain();
      expect(
        (await harness.readModel()).threads.find((t) => t.id === threadId)?.session?.status,
      ).toBe("ready");
    },
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

  effectIt.live("preserves historical Muse activity chronology through persisted ingestion", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() => createHarness());
      const threadId = ThreadId.make("thread-1");
      const originalTime = "2026-09-13T18:00:00.000Z";
      const old = {
        type: "item.completed" as const,
        eventId: EventId.make("muse:chronology:old"),
        provider: ProviderDriverKind.make("muse"),
        threadId,
        itemId: RuntimeItemId.make("old-tool"),
        createdAt: originalTime,
        payload: { itemType: "mcp_tool_call" as const, title: "Read file", detail: "complete" },
      };
      harness.emit(old);
      yield* Effect.promise(harness.drain);
      harness.emit({
        ...old,
        eventId: EventId.make("muse:chronology:new"),
        itemId: RuntimeItemId.make("new-tool"),
        createdAt: "2026-09-13T19:00:00.000Z",
      });
      yield* Effect.promise(harness.drain);
      const before = (yield* Effect.promise(harness.readModel)).threads.find(
        (thread) => thread.id === threadId,
      )!;
      const original = before.activities.find((activity) => activity.id === old.eventId)!;
      expect(original).toBeDefined();
      harness.emit({
        ...old,
        historicalReplay: true,
        createdAt: "2026-09-13T20:00:00.000Z",
        payload: { ...old.payload, detail: "recovered detail" },
      });
      yield* Effect.promise(harness.drain);
      const after = (yield* Effect.promise(harness.readModel)).threads.find(
        (thread) => thread.id === threadId,
      )!;
      expect(after.activities.map((activity) => activity.id)).toEqual(
        before.activities.map((activity) => activity.id),
      );
      expect(after.activities.find((activity) => activity.id === old.eventId)).toMatchObject({
        createdAt: original.createdAt,
        kind: original.kind,
      });
    }),
  );

  effectIt.live.each([
    { enableAssistantStreaming: true, stopped: false },
    { enableAssistantStreaming: false, stopped: false },
    { enableAssistantStreaming: true, stopped: true },
    { enableAssistantStreaming: false, stopped: true },
  ])(
    "restores historical Muse progress and final without authorizing continuation (%j)",
    ({ enableAssistantStreaming, stopped }) =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() =>
          createHarness({
            interactionMode: "agent",
            serverSettings: { enableAssistantStreaming },
          }),
        );
        const threadId = ThreadId.make("thread-1");
        const turnId = TurnId.make("muse-historical-repair-turn");
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("historical-start"),
          threadId,
          message: {
            messageId: MessageId.make("historical-user"),
            role: "user",
            text: "Complete the work.",
            attachments: [],
          },
          interactionMode: "agent",
          runtimeMode: "approval-required",
          createdAt: "2026-09-13T18:00:00.000Z",
        });
        for (const status of ["running", stopped ? "stopped" : "ready"] as const) {
          const createdAt =
            status === "running" ? "2026-09-13T18:00:01.000Z" : "2026-09-13T18:00:02.000Z";
          yield* harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(`historical-${status}`),
            threadId,
            session: {
              threadId,
              status,
              providerName: "muse",
              runtimeMode: "approval-required",
              activeTurnId: status === "running" ? turnId : null,
              lastError: null,
              updatedAt: createdAt,
            },
            createdAt,
          });
        }
        const restored: string[] = [];
        for (const [index, text] of [
          "Checking the final details.",
          "The completed report is ready.",
        ].entries()) {
          const itemId = RuntimeItemId.make(`historical-segment-${index}`);
          harness.emit({
            type: "item.completed",
            eventId: EventId.make(`historical-snapshot-${index}`),
            provider: ProviderDriverKind.make("muse"),
            threadId,
            turnId,
            itemId,
            historicalReplay: true,
            createdAt: `2026-09-13T18:00:0${3 + index * 2}.000Z`,
            payload: { itemType: "assistant_message", detail: text },
          });
          yield* Effect.promise(harness.drain);
          restored.push(text);
          const thread = (yield* Effect.promise(harness.readModel)).threads.find(
            (entry) => entry.id === threadId,
          )!;
          expect(thread.session).toMatchObject({
            status: stopped ? "stopped" : "ready",
            activeTurnId: null,
          });
          expect(
            thread.messages
              .filter((message) => message.role === "assistant")
              .map((message) => message.text),
          ).toEqual(restored);
          expect(
            (yield* Effect.promise(() => harness.readThreadWork(threadId))).filter(
              (work) => work.kind === "agent-continuation",
            ),
          ).toEqual([]);
          // A ready refresh interleaved between history segments must not turn
          // restored progress into fresh model work, even without AGENT_STOP.
          const createdAt = `2026-09-13T18:00:0${4 + index * 2}.000Z`;
          yield* harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(`historical-refresh-${index}`),
            threadId,
            session: {
              threadId,
              status: stopped ? "stopped" : "ready",
              providerName: "muse",
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: createdAt,
            },
            createdAt,
          });
          expect(
            (yield* Effect.promise(() => harness.readThreadWork(threadId))).filter(
              (work) => work.kind === "agent-continuation",
            ),
          ).toEqual([]);
        }
        expect(harness.sendTurnCalls).toEqual([]);
        expect(harness.interruptTurnCalls).toEqual([]);
        // Live output still has its ordinary continuation semantics.
        harness.emit({
          type: "item.completed",
          eventId: EventId.make("historical-control-live"),
          provider: ProviderDriverKind.make("muse"),
          threadId,
          turnId,
          itemId: RuntimeItemId.make("historical-control-live"),
          createdAt: "2026-09-13T18:00:07.000Z",
          payload: { itemType: "assistant_message", detail: "Continuing the authorized work." },
        });
        yield* Effect.promise(harness.drain);
        expect(
          (yield* Effect.promise(() => harness.readThreadWork(threadId))).filter(
            (work) => work.kind === "agent-continuation",
          ),
        ).toHaveLength(stopped ? 0 : 1);
      }),
  );

  effectIt.effect.each([true, false])(
    "reconciles Muse durable snapshots without duplicate text (streaming=%s)",
    (enableAssistantStreaming) =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() =>
          createHarness({
            serverSettings: { enableAssistantStreaming },
          }),
        );
        const threadId = ThreadId.make("thread-1");
        const turnId = TurnId.make("muse-snapshot-turn");
        const itemId = RuntimeItemId.make("muse-snapshot-item");
        const createdAt = "2026-09-13T18:00:00.000Z";
        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("muse-snapshot-session"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "muse",
            runtimeMode: "approval-required",
            activeTurnId: turnId,
            updatedAt: createdAt,
            lastError: null,
          },
          createdAt,
        });
        const base = {
          provider: ProviderDriverKind.make("muse"),
          threadId,
          turnId,
          itemId,
          createdAt,
        };
        const emitAndDrain = (event: ProviderRuntimeEvent) =>
          Effect.gen(function* () {
            harness.emit(event);
            yield* Effect.promise(harness.drain);
          });
        yield* emitAndDrain({
          ...base,
          eventId: EventId.make("muse-live-prefix"),
          type: "content.delta",
          payload: { streamKind: "assistant_text", delta: "Partial" },
        });
        const snapshot = {
          ...base,
          eventId: EventId.make("muse-open-snapshot"),
          type: "item.updated" as const,
          payload: { itemType: "assistant_message" as const, detail: "Partial recovered" },
        };
        yield* emitAndDrain(snapshot);
        yield* emitAndDrain(snapshot);
        let thread = (yield* Effect.promise(harness.readModel)).threads.find(
          (entry) => entry.id === threadId,
        )!;
        expect(thread.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
        expect(
          thread.messages.find((message) => message.id === "assistant:muse-snapshot-item"),
        ).toMatchObject({
          text: "Partial recovered",
          streaming: true,
        });
        yield* emitAndDrain({
          ...base,
          eventId: EventId.make("muse-live-suffix"),
          type: "content.delta",
          payload: { streamKind: "assistant_text", delta: " suffix" },
        });
        const complete = {
          ...base,
          eventId: EventId.make("muse-final-snapshot"),
          type: "item.completed" as const,
          payload: {
            itemType: "assistant_message" as const,
            detail: "Partial recovered suffix and final",
          },
        };
        yield* emitAndDrain(complete);
        yield* emitAndDrain(complete);
        // An older open item replay cannot reopen or truncate the completed row.
        yield* emitAndDrain(snapshot);
        thread = (yield* Effect.promise(harness.readModel)).threads.find(
          (entry) => entry.id === threadId,
        )!;
        expect(thread.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
        expect(
          thread.messages.find((message) => message.id === "assistant:muse-snapshot-item"),
        ).toMatchObject({
          text: "Partial recovered suffix and final",
          streaming: false,
        });
        expect(thread.session?.activeTurnId).toBe(turnId);
        expect(thread.session?.status).toBe("running");
        yield* emitAndDrain({
          ...complete,
          eventId: EventId.make("muse-final-corrected"),
          payload: { itemType: "assistant_message", detail: "Partial recovered" },
        });
        thread = (yield* Effect.promise(harness.readModel)).threads.find(
          (entry) => entry.id === threadId,
        )!;
        expect(
          thread.messages.find((message) => message.id === "assistant:muse-snapshot-item")?.text,
        ).toBe("Partial recovered");
      }),
  );

  effectIt.effect.each(["snapshot-first", "terminal-first"] as const)(
    "recovers a Muse final snapshot around terminal delivery without duplicates (%s)",
    (deliveryOrder) =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() => createHarness());
        const threadId = ThreadId.make("thread-1");
        const turnId = TurnId.make("01a09bf9-133d-7681-9a33-e4698bea4fb4");
        const itemId = RuntimeItemId.make("7a025cd6-aa3e-4ca0-bc37-7bd4ea3a830c");
        const startedAt = "2026-09-13T18:13:00.000Z";
        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("muse-terminal-recovery-session"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "muse",
            runtimeMode: "approval-required",
            activeTurnId: turnId,
            updatedAt: startedAt,
            lastError: null,
          },
          createdAt: startedAt,
        });
        const base = { provider: ProviderDriverKind.make("muse"), threadId, turnId };
        const finalText =
          "All work is complete and verified. Final report:\n\nThe changes are ready.";
        const snapshot: ProviderRuntimeEvent = {
          ...base,
          itemId,
          eventId: EventId.make("muse:recovery:1468:item.completed"),
          type: "item.completed",
          createdAt: "2026-09-13T18:39:00.000Z",
          payload: { itemType: "assistant_message", detail: finalText },
        };
        const terminal: ProviderRuntimeEvent = {
          ...base,
          eventId: EventId.make("muse:recovery:1476:turn.completed"),
          type: "turn.completed",
          createdAt: "2026-09-13T18:39:18.000Z",
          payload: { state: "completed" },
        };
        const first = deliveryOrder === "snapshot-first" ? snapshot : terminal;
        const second = deliveryOrder === "snapshot-first" ? terminal : snapshot;
        harness.emit(first);
        yield* Effect.promise(harness.drain);
        if (deliveryOrder === "terminal-first") {
          const thread = (yield* Effect.promise(harness.readModel)).threads.find(
            (entry) => entry.id === threadId,
          )!;
          expect(thread.messages.filter((message) => message.role === "assistant")).toHaveLength(0);
          expect(thread.session).toMatchObject({ status: "ready", activeTurnId: null });
        }
        harness.emit(second);
        yield* Effect.promise(harness.drain);
        // Page overlap may repeat the same stable snapshot after completion.
        harness.emit(snapshot);
        yield* Effect.promise(harness.drain);
        const thread = (yield* Effect.promise(harness.readModel)).threads.find(
          (entry) => entry.id === threadId,
        )!;
        expect(thread.messages.filter((message) => message.role === "assistant")).toEqual([
          expect.objectContaining({
            id: `assistant:${itemId}`,
            turnId,
            text: finalText,
            streaming: false,
          }),
        ]);
        expect(thread.session).toMatchObject({
          status: "ready",
          activeTurnId: null,
          lastError: null,
        });
      }),
  );

  effectIt.effect("keeps newer buffered Muse text when an older open snapshot replays", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({
          serverSettings: { enableAssistantStreaming: false },
        }),
      );
      const threadId = ThreadId.make("thread-1");
      const turnId = TurnId.make("muse-buffered-turn");
      const createdAt = "2026-09-13T18:00:00.000Z";
      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("muse-buffered-session"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "muse",
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      });
      const base = {
        provider: ProviderDriverKind.make("muse"),
        threadId,
        turnId,
        itemId: RuntimeItemId.make("muse-buffered-item"),
        createdAt,
      };
      harness.emit({
        ...base,
        type: "content.delta",
        eventId: EventId.make("muse-buffered-live"),
        payload: { streamKind: "assistant_text", delta: "Hello world" },
      });
      yield* Effect.promise(harness.drain);
      harness.emit({
        ...base,
        type: "item.updated",
        eventId: EventId.make("muse-buffered-old-page"),
        payload: { itemType: "assistant_message", detail: "Hello" },
      });
      yield* Effect.promise(harness.drain);
      harness.emit({
        ...base,
        type: "item.completed",
        eventId: EventId.make("muse-buffered-complete"),
        payload: { itemType: "assistant_message" },
      });
      yield* Effect.promise(harness.drain);
      const thread = (yield* Effect.promise(harness.readModel)).threads.find(
        (entry) => entry.id === threadId,
      )!;
      expect(
        thread.messages.find((message) => message.id === "assistant:muse-buffered-item"),
      ).toMatchObject({ text: "Hello world", streaming: false });
    }),
  );

  effectIt.effect(
    "starts a new buffered assistant message segment after approval and completes without duplication",
    () =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() => createHarness());
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
        yield* Effect.promise(() =>
          waitForThread(
            harness.readModel,
            (thread) =>
              thread.session?.status === "running" &&
              thread.session?.activeTurnId === "turn-buffered-request-append",
          ),
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

        yield* Effect.promise(() =>
          waitForThread(harness.readModel, (entry) =>
            entry.messages.some(
              (message: ProviderRuntimeTestMessage) =>
                message.id === "assistant:item-buffered-request-append" &&
                !message.streaming &&
                message.text === "first half",
            ),
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

        const thread = yield* Effect.promise(() =>
          waitForThread(harness.readModel, (entry) =>
            entry.messages.some(
              (message: ProviderRuntimeTestMessage) =>
                message.id === "assistant:item-buffered-request-append:segment:1" &&
                !message.streaming &&
                message.text === " second half",
            ),
          ),
        );
        const firstMessage = thread.messages.find(
          (entry: ProviderRuntimeTestMessage) =>
            entry.id === "assistant:item-buffered-request-append",
        );
        const resumedMessage = thread.messages.find(
          (entry: ProviderRuntimeTestMessage) =>
            entry.id === "assistant:item-buffered-request-append:segment:1",
        );
        expect(firstMessage?.text).toBe("first half");
        expect(firstMessage?.streaming).toBe(false);
        expect(resumedMessage?.text).toBe(" second half");
        expect(resumedMessage?.streaming).toBe(false);

        const events = yield* Stream.runCollect(harness.engine.readEvents(0)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
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
      }),
  );

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

  effectIt.effect("streams assistant deltas when thread.turn.start requests streaming mode", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({ serverSettings: { enableAssistantStreaming: true } }),
      );
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
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
      });
      yield* Effect.promise(() => harness.drain());

      harness.emit({
        type: "turn.started",
        eventId: asEventId("evt-turn-started-streaming-mode"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-streaming-mode"),
      });
      yield* Effect.promise(() =>
        waitForThread(
          harness.readModel,
          (thread) =>
            thread.session?.status === "running" &&
            thread.session?.activeTurnId === "turn-streaming-mode",
        ),
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

      const liveThread = yield* Effect.promise(() =>
        waitForThread(harness.readModel, (entry) =>
          entry.messages.some(
            (message: ProviderRuntimeTestMessage) =>
              message.id === "assistant:item-streaming-mode" &&
              message.streaming &&
              message.text === "hello live",
          ),
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

      const finalThread = yield* Effect.promise(() =>
        waitForThread(harness.readModel, (entry) =>
          entry.messages.some(
            (message: ProviderRuntimeTestMessage) =>
              message.id === "assistant:item-streaming-mode" && !message.streaming,
          ),
        ),
      );
      const finalMessage = finalThread.messages.find(
        (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-streaming-mode",
      );
      expect(finalMessage?.text).toBe("hello live");
      expect(finalMessage?.streaming).toBe(false);
    }),
  );

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

  effectIt.effect(
    "does not duplicate assistant completion when item.completed is followed by turn.completed",
    () =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() => createHarness());
        const now = "2026-01-01T00:00:00.000Z";

        harness.emit({
          type: "turn.started",
          eventId: asEventId("evt-turn-started-for-complete-dedup"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: now,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-complete-dedup"),
        });

        yield* Effect.promise(() =>
          waitForThread(
            harness.readModel,
            (thread) =>
              thread.session?.status === "running" &&
              thread.session?.activeTurnId === "turn-complete-dedup",
          ),
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

        yield* Effect.promise(() =>
          waitForThread(
            harness.readModel,
            (thread) =>
              thread.session?.status === "ready" &&
              thread.session?.activeTurnId === null &&
              thread.messages.some(
                (message: ProviderRuntimeTestMessage) =>
                  message.id === "assistant:item-complete-dedup" && !message.streaming,
              ),
          ),
        );

        const events = yield* Stream.runCollect(harness.engine.readEvents(0)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
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
      }),
  );

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

  it("keeps a retryable upstream turn failure off the session error banner", async () => {
    // 2026-09-17 16:03: OpenCode's gateway 503 closed the turn as failed with
    // failureKind retryable-upstream. The reactor retried silently, but the
    // session carried the provider text as lastError for the whole backoff,
    // which the clients render as a red banner with a Resume button.
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-retryable"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: now,
      turnId: asTurnId("turn-retryable-503"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-retryable-503",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-failed-retryable"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-retryable-503"),
      payload: {
        state: "failed",
        errorMessage:
          "The provider remained overloaded after its bounded retries. Try this turn again shortly. Streaming response failed: [api_error] upstream provider error (HTTP 503)",
        failureKind: "retryable-upstream",
      },
    });

    await harness.drain();
    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.session?.activeTurnId === null,
    );
    expect(thread.session?.status).toBe("error");
    // The failure kind (persisted by the SQL projection; this harness's read
    // model omits it) routes the reactor to its silent retry; the provider's
    // text stays off the session so no client draws a banner.
    expect(thread.session?.lastError ?? null).toBeNull();
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

  it("hides a provider's raw context-overflow error because the history reset owns it", async () => {
    // Open World side chat, 2026-09-17 14:41: OpenCode answered
    // `{"type":"invalid_request_error","message":"… Prompt too long: the
    // maximum context length is 262144 tokens …"}`. The reactor discards the
    // history and resumes in a fresh session with a digest, appending its own
    // `provider.history.reset` notice; the raw card on top of it was noise.
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error-context-overflow"),
      // The harness thread's session is a codex session; the classifier is
      // provider-agnostic and the live case was OpenCode.
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-context-overflow"),
      payload: {
        message:
          "Streaming response failed: [invalid_request_error] Prompt too long: the maximum context length is 262144 tokens including the completion",
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "error" &&
        (entry.session?.lastError ?? "").includes("maximum context length"),
    );
    // The session still records the failure so the recovery path can read
    // and classify it; only the feed card is withheld.
    expect(thread.session?.lastError).toContain("Prompt too long");
    expect(thread.activities.filter((activity) => activity.kind === "runtime.error")).toEqual([]);
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

    // Progress and completion share one activity id per task, so read the
    // progress frame before the completion replaces it.
    const progressThread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.id === "task:thread-1:turn-task-1" && activity.kind === "task.progress",
      ),
    );
    const progress = progressThread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "task:thread-1:turn-task-1",
    );

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
    const completed = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "task:thread-1:turn-task-1",
    );
    expect(
      thread.activities.filter(
        (activity: ProviderRuntimeTestActivity) => activity.id === "task:thread-1:turn-task-1",
      ),
    ).toHaveLength(1);

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

    const progressThread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.id === "task:thread-1:named-task-1" && activity.kind === "task.progress",
      ),
    );
    const progress = progressThread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "task:thread-1:named-task-1",
    );

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
        (activity: ProviderRuntimeTestActivity) =>
          activity.id === "task:thread-1:named-task-1" && activity.kind === "task.completed",
      ),
    );

    const completed = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "task:thread-1:named-task-1",
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

  it.each([false, true])(
    "persists Codex task identity with terminal status across late metadata (after completion: %s)",
    async (afterCompletion) => {
      const harness = await createHarness();
      const base = {
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("codex-parent"),
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      const taskId = "codex-subagent:child";
      const title = "Codex subagent /root/installed_task_probe";
      harness.emit({
        ...base,
        type: "task.started",
        eventId: asEventId("identity-start"),
        payload: { taskId, description: "Codex subagent child", taskType: "local_agent" },
      });
      if (!afterCompletion)
        harness.emit({
          ...base,
          type: "task.progress",
          eventId: asEventId("identity-progress"),
          payload: { taskId, title, description: "Running command" },
        });
      harness.emit({
        ...base,
        type: "task.completed",
        eventId: asEventId("identity-complete"),
        payload: {
          taskId,
          status: "completed",
          summary: "Verified",
          usage: { total_tokens: 1234 },
        },
      });
      await harness.drain();
      const observationsBeforeMetadata = harness.runtimeObservations.length;
      if (afterCompletion) {
        harness.emit({
          ...base,
          createdAt: "2026-01-01T00:00:01.000Z",
          type: "task.completed",
          eventId: asEventId("identity-metadata"),
          payload: {
            taskId,
            title,
            status: "completed",
            metadataOnly: true,
            summary: "Verified",
            usage: { total_tokens: 1234 },
          },
        });
        await harness.drain();
        expect(harness.runtimeObservations).toHaveLength(observationsBeforeMetadata);
      }
      // Read a fresh SQL-backed projection: progress/completion replace by activity ID.
      // No in-memory task state from before the metadata update participates in this read.
      const thread = (await harness.readModel()).threads.find(
        (thread) => thread.id === base.threadId,
      )!;
      const lifecycle = thread.activities.filter(
        (row) => row.id === "task:thread-1:codex-subagent:child",
      );
      expect(lifecycle).toHaveLength(1);
      expect(lifecycle[0]?.kind).toBe("task.completed");
      expect(lifecycle[0]?.payload).toMatchObject({ title, status: "completed" });
      expect(lifecycle[0]?.payload).toMatchObject({ usage: { total_tokens: 1234 } });
      expect(harness.sendTurnCalls).toHaveLength(0);
    },
  );

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
        (activity: ProviderRuntimeTestActivity) =>
          activity.id === "task:thread-1:fast-task-1" && activity.kind === "task.completed",
      ),
    );

    const completed = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "task:thread-1:fast-task-1",
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
        (activity: ProviderRuntimeTestActivity) =>
          activity.id === "task:thread-1:swept-task-1" && activity.kind === "task.progress",
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
        (activity: ProviderRuntimeTestActivity) =>
          activity.id === "task:thread-1:swept-task-1" && activity.kind === "task.completed",
      ),
    );

    const completed = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "task:thread-1:swept-task-1",
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
