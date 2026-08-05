// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ModelSelection,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { AGENT_CONTINUE_PROMPT } from "@t3tools/shared/agentMode";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { deriveServerPaths, ServerConfig } from "../../config.ts";
import { TextGenerationError } from "@t3tools/contracts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ThreadWorkObligationRepositoryLive } from "../../persistence/Layers/ThreadWorkObligations.ts";
import { ThreadWorkObligationRepository } from "../../persistence/Services/ThreadWorkObligations.ts";
import { RuntimeLeaseRegistryLive } from "../../provider/Layers/RuntimeLeaseRegistry.ts";
import { ThreadSubscriptionRegistryLive } from "./ThreadSubscriptionRegistry.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { makeProviderRegistryLayer } from "../../provider/testUtils/providerRegistryMock.ts";
import { TextGeneration, type TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import {
  providerErrorLabel,
  providerErrorLabelFromInstanceHint,
  classifyTurnStartRecovery,
  makeProviderCommandReactorLive,
  providerTurnProducedOutput,
} from "./ProviderCommandReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadWorkScheduler } from "../Services/ThreadWorkScheduler.ts";
import { makeThreadWorkSchedulerLive } from "./ThreadWorkScheduler.ts";
import { activeTurnWorkSourceId, agentAutoResumeIds } from "../agentModeContinuation.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import { ServerSettingsService } from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asApprovalRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

const deriveServerPathsSync = (baseDir: string, devUrl: URL | undefined) =>
  Effect.runSync(deriveServerPaths(baseDir, devUrl).pipe(Effect.provide(NodeServices.layer)));

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await Effect.runPromise(Effect.yieldNow);
    return poll();
  };

  return poll();
}

describe("ProviderCommandReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | ProviderCommandReactor
    | ProjectionSnapshotQuery
    | ThreadWorkScheduler
    | ThreadWorkObligationRepository,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const createdStateDirs = new Set<string>();
  const createdBaseDirs = new Set<string>();

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const stateDir of createdStateDirs) {
      NodeFS.rmSync(stateDir, { recursive: true, force: true });
    }
    createdStateDirs.clear();
    for (const baseDir of createdBaseDirs) {
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
    createdBaseDirs.clear();
  });

  // An upstream request that times out ends the provider turn "successfully"
  // with an empty body — no message, no activity, nothing. Accepting that as a
  // finished resume retires the obligation, and the one-resume-per-source-turn
  // key then blocks every further attempt, so the thread sits dead wearing a
  // resume badge it never earned. Observed in production 2026-08-05 on the "3D
  // Modeling Trial" thread: the resume fired, ran 5m8s, emitted zero messages
  // and zero activities, and the thread stayed dead until morning. The healthy
  // resume on the sibling thread emitted 7 messages and 34 activities, so
  // "produced nothing at all" is an unambiguous discriminator.
  // Observed twice in production 2026-08-05: an auto-resume was enqueued,
  // dispatched, and then cancelled ~1.5s later as "turn-start was superseded"
  // with nothing whatsoever after it — `hasLaterRealUserTurn` was 0. The
  // handler reads the thread and the turn-start context separately, the
  // dispatch landed between the two reads, and the missing message was scored
  // as supersession. Since the projector declines to enqueue when a row for
  // that key exists, killing the row left nothing to drive the resume.
  describe("classifyTurnStartRecovery", () => {
    const userMessage = { role: "user", inputOrigin: null };

    it("waits rather than giving up when the source message has not projected yet", () => {
      expect(
        classifyTurnStartRecovery({ sourceMessage: undefined, hasLaterRealUserTurn: false }),
      ).toBe("awaiting-projection");
    });

    // Even with a later user turn, absence still means "not projected yet":
    // we cannot judge a message we cannot see, and the retry re-reads.
    it("does not score an unseen message as superseded", () => {
      expect(
        classifyTurnStartRecovery({ sourceMessage: undefined, hasLaterRealUserTurn: true }),
      ).toBe("awaiting-projection");
    });

    it("proceeds for a real user send with nothing behind it", () => {
      expect(
        classifyTurnStartRecovery({ sourceMessage: userMessage, hasLaterRealUserTurn: false }),
      ).toBe("proceed");
    });

    it("gives up once a genuinely later user turn exists", () => {
      expect(
        classifyTurnStartRecovery({ sourceMessage: userMessage, hasLaterRealUserTurn: true }),
      ).toBe("superseded");
    });

    it("gives up when the message is not a real user send", () => {
      expect(
        classifyTurnStartRecovery({
          sourceMessage: { role: "assistant", inputOrigin: null },
          hasLaterRealUserTurn: false,
        }),
      ).toBe("superseded");
      expect(
        classifyTurnStartRecovery({
          sourceMessage: { role: "user", inputOrigin: "agent-loop" },
          hasLaterRealUserTurn: false,
        }),
      ).toBe("superseded");
    });
  });

  describe("providerTurnProducedOutput", () => {
    const threadWith = (input: {
      readonly messageTurnIds: ReadonlyArray<string>;
      readonly activityTurnIds: ReadonlyArray<string | null>;
    }) =>
      ({
        messages: input.messageTurnIds.map((turnId) => ({ turnId: asTurnId(turnId) })),
        activities: input.activityTurnIds.map((turnId) => ({
          turnId: turnId === null ? null : asTurnId(turnId),
        })),
      }) as unknown as Parameters<typeof providerTurnProducedOutput>[0];

    it("is false for a turn that emitted neither a message nor an activity", () => {
      expect(
        providerTurnProducedOutput(
          threadWith({ messageTurnIds: ["other-turn"], activityTurnIds: ["other-turn", null] }),
          asTurnId("empty-resume-turn"),
        ),
      ).toBe(false);
    });

    it("is true when the turn spoke", () => {
      expect(
        providerTurnProducedOutput(
          threadWith({ messageTurnIds: ["resume-turn"], activityTurnIds: [] }),
          asTurnId("resume-turn"),
        ),
      ).toBe(true);
    });

    // A resume that only ran tools and never wrote prose still resumed, so
    // activities alone must count — otherwise the retry would re-run real work.
    it("is true when the turn only ran tools", () => {
      expect(
        providerTurnProducedOutput(
          threadWith({ messageTurnIds: [], activityTurnIds: ["resume-turn"] }),
          asTurnId("resume-turn"),
        ),
      ).toBe(true);
    });
  });

  describe("provider error attribution", () => {
    it("uses the current provider instance slug when current instance lookup fails", () => {
      expect(
        providerErrorLabelFromInstanceHint({
          instanceId: "codex_personal",
          modelSelectionInstanceId: "codex",
          sessionProvider: "codex",
        }),
      ).toBe("codex_personal");
    });

    it("uses the desired provider instance slug when desired instance lookup fails", () => {
      expect(
        providerErrorLabelFromInstanceHint({
          instanceId: "claude_openrouter",
        }),
      ).toBe("claude_openrouter");
    });

    it("uses the unknown driver kind when the resolved driver is not registered locally", () => {
      expect(providerErrorLabel("third_party_driver")).toBe("third_party_driver");
    });
  });

  async function createHarness(input?: {
    readonly baseDir?: string;
    readonly threadModelSelection?: ModelSelection;
    readonly sessionModelSwitch?: "unsupported" | "in-session";
    readonly requiresNewThreadForModelChange?: boolean;
    readonly startReactor?: boolean;
    readonly providerSilenceRestartMs?: number;
    readonly startSessionEffect?: (
      session: ProviderSession,
    ) => Effect.Effect<ProviderSession, ProviderAdapterRequestError>;
  }) {
    const now = "2026-01-01T00:00:00.000Z";
    const baseDir =
      input?.baseDir ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-reactor-"));
    createdBaseDirs.add(baseDir);
    const { stateDir } = deriveServerPathsSync(baseDir, undefined);
    createdStateDirs.add(stateDir);
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    let nextSessionIndex = 1;
    const runtimeSessions: Array<ProviderSession> = [];
    const modelSelection = input?.threadModelSelection ?? {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    };
    const startSessionEffect = input?.startSessionEffect;
    const startSession = vi.fn((_: unknown, input: unknown) => {
      const sessionIndex = nextSessionIndex++;
      const resumeCursor =
        typeof input === "object" && input !== null && "resumeCursor" in input
          ? input.resumeCursor
          : undefined;
      const threadId =
        typeof input === "object" &&
        input !== null &&
        "threadId" in input &&
        typeof input.threadId === "string"
          ? ThreadId.make(input.threadId)
          : ThreadId.make(`thread-${sessionIndex}`);
      const inputModelSelection =
        typeof input === "object" && input !== null && "modelSelection" in input
          ? (input.modelSelection as ModelSelection | undefined)
          : undefined;
      const providerInstanceId =
        typeof input === "object" && input !== null && "providerInstanceId" in input
          ? (input.providerInstanceId as ProviderInstanceId | undefined)
          : inputModelSelection?.instanceId;
      const provider =
        typeof input === "object" &&
        input !== null &&
        "provider" in input &&
        typeof input.provider === "string"
          ? (input.provider as ProviderSession["provider"])
          : ProviderDriverKind.make(inputModelSelection?.instanceId ?? modelSelection.instanceId);
      const session: ProviderSession = {
        provider,
        ...(providerInstanceId ? { providerInstanceId } : {}),
        status: "ready" as const,
        runtimeMode:
          typeof input === "object" &&
          input !== null &&
          "runtimeMode" in input &&
          (input.runtimeMode === "approval-required" || input.runtimeMode === "full-access")
            ? input.runtimeMode
            : "full-access",
        ...(typeof input === "object" &&
        input !== null &&
        "cwd" in input &&
        typeof input.cwd === "string"
          ? { cwd: input.cwd }
          : {}),
        ...((inputModelSelection?.model ?? modelSelection.model)
          ? { model: inputModelSelection?.model ?? modelSelection.model }
          : {}),
        threadId,
        resumeCursor: resumeCursor ?? { opaque: `resume-${sessionIndex}` },
        createdAt: now,
        updatedAt: now,
      };
      return (startSessionEffect?.(session) ?? Effect.succeed(session)).pipe(
        Effect.tap((startedSession) =>
          Effect.sync(() => {
            runtimeSessions.push(startedSession);
          }),
        ),
      );
    });
    const sendTurn = vi.fn((_: unknown) =>
      Effect.succeed({
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
      }),
    );
    const interruptTurn = vi.fn((_: unknown) => Effect.void);
    const respondToRequest = vi.fn<ProviderServiceShape["respondToRequest"]>(() => Effect.void);
    const respondToUserInput = vi.fn<ProviderServiceShape["respondToUserInput"]>(() => Effect.void);
    const stopSession = vi.fn((input: unknown) =>
      Effect.sync(() => {
        const threadId =
          typeof input === "object" && input !== null && "threadId" in input
            ? (input as { threadId?: ThreadId }).threadId
            : undefined;
        if (!threadId) {
          return;
        }
        const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
        if (index >= 0) {
          runtimeSessions.splice(index, 1);
        }
      }),
    );
    const forkSessionBinding = vi.fn<NonNullable<ProviderServiceShape["forkSessionBinding"]>>(
      (forkInput) =>
        Effect.succeed({
          threadId: forkInput.targetThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "closed",
          runtimeMode: forkInput.runtimeMode,
          resumeCursor: { opaque: `fork-${String(forkInput.targetThreadId)}` },
          createdAt: now,
          updatedAt: now,
        }),
    );
    const renameBranch = vi.fn((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "newBranch" in input &&
          typeof input.newBranch === "string"
            ? input.newBranch
            : "renamed-branch",
      }),
    );
    const refreshStatus = vi.fn((_: string) =>
      Effect.succeed({
        isRepo: true,
        hasPrimaryRemote: true,
        isDefaultRef: false,
        refName: "renamed-branch",
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: true,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      }),
    );
    const generateBranchName = vi.fn<TextGenerationShape["generateBranchName"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateBranchName",
          detail: "disabled in test harness",
        }),
      ),
    );
    const generateThreadTitle = vi.fn<TextGenerationShape["generateThreadTitle"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateThreadTitle",
          detail: "disabled in test harness",
        }),
      ),
    );
    const providerSnapshots: ReadonlyArray<ServerProvider> = [
      {
        instanceId: modelSelection.instanceId,
        driver: ProviderDriverKind.make(
          String(modelSelection.instanceId).startsWith("claude") ? "claudeAgent" : "codex",
        ),
        enabled: true,
        installed: true,
        version: "test",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: now,
        availability: "available",
        models: [],
        slashCommands: [],
        skills: [],
        ...(input?.requiresNewThreadForModelChange === true
          ? { requiresNewThreadForModelChange: true }
          : {}),
      },
    ];

    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const service: ProviderServiceShape = {
      startSession: startSession as ProviderServiceShape["startSession"],
      sendTurn: sendTurn as ProviderServiceShape["sendTurn"],
      interruptTurn: interruptTurn as ProviderServiceShape["interruptTurn"],
      respondToRequest: respondToRequest as ProviderServiceShape["respondToRequest"],
      respondToUserInput: respondToUserInput as ProviderServiceShape["respondToUserInput"],
      stopSession: stopSession as ProviderServiceShape["stopSession"],
      forkSessionBinding,
      listSessions: () => Effect.succeed(runtimeSessions),
      getCapabilities: (_provider) =>
        Effect.succeed({
          sessionModelSwitch: input?.sessionModelSwitch ?? "in-session",
        }),
      getInstanceInfo: (instanceId) => {
        const raw = String(instanceId);
        const driverKind = ProviderDriverKind.make(
          raw.startsWith("claude") ? "claudeAgent" : raw.startsWith("codex") ? "codex" : raw,
        );
        return Effect.succeed({
          instanceId,
          driverKind,
          displayName: undefined,
          enabled: true,
          continuationIdentity: {
            driverKind,
            continuationKey:
              driverKind === ProviderDriverKind.make("codex")
                ? "codex:home:/shared-codex"
                : `${driverKind}:instance:${instanceId}`,
          },
        });
      },
      rollbackConversation: () => unsupported(),
      get streamEvents() {
        return Stream.fromPubSub(runtimeEventPubSub);
      },
    };

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
    const threadWorkPersistenceLayer = ThreadWorkObligationRepositoryLive.pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
    );
    const threadWorkSchedulerLayer = makeThreadWorkSchedulerLive({
      pollIntervalMs: 60_000,
      claimLeaseMs: 60_000,
      heartbeatIntervalMs: 30_000,
    }).pipe(
      Layer.provideMerge(threadWorkPersistenceLayer),
      Layer.provideMerge(RuntimeLeaseRegistryLive),
    );
    const providerCommandReactorLayer = makeProviderCommandReactorLive(
      input?.providerSilenceRestartMs === undefined
        ? undefined
        : { providerSilenceRestartMs: input.providerSilenceRestartMs },
    ).pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, service)),
      Layer.provideMerge(makeProviderRegistryLayer(providerSnapshots)),
      Layer.provideMerge(threadWorkPersistenceLayer),
      Layer.provideMerge(threadWorkSchedulerLayer),
      Layer.provideMerge(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          renameBranch,
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
      ),
      Layer.provideMerge(
        Layer.succeed(VcsStatusBroadcaster, {
          getStatus: () => Effect.die("getStatus should not be called in this test"),
          refreshLocalStatus: () =>
            Effect.die("refreshLocalStatus should not be called in this test"),
          refreshStatus,
          streamStatus: () => Stream.die("streamStatus should not be called in this test"),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(TextGeneration, {
          generateBranchName,
          generateThreadTitle,
        }),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provideMerge(NodeServices.layer),
    );
    const layer = Layer.mergeAll(
      providerCommandReactorLayer,
      threadWorkSchedulerLayer,
      threadWorkPersistenceLayer,
    ).pipe(Layer.provideMerge(ThreadSubscriptionRegistryLive));
    runtime = ManagedRuntime.make(layer);

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const reactor = await runtime.runPromise(Effect.service(ProviderCommandReactor));
    const threadWorkObligations = await runtime.runPromise(
      Effect.service(ThreadWorkObligationRepository),
    );
    const threadWorkScheduler = await runtime.runPromise(Effect.service(ThreadWorkScheduler));
    scope = await Effect.runPromise(Scope.make("sequential"));
    let reactorStarted = false;
    const startReactor = async () => {
      if (reactorStarted) return;
      reactorStarted = true;
      await Effect.runPromise(reactor.start().pipe(Scope.provide(scope!)));
    };
    if (input?.startReactor !== false) {
      await startReactor();
    }
    const drain = () => Effect.runPromise(reactor.drain);

    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot: "/tmp/provider-project",
        defaultModelSelection: modelSelection,
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create"),
        threadId: ThreadId.make("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    return {
      engine,
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      forkSessionBinding,
      renameBranch,
      refreshStatus,
      generateBranchName,
      generateThreadTitle,
      runtimeSessions,
      stateDir,
      drain,
      startReactor,
      threadWorkObligations,
      threadWorkScheduler,
    };
  }

  it("reacts to thread.turn.start by ensuring session and sending provider turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-1"),
          role: "user",
          text: "hello reactor",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[0]).toEqual(ThreadId.make("thread-1"));
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.status).toBe("starting");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  it("continues multiple Agent turns from the server without a mounted chat view", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-agent-1");
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("cmd-agent-mode"),
        threadId,
        interactionMode: "agent",
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-agent-first-turn"),
        threadId,
        message: {
          messageId: asMessageId("user-message-agent-first-turn"),
          role: "user",
          text: "Work autonomously.",
          attachments: [],
        },
        interactionMode: "agent",
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-agent-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-agent-next-model"),
        threadId,
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-agent-assistant-delta"),
        threadId,
        messageId: asMessageId("assistant-message-agent-1"),
        delta: "Finished one phase and continuing.",
        turnId,
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-agent-assistant-complete"),
        threadId,
        messageId: asMessageId("assistant-message-agent-1"),
        turnId,
        createdAt: "2026-01-01T00:00:03.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-agent-ready"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:04.000Z",
        },
        createdAt: "2026-01-01T00:00:04.000Z",
      }),
    );

    await waitFor(async () =>
      Option.isSome(
        await Effect.runPromise(
          harness.threadWorkObligations.getByKey({
            threadId,
            sourceTurnId: turnId,
            kind: "agent-continuation",
          }),
        ),
      ),
    );
    await waitFor(async () => {
      if (harness.sendTurn.mock.calls.length === 2) return true;
      const work = Option.getOrUndefined(
        await Effect.runPromise(
          harness.threadWorkObligations.getByKey({
            threadId,
            sourceTurnId: turnId,
            kind: "agent-continuation",
          }),
        ),
      );
      if (work?.state === "cancelled" || work?.state === "sleeping") {
        throw new Error(`Agent continuation became ${work.state}: ${work.blockedReason ?? ""}`);
      }
      return false;
    });
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId,
      input: AGENT_CONTINUE_PROMPT,
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
    });
    let readModel = await harness.readModel();
    let thread = readModel.threads.find((entry) => entry.id === threadId);
    expect(thread?.messages.at(-1)).toMatchObject({
      role: "user",
      text: AGENT_CONTINUE_PROMPT,
      inputOrigin: "agent-loop",
    });

    const continuationTurnId = asTurnId("turn-agent-2");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-agent-continuation-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: continuationTurnId,
          lastError: null,
          updatedAt: "2099-01-01T00:00:05.000Z",
        },
        createdAt: "2099-01-01T00:00:05.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-agent-continuation-assistant-delta"),
        threadId,
        messageId: asMessageId("assistant-message-agent-2"),
        delta: "The next autonomous phase is complete; more work remains.",
        turnId: continuationTurnId,
        createdAt: "2099-01-01T00:00:06.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-agent-continuation-assistant-complete"),
        threadId,
        messageId: asMessageId("assistant-message-agent-2"),
        turnId: continuationTurnId,
        createdAt: "2099-01-01T00:00:07.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-agent-continuation-ready"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2099-01-01T00:00:08.000Z",
        },
        createdAt: "2099-01-01T00:00:08.000Z",
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 3);
    expect(harness.sendTurn.mock.calls[2]?.[0]).toMatchObject({
      threadId,
      input: AGENT_CONTINUE_PROMPT,
    });
    readModel = await harness.readModel();
    thread = readModel.threads.find((entry) => entry.id === threadId);
    expect(
      thread?.messages.filter(
        (message) => message.role === "user" && message.inputOrigin === "agent-loop",
      ),
    ).toHaveLength(2);
  });

  it("recovers an already-projected Agent continuation after a server restart", async () => {
    const harness = await createHarness({ startReactor: false });
    const threadId = ThreadId.make("thread-1");
    const sourceTurnId = asTurnId("turn-agent-restart-source");
    const continuationTurnId = asTurnId("turn-agent-restart-continuation");
    const sourceMessageId = asMessageId("user-message-agent-restart-source");
    const assistantMessageId = asMessageId("assistant-message-agent-restart-source");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("cmd-agent-restart-mode"),
        threadId,
        interactionMode: "agent",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-agent-restart-source"),
        threadId,
        message: {
          messageId: sourceMessageId,
          role: "user",
          text: "Keep working autonomously until every requirement is verified.",
          attachments: [],
        },
        interactionMode: "agent",
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-agent-restart-source-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: sourceTurnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-agent-restart-source-delta"),
        threadId,
        messageId: assistantMessageId,
        delta: "One phase is complete; the remaining acceptance checks still need work.",
        turnId: sourceTurnId,
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-agent-restart-source-complete"),
        threadId,
        messageId: assistantMessageId,
        turnId: sourceTurnId,
        createdAt: "2026-01-01T00:00:03.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-agent-restart-source-ready"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:04.000Z",
        },
        createdAt: "2026-01-01T00:00:04.000Z",
      }),
    );
    await waitFor(async () =>
      Option.isSome(
        await Effect.runPromise(
          harness.threadWorkObligations.getByKey({
            threadId,
            sourceTurnId,
            kind: "agent-continuation",
          }),
        ),
      ),
    );

    const continuationIds = agentAutoResumeIds({ threadId, completedTurnId: sourceTurnId });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: continuationIds.commandId,
        threadId,
        message: {
          messageId: continuationIds.messageId,
          role: "user",
          text: AGENT_CONTINUE_PROMPT,
          inputOrigin: "agent-loop",
          attachments: [],
        },
        interactionMode: "agent",
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:05.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-agent-restart-continuation-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: continuationTurnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:06.000Z",
        },
        createdAt: "2026-01-01T00:00:06.000Z",
      }),
    );

    await harness.startReactor();
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId,
      messageId: MessageId.make(`agent-continuation-recovery-delivery:${threadId}:${sourceTurnId}`),
      input: AGENT_CONTINUE_PROMPT,
    });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    expect(thread?.messages.filter((message) => message.inputOrigin === "agent-loop")).toHaveLength(
      1,
    );
  });

  it("resumes a completed authentication-failure turn without projecting a user message", async () => {
    const harness = await createHarness({ startReactor: false });
    const threadId = ThreadId.make("thread-1");
    const sourceTurnId = asTurnId("turn-auth-resume-source");
    const sourceMessageId = asMessageId("user-message-auth-resume-source");
    const assistantMessageId = asMessageId("assistant-message-auth-resume-source");
    const authFailure = "Failed to authenticate: OAuth session expired and could not be refreshed";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("cmd-auth-resume-agent-mode"),
        threadId,
        interactionMode: "agent",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-auth-resume-source"),
        threadId,
        message: {
          messageId: sourceMessageId,
          role: "user",
          text: "Continue the task after authentication recovers.",
          attachments: [],
        },
        interactionMode: "agent",
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-auth-resume-source-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: sourceTurnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-auth-resume-source-delta"),
        threadId,
        messageId: assistantMessageId,
        delta: authFailure,
        turnId: sourceTurnId,
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-auth-resume-source-complete"),
        threadId,
        messageId: assistantMessageId,
        turnId: sourceTurnId,
        createdAt: "2026-01-01T00:00:03.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-auth-resume-source-error"),
        threadId,
        session: {
          threadId,
          status: "error",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: authFailure,
          updatedAt: "2026-01-01T00:00:04.000Z",
        },
        createdAt: "2026-01-01T00:00:04.000Z",
      }),
    );

    const obligation = Option.getOrThrow(
      await Effect.runPromise(
        harness.threadWorkObligations.getByKey({
          threadId,
          sourceTurnId,
          kind: "authentication-resume",
        }),
      ),
    );
    expect(
      await Effect.runPromise(
        harness.threadWorkObligations.transition({
          obligationId: obligation.obligationId,
          expectedState: "blocked-authentication",
          expectedAttempt: obligation.attempt,
          state: "pending",
          nextAttemptAt: null,
          claimedAt: null,
          leaseExpiresAt: null,
          blockedReason: null,
          updatedAt: "2026-01-01T00:00:05.000Z",
        }),
      ),
    ).toBe(true);

    await harness.startReactor();
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId,
      messageId: MessageId.make(`provider-auth-resume-delivery:${threadId}:${sourceTurnId}`),
      input: AGENT_CONTINUE_PROMPT,
    });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    expect(thread?.messages.filter((message) => message.role === "user")).toHaveLength(1);
  });

  it("resumes twenty authentication-paused threads exactly once each with recovery concurrency two", async () => {
    const harness = await createHarness({ startReactor: false });
    const threadCount = 20;
    const authFailure = "Failed to authenticate: OAuth session expired and could not be refreshed";
    const threadIds = Array.from({ length: threadCount }, (_, index) =>
      ThreadId.make(`thread-auth-mass-${index}`),
    );
    const sourceTurnIdFor = (index: number) => asTurnId(`turn-auth-mass-${index}`);

    for (let index = 0; index < threadCount; index += 1) {
      const threadId = threadIds[index]!;
      const sourceTurnId = sourceTurnIdFor(index);
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`cmd-auth-mass-create-${index}`),
          threadId,
          projectId: asProjectId("project-1"),
          title: `Auth mass thread ${index}`,
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "agent",
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`cmd-auth-mass-turn-${index}`),
          threadId,
          message: {
            messageId: asMessageId(`user-message-auth-mass-${index}`),
            role: "user",
            text: "Continue the task after authentication recovers.",
            attachments: [],
          },
          interactionMode: "agent",
          runtimeMode: "approval-required",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`cmd-auth-mass-running-${index}`),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "approval-required",
            activeTurnId: sourceTurnId,
            lastError: null,
            updatedAt: "2026-01-01T00:00:01.000Z",
          },
          createdAt: "2026-01-01T00:00:01.000Z",
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make(`cmd-auth-mass-delta-${index}`),
          threadId,
          messageId: asMessageId(`assistant-message-auth-mass-${index}`),
          delta: authFailure,
          turnId: sourceTurnId,
          createdAt: "2026-01-01T00:00:02.000Z",
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.make(`cmd-auth-mass-complete-${index}`),
          threadId,
          messageId: asMessageId(`assistant-message-auth-mass-${index}`),
          turnId: sourceTurnId,
          createdAt: "2026-01-01T00:00:03.000Z",
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`cmd-auth-mass-stopped-${index}`),
          threadId,
          session: {
            threadId,
            status: "stopped",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: authFailure,
            updatedAt: "2026-01-01T00:00:04.000Z",
          },
          createdAt: "2026-01-01T00:00:04.000Z",
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`cmd-auth-mass-error-${index}`),
          threadId,
          session: {
            threadId,
            status: "error",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: authFailure,
            updatedAt: "2026-01-01T00:00:05.000Z",
          },
          createdAt: "2026-01-01T00:00:05.000Z",
        }),
      );
    }

    const pausedReadModel = await harness.readModel();
    for (let index = 0; index < threadCount; index += 1) {
      const threadId = threadIds[index]!;
      const obligation = Option.getOrThrow(
        await Effect.runPromise(
          harness.threadWorkObligations.getByKey({
            threadId,
            sourceTurnId: sourceTurnIdFor(index),
            kind: "authentication-resume",
          }),
        ),
      );
      expect(obligation.state).toBe("blocked-authentication");
      const thread = pausedReadModel.threads.find((entry) => entry.id === threadId);
      expect(thread?.latestTurn?.state).toBe("incomplete");
    }

    let inFlight = 0;
    let peakInFlight = 0;
    let dispatchedTurns = 0;
    harness.sendTurn.mockImplementation((request: unknown) =>
      Effect.gen(function* () {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 40)));
        inFlight -= 1;
        dispatchedTurns += 1;
        const requestThreadId =
          typeof request === "object" && request !== null && "threadId" in request
            ? (request as { threadId: ThreadId }).threadId
            : ThreadId.make("thread-auth-mass-unknown");
        return {
          threadId: requestThreadId,
          turnId: asTurnId(`turn-auth-mass-resume-${dispatchedTurns}`),
        };
      }),
    );

    // Reactor startup runs the authentication recovery sweep against the
    // already-authenticated provider snapshot, releasing every paused thread.
    await harness.startReactor();
    await waitFor(async () => {
      for (let index = 0; index < threadCount; index += 1) {
        const obligation = await Effect.runPromise(
          harness.threadWorkObligations.getByKey({
            threadId: threadIds[index]!,
            sourceTurnId: sourceTurnIdFor(index),
            kind: "authentication-resume",
          }),
        );
        if (Option.getOrNull(obligation)?.state !== "completed") return false;
      }
      return true;
    });

    expect(harness.sendTurn.mock.calls).toHaveLength(threadCount);
    const deliveredMessageIds = harness.sendTurn.mock.calls.map(
      (call) => (call[0] as { messageId: MessageId }).messageId,
    );
    const expectedMessageIds = threadIds.map((threadId, index) =>
      MessageId.make(`provider-auth-resume-delivery:${threadId}:${sourceTurnIdFor(index)}`),
    );
    expect([...deliveredMessageIds].sort()).toEqual([...expectedMessageIds].sort());
    expect(peakInFlight).toBe(2);

    const resumedReadModel = await harness.readModel();
    for (const threadId of threadIds) {
      const thread = resumedReadModel.threads.find((entry) => entry.id === threadId);
      expect(thread?.messages.filter((message) => message.role === "user")).toHaveLength(1);
    }
  });

  it.each([
    { name: "main thread", threadId: ThreadId.make("thread-1"), isSideChat: false },
    {
      name: "side chat",
      threadId: ThreadId.make("thread-agent-stop-race-side-chat"),
      isSideChat: true,
    },
  ])(
    "does not continue a $name from cached commentary after its final Agent reply stops",
    async ({ threadId, isSideChat }) => {
      const harness = await createHarness();
      const turnId = asTurnId("turn-agent-stop-after-commentary");
      const now = "2026-01-01T00:00:00.000Z";

      if (isSideChat) {
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.fork",
            commandId: CommandId.make("cmd-agent-stop-race-side-chat-fork"),
            threadId,
            sourceThreadId: ThreadId.make("thread-1"),
            title: "Agent stop race side chat",
            isSideChat: true,
            createdAt: now,
          }),
        );
        await waitFor(() => harness.forkSessionBinding.mock.calls.length === 1);
      }

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.interaction-mode.set",
          commandId: CommandId.make("cmd-agent-stop-race-mode"),
          threadId,
          interactionMode: "agent",
          createdAt: now,
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-agent-stop-race-turn"),
          threadId,
          message: {
            messageId: asMessageId("user-message-agent-stop-race"),
            role: "user",
            text: "Work autonomously until completion.",
            attachments: [],
          },
          interactionMode: "agent",
          runtimeMode: "approval-required",
          createdAt: now,
        }),
      );
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-agent-stop-race-running"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "approval-required",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: "2026-01-01T00:00:01.000Z",
          },
          createdAt: "2026-01-01T00:00:01.000Z",
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make("cmd-agent-stop-race-commentary-delta"),
          threadId,
          messageId: asMessageId("assistant-message-agent-stop-race-commentary"),
          delta: "One verification phase is complete; I am checking the release next.",
          turnId,
          createdAt: "2026-01-01T00:00:02.000Z",
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.make("cmd-agent-stop-race-commentary-complete"),
          threadId,
          messageId: asMessageId("assistant-message-agent-stop-race-commentary"),
          turnId,
          createdAt: "2026-01-01T00:00:03.000Z",
        }),
      );

      // Let the reactor cache the completed commentary while the provider turn
      // remains running. This is the stale candidate that previously escaped
      // after the later terminal response.
      await harness.drain();

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make("cmd-agent-stop-race-final-delta"),
          threadId,
          messageId: asMessageId("assistant-message-agent-stop-race-final"),
          delta: "Everything requested is finished and verified. AGENT_STOP",
          turnId,
          createdAt: "2026-01-01T00:00:04.000Z",
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.make("cmd-agent-stop-race-final-complete"),
          threadId,
          messageId: asMessageId("assistant-message-agent-stop-race-final"),
          turnId,
          createdAt: "2026-01-01T00:00:05.000Z",
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-agent-stop-race-ready"),
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:00:06.000Z",
          },
          createdAt: "2026-01-01T00:00:06.000Z",
        }),
      );

      await harness.drain();
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === threadId);
      expect(thread?.messages.at(-1)).toMatchObject({
        role: "assistant",
        text: "Everything requested is finished and verified. AGENT_STOP",
      });
    },
  );

  it("recovers a stranded completed Agent turn when the server starts", async () => {
    const harness = await createHarness({ startReactor: false });
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-agent-before-restart");
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("cmd-agent-before-restart-mode"),
        threadId,
        interactionMode: "agent",
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-agent-before-restart-turn"),
        threadId,
        message: {
          messageId: asMessageId("user-message-agent-before-restart"),
          role: "user",
          text: "Work autonomously until completion.",
          attachments: [],
        },
        interactionMode: "agent",
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-agent-before-restart-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    const blockedReply =
      "I am blocked on the current directive because the upstream account returned 402. " +
      "I completed the reusable pipeline and inventory, but additional model generation is still " +
      "required before the requested result is finished. No terminal stop signal was emitted.";
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-agent-before-restart-delta"),
        threadId,
        messageId: asMessageId("assistant-message-agent-before-restart"),
        delta: blockedReply,
        turnId,
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-agent-before-restart-complete"),
        threadId,
        messageId: asMessageId("assistant-message-agent-before-restart"),
        turnId,
        createdAt: "2026-01-01T00:00:03.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-agent-before-restart-ready"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:04.000Z",
        },
        createdAt: "2026-01-01T00:00:04.000Z",
      }),
    );

    await waitFor(async () =>
      Option.isSome(
        await Effect.runPromise(
          harness.threadWorkObligations.getByKey({
            threadId,
            sourceTurnId: turnId,
            kind: "agent-continuation",
          }),
        ),
      ),
    );
    expect(harness.sendTurn).not.toHaveBeenCalled();
    await harness.startReactor();
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId,
      input: AGENT_CONTINUE_PROMPT,
    });
  });

  it("marks turns from a side-chat fork for provider isolation guidance", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("cmd-side-chat-fork"),
        threadId: ThreadId.make("thread-side-chat"),
        sourceThreadId: ThreadId.make("thread-1"),
        title: "Thread (side chat)",
        isSideChat: true,
        createdAt: now,
      }),
    );
    await waitFor(() => harness.forkSessionBinding.mock.calls.length === 1);
    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.make("thread-side-chat"),
      );
      return thread?.session?.providerInstanceId === ProviderInstanceId.make("codex");
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-side-chat-turn-start"),
        threadId: ThreadId.make("thread-side-chat"),
        message: {
          messageId: asMessageId("user-message-side-chat"),
          role: "user",
          text: "Investigate this independently.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-side-chat"),
      input: "Investigate this independently.",
      isSideChat: true,
    });
  });

  it("starts cross-provider forks fresh instead of cloning an incompatible session id", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.make("thread-cross-provider-side-chat");
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("cmd-cross-provider-side-chat-fork"),
        threadId,
        sourceThreadId: ThreadId.make("thread-1"),
        title: "Claude side chat",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-fable-5",
        },
        runtimeMode: "approval-required",
        interactionMode: "agent",
        isSideChat: true,
        createdAt: now,
      }),
    );
    await harness.drain();

    expect(harness.forkSessionBinding).not.toHaveBeenCalled();
    const readModel = await harness.readModel();
    expect(readModel.threads.find((thread) => thread.id === threadId)).toMatchObject({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-fable-5",
      },
      runtimeMode: "approval-required",
      interactionMode: "agent",
      isSideChat: true,
      session: null,
    });
  });

  effectIt.effect("projects starting before a slow provider session finishes", () =>
    Effect.gen(function* () {
      const releaseStart = yield* Deferred.make<void>();
      const harness = yield* Effect.promise(() =>
        createHarness({
          startSessionEffect: (session) => Deferred.await(releaseStart).pipe(Effect.as(session)),
        }),
      );
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-slow-provider"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-slow-provider"),
          role: "user",
          text: "start slowly",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* Effect.promise(() => waitFor(() => harness.startSession.mock.calls.length === 1));
      const duringStartup = yield* Effect.promise(() => harness.readModel());
      expect(
        duringStartup.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.session
          ?.status,
      ).toBe("starting");
      expect(harness.sendTurn).not.toHaveBeenCalled();

      yield* Deferred.succeed(releaseStart, undefined);
      yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));
    }),
  );

  effectIt.effect("settles a failed provider startup and allows a clean retry", () =>
    Effect.gen(function* () {
      let failStartup = true;
      const harness = yield* Effect.promise(() =>
        createHarness({
          startSessionEffect: (session) =>
            failStartup
              ? Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: "codex",
                    method: "thread.start",
                    detail: "deterministic startup failure",
                  }),
                )
              : Effect.succeed(session),
        }),
      );
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-failure"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-failure"),
          role: "user",
          text: "fail once",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* Effect.promise(() =>
        waitFor(async () => {
          const readModel = await harness.readModel();
          return (
            readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.session
              ?.status === "error"
          );
        }),
      );
      let readModel = yield* Effect.promise(() => harness.readModel());
      let thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.session?.lastError).toContain("deterministic startup failure");
      expect(harness.sendTurn).not.toHaveBeenCalled();

      failStartup = false;
      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-retry"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-retry"),
          role: "user",
          text: "retry",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      });

      yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));
      readModel = yield* Effect.promise(() => harness.readModel());
      thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.session?.status).toBe("starting");
      expect(thread?.session?.lastError).toBeNull();
    }),
  );

  // A deterministic failure — a broken build, a config that can never load —
  // fails identically on every attempt. Without a ceiling this obligation
  // re-dispatched every 15 seconds forever, flapping the session and stacking
  // error activities. The durable attempt counter must eventually cancel it.
  it("stops retrying a turn start that fails deterministically", async () => {
    const harness = await createHarness({
      startSessionEffect: () =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "thread.start",
            detail: "deterministic startup failure",
          }),
        ),
    });
    const threadId = ThreadId.make("thread-1");
    const messageId = asMessageId("user-message-deterministic-failure");
    const sourceTurnId = activeTurnWorkSourceId(messageId);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-deterministic-failure"),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "fail forever",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const readObligation = () =>
      Effect.runPromise(
        harness.threadWorkObligations
          .getByKey({ threadId, sourceTurnId, kind: "active-turn-recovery" })
          .pipe(Effect.map(Option.getOrUndefined)),
      );

    // Each failure parks the obligation as sleeping(+15s). Flip it straight
    // back to schedulable so the scheduler burns through real attempts without
    // the test waiting out the backoff; the wake mirrors what production does
    // after every transition.
    await waitFor(async () => {
      const work = await readObligation();
      if (work === undefined) return false;
      if (work.state === "cancelled") return true;
      if (work.state === "sleeping") {
        await Effect.runPromise(
          harness.threadWorkObligations
            .transition({
              obligationId: work.obligationId,
              expectedState: "sleeping",
              expectedAttempt: work.attempt,
              state: "pending",
              nextAttemptAt: null,
              claimedAt: null,
              leaseExpiresAt: null,
              blockedReason: null,
              updatedAt: "2026-01-01T00:00:01.000Z",
            })
            .pipe(Effect.andThen(harness.threadWorkScheduler.wake()), Effect.ignore),
        );
      }
      return false;
    }, 30_000);

    const cancelled = await readObligation();
    expect(cancelled?.state).toBe("cancelled");
    expect(cancelled?.blockedReason).toContain("Gave up after");
    expect(cancelled?.blockedReason).toContain("deterministic startup failure");
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  it("retries a structured upstream failure beyond the deterministic cap", async () => {
    const harness = await createHarness({
      startSessionEffect: () =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "thread.start",
            detail: "pxpipe upstream unreachable",
            failureKind: "retryable-upstream",
          }),
        ),
    });
    const threadId = ThreadId.make("thread-1");
    const messageId = asMessageId("user-message-transient-upstream");
    const sourceTurnId = activeTurnWorkSourceId(messageId);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-transient-upstream"),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "survive the outage",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const readObligation = () =>
      Effect.runPromise(
        harness.threadWorkObligations
          .getByKey({ threadId, sourceTurnId, kind: "active-turn-recovery" })
          .pipe(Effect.map(Option.getOrUndefined)),
      );

    await waitFor(async () => {
      const work = await readObligation();
      if (work === undefined) return false;
      if (work.state === "cancelled") {
        throw new Error(`Transient obligation was cancelled: ${work.blockedReason ?? "unknown"}`);
      }
      if (work.state === "sleeping" && work.attempt >= 12) return true;
      if (work.state === "sleeping") {
        const retryDelayMs = Date.parse(work.nextAttemptAt ?? "") - Date.parse(work.updatedAt);
        expect(retryDelayMs).toBeGreaterThanOrEqual(0);
        expect(retryDelayMs).toBeLessThanOrEqual(15_000);
        await Effect.runPromise(
          harness.threadWorkObligations
            .transition({
              obligationId: work.obligationId,
              expectedState: "sleeping",
              expectedAttempt: work.attempt,
              state: "pending",
              nextAttemptAt: null,
              claimedAt: null,
              leaseExpiresAt: null,
              blockedReason: null,
              updatedAt: `2026-01-01T00:00:${String(work.attempt).padStart(2, "0")}.000Z`,
            })
            .pipe(Effect.andThen(harness.threadWorkScheduler.wake()), Effect.ignore),
        );
      }
      return false;
    }, 30_000);

    const sleeping = await readObligation();
    expect(sleeping?.state).toBe("sleeping");
    expect(sleeping?.attempt).toBeGreaterThanOrEqual(12);
    expect(sleeping?.blockedReason).toContain("pxpipe upstream unreachable");
    expect(harness.sendTurn).not.toHaveBeenCalled();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    expect(thread?.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(thread?.messages.filter((message) => message.inputOrigin === "agent-loop")).toHaveLength(
      0,
    );
    expect(
      thread?.activities.filter((activity) => activity.kind === "provider.turn.start.failed"),
    ).toHaveLength(0);

    await Effect.runPromise(
      harness.threadWorkObligations.cancelByThread({
        threadId,
        updatedAt: "2026-01-01T00:01:00.000Z",
        blockedReason: "test cleanup",
        mode: "thread-terminal",
      }),
    );
  });

  // First coverage for the silence watchdog, which had none: it is the last
  // line of defence against a wedged provider and lives in exactly one place,
  // the wait loop, so every code path that returns before entering that loop
  // leaves a live turn completely unsupervised. The fake provider emits
  // nothing once the session is live, freezing the thread shell's fingerprint,
  // and the watchdog must restart the session rather than spin at 10Hz forever
  // holding the thread's only obligation slot. `providerSilenceRestartMs`
  // exists purely so this is reachable without burning the production four
  // minutes of wall clock.
  it("restarts the session when the provider feed goes silent mid-turn", async () => {
    const blockingTurnId = asTurnId("turn-already-running");
    const harness = await createHarness({
      providerSilenceRestartMs: 750,
      startSessionEffect: (session) =>
        Effect.succeed({ ...session, status: "running" as const, activeTurnId: blockingTurnId }),
    });
    const threadId = ThreadId.make("thread-1");
    const messageId = asMessageId("user-message-silent-provider");
    const sourceTurnId = activeTurnWorkSourceId(messageId);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-silent-provider"),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "queued behind a turn that never finishes",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const readObligation = () =>
      Effect.runPromise(
        harness.threadWorkObligations
          .getByKey({ threadId, sourceTurnId, kind: "active-turn-recovery" })
          .pipe(Effect.map(Option.getOrUndefined)),
      );

    await waitFor(async () => {
      const work = await readObligation();
      return work?.state === "sleeping" || work?.state === "cancelled";
    }, 20_000);

    const parked = await readObligation();
    expect(parked?.state).toBe("sleeping");
    expect(parked?.blockedReason).toContain("provider went silent mid-turn");
    expect(harness.stopSession).toHaveBeenCalled();

    await Effect.runPromise(
      harness.threadWorkObligations.cancelByThread({
        threadId,
        updatedAt: "2026-01-01T00:01:00.000Z",
        blockedReason: "test cleanup",
        mode: "thread-terminal",
      }),
    );
  });

  // The boot backfill creates a startup-resume obligation from the settled
  // turn alone — its synthetic message and turn-start are dispatched a moment
  // later by the resume coordinator. Claiming inside that window must not
  // cancel the obligation: the projector treats the incoming turn-start as a
  // replay of the row that already exists, so a cancel there strands the
  // resume with nothing left to drive it. Observed in production 2026-08-05,
  // where a restart's auto-resume died 700ms after being enqueued and the
  // thread sat dead for eight hours.
  it("retries instead of cancelling when the turn-start context is not projected yet", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.make("thread-1");
    const messageId = asMessageId("startup-resume-message-not-yet-projected");
    const sourceTurnId = activeTurnWorkSourceId(messageId);
    const obligationId = `thread-work:active-turn-recovery:${threadId}:${sourceTurnId}`;

    await Effect.runPromise(
      harness.threadWorkObligations.insert({
        obligationId,
        threadId,
        sourceTurnId,
        kind: "active-turn-recovery",
        state: "pending",
        providerInstanceId: ProviderInstanceId.make("codex"),
        attempt: 0,
        nextAttemptAt: null,
        claimedAt: null,
        leaseExpiresAt: null,
        blockedReason: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await Effect.runPromise(harness.threadWorkScheduler.wake());

    const readObligation = () =>
      Effect.runPromise(
        harness.threadWorkObligations
          .getByKey({ threadId, sourceTurnId, kind: "active-turn-recovery" })
          .pipe(Effect.map(Option.getOrUndefined)),
      );

    await waitFor(async () => {
      const work = await readObligation();
      return work !== undefined && (work.state === "sleeping" || work.state === "cancelled");
    }, 15_000);

    const parked = await readObligation();
    expect(parked?.state).toBe("sleeping");
    expect(parked?.blockedReason).toContain("turn-start context has not been projected yet");
    expect(harness.sendTurn).not.toHaveBeenCalled();

    await Effect.runPromise(
      harness.threadWorkObligations.cancelByThread({
        threadId,
        updatedAt: "2026-01-01T00:01:00.000Z",
        blockedReason: "test cleanup",
        mode: "thread-terminal",
      }),
    );
  });

  // A real CLI spawn leaves the session "connecting" for ~10 seconds after the
  // turn is dispatched. Retiring the obligation as completed in that window
  // abandons the turn that is about to start: nothing supervises it, so the
  // silence watchdog never runs and a hung upstream request spins the UI
  // forever with no error and no retry. Observed in production 2026-08-05,
  // where an auto-resume turn sat silent for five minutes and then died with
  // "Request timed out" that never reached the user.
  it("keeps supervising a turn dispatched while the session is still connecting", async () => {
    const harness = await createHarness({
      startSessionEffect: (session) =>
        Effect.succeed({ ...session, status: "connecting" as const }),
    });
    const threadId = ThreadId.make("thread-1");
    const messageId = asMessageId("user-message-connecting-session");
    const sourceTurnId = activeTurnWorkSourceId(messageId);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-connecting"),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "resume while the provider is still spawning",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const readObligation = () =>
      Effect.runPromise(
        harness.threadWorkObligations
          .getByKey({ threadId, sourceTurnId, kind: "active-turn-recovery" })
          .pipe(Effect.map(Option.getOrUndefined)),
      );

    // The turn is genuinely dispatched...
    await waitFor(async () => harness.sendTurn.mock.calls.length > 0, 10_000);

    // ...and the obligation stays live rather than retiring. Before the fix it
    // flipped to "completed" as soon as the post-send status read came back
    // anything other than "running".
    await waitFor(async () => {
      const work = await readObligation();
      return work !== undefined && (work.state === "claimed" || work.state === "executing");
    }, 10_000);

    const supervising = await readObligation();
    expect(supervising?.state).not.toBe("completed");
    expect(supervising?.state).not.toBe("cancelled");

    await Effect.runPromise(
      harness.threadWorkObligations.cancelByThread({
        threadId,
        updatedAt: "2026-01-01T00:01:00.000Z",
        blockedReason: "test cleanup",
        mode: "thread-terminal",
      }),
    );
  });

  // Full-flow regression for the mid-turn send ("steer") pipeline: a steer is
  // injected into the live turn immediately when the provider accepts it, the
  // parked delivery resolves without double-sending, a steer the provider
  // rejects stays parked and delivers at turn end, and the user's Stop never
  // drops a parked message.
  it("injects steers into a running turn and parks them when the provider refuses", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.make("thread-1");
    const codex = ProviderInstanceId.make("codex");
    const refuseSteerFor = new Set<string>();
    let startedTurns = 0;
    harness.sendTurn.mockImplementation(
      (rawInput: unknown): Effect.Effect<{ threadId: ThreadId; turnId: TurnId }, never> =>
        Effect.suspend(() => {
          const request = rawInput as { readonly messageId?: string };
          const index = harness.runtimeSessions.findIndex(
            (session) => session.threadId === threadId,
          );
          const live = index >= 0 ? harness.runtimeSessions[index] : undefined;
          const liveTurnId = live?.activeTurnId ?? undefined;
          if (live?.status === "running" && liveTurnId !== undefined) {
            // Mid-turn send = steer attempt against the live turn.
            if (request.messageId !== undefined && refuseSteerFor.has(request.messageId)) {
              return Effect.die(
                new ProviderAdapterRequestError({
                  provider: "codex",
                  method: "turn/steer",
                  detail: "steer refused in test",
                }),
              );
            }
            return Effect.succeed({ threadId, turnId: liveTurnId });
          }
          startedTurns += 1;
          const turnId = asTurnId(`turn-live-${startedTurns}`);
          if (index >= 0 && live !== undefined) {
            harness.runtimeSessions[index] = { ...live, status: "running", activeTurnId: turnId };
          }
          return Effect.succeed({ threadId, turnId });
        }),
    );
    const providerIdle = () => {
      const index = harness.runtimeSessions.findIndex((session) => session.threadId === threadId);
      if (index >= 0) {
        const existing = harness.runtimeSessions[index];
        if (existing !== undefined) {
          harness.runtimeSessions[index] = {
            ...existing,
            status: "ready",
            activeTurnId: undefined,
          };
        }
      }
    };
    const dispatchTurn = (commandId: string, messageId: string, text: string, createdAt: string) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(commandId),
          threadId,
          message: { messageId: asMessageId(messageId), role: "user", text, attachments: [] },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        }),
      );
    const setSession = (
      commandId: string,
      status: "running" | "ready",
      activeTurnId: TurnId | null,
      updatedAt: string,
    ) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(commandId),
          threadId,
          session: {
            threadId,
            status,
            providerName: "codex",
            providerInstanceId: codex,
            runtimeMode: "approval-required",
            activeTurnId,
            lastError: null,
            updatedAt,
          },
          createdAt: updatedAt,
        }),
      );
    const obligationState = async (messageId: string) => {
      const row = await Effect.runPromise(
        harness.threadWorkObligations.getByKey({
          threadId,
          sourceTurnId: activeTurnWorkSourceId(asMessageId(messageId)),
          kind: "active-turn-recovery",
        }),
      );
      return Option.getOrUndefined(row)?.state;
    };
    const deliveredMessageIds = () =>
      harness.sendTurn.mock.calls.map(
        (call) => (call[0] as { readonly messageId?: string }).messageId,
      );

    // Message 1 starts a turn; its delivery obligation becomes the supervisor.
    await dispatchTurn(
      "cmd-steer-msg1",
      "steer-msg-1",
      "start working",
      "2026-01-01T00:00:01.000Z",
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await setSession(
      "cmd-steer-running-1",
      "running",
      asTurnId("turn-live-1"),
      "2026-01-01T00:00:02.000Z",
    );
    await waitFor(async () => (await obligationState("steer-msg-1")) === "executing");

    // Message 2 mid-turn: the provider accepts the steer, so it reaches the
    // agent immediately and its parked delivery resolves as completed.
    await dispatchTurn("cmd-steer-msg2", "steer-msg-2", "steer me", "2026-01-01T00:00:03.000Z");
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(deliveredMessageIds()[1]).toBe("steer-msg-2");
    await waitFor(async () => (await obligationState("steer-msg-2")) === "completed");
    expect(await obligationState("steer-msg-1")).toBe("executing");

    // Message 3 mid-turn: the provider refuses the steer (turn boundary race,
    // old binary). The message parks and must not dispatch while the turn runs.
    refuseSteerFor.add("steer-msg-3");
    await dispatchTurn("cmd-steer-msg3", "steer-msg-3", "park me", "2026-01-01T00:00:04.000Z");
    await waitFor(() => harness.sendTurn.mock.calls.length === 3); // the refused steer attempt
    expect(await obligationState("steer-msg-3")).toBe("pending");
    expect(await obligationState("steer-msg-1")).toBe("executing");

    // Turn 1 completes: the parked message delivers as its own turn.
    providerIdle();
    await setSession("cmd-steer-idle-1", "ready", null, "2026-01-01T00:00:05.000Z");
    await waitFor(
      () => harness.sendTurn.mock.calls.length === 4 && deliveredMessageIds()[3] === "steer-msg-3",
    );
    await setSession(
      "cmd-steer-running-2",
      "running",
      asTurnId("turn-live-2"),
      "2026-01-01T00:00:06.000Z",
    );
    await waitFor(async () => (await obligationState("steer-msg-3")) === "executing");

    // Message 4 mid-turn 2 with a refused steer, then the user presses Stop:
    // the parked message survives the interrupt sweep and delivers once the
    // provider reports the turn gone.
    refuseSteerFor.add("steer-msg-4");
    await dispatchTurn("cmd-steer-msg4", "steer-msg-4", "after stop", "2026-01-01T00:00:07.000Z");
    await waitFor(() => harness.sendTurn.mock.calls.length === 5); // refused steer attempt
    expect(await obligationState("steer-msg-4")).toBe("pending");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-steer-interrupt"),
        threadId,
        turnId: asTurnId("turn-live-2"),
        createdAt: "2026-01-01T00:00:08.000Z",
      }),
    );
    expect(await obligationState("steer-msg-4")).toBe("pending");
    providerIdle();
    await setSession("cmd-steer-idle-2", "ready", null, "2026-01-01T00:00:09.000Z");
    await waitFor(() => deliveredMessageIds().includes("steer-msg-4"));
    // The steered message was consumed by the live turn — it must not be
    // re-delivered as its own turn afterwards.
    expect(deliveredMessageIds().filter((messageId) => messageId === "steer-msg-2")).toHaveLength(
      1,
    );
  });

  it("generates a thread title on the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Please investigate reconnect failures after restar...";
    harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "Generated title" }));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-seed"),
        threadId: ThreadId.make("thread-1"),
        title: seededTitle,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title"),
          role: "user",
          text: "Please investigate reconnect failures after restarting the session.",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
      message: "Please investigate reconnect failures after restarting the session.",
    });

    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.title ===
        "Generated title"
      );
    });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Generated title");
  });

  it("does not overwrite an existing custom thread title on the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Please investigate reconnect failures after restar...";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-custom"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep this custom title",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title-preserve"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-preserve"),
          role: "user",
          text: "Please investigate reconnect failures after restarting the session.",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep this custom title");
  });

  it("matches the client-seeded title even when the outgoing prompt is reformatted", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Fix reconnect spinner on resume";
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({
        title: "Reconnect spinner resume bug",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-formatted-seed"),
        threadId: ThreadId.make("thread-1"),
        title: seededTitle,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title-formatted"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-formatted"),
          role: "user",
          text: "[effort:high]\\n\\nFix reconnect spinner on resume",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.title ===
        "Reconnect spinner resume bug"
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Reconnect spinner resume bug");
  });

  it("generates a worktree branch name for the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-branch"),
        threadId: ThreadId.make("thread-1"),
        branch: "t3code/1234abcd",
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );

    harness.generateBranchName.mockImplementation((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "modelSelection" in input &&
          typeof input.modelSelection === "object" &&
          input.modelSelection !== null &&
          "model" in input.modelSelection &&
          typeof input.modelSelection.model === "string"
            ? `feature/${input.modelSelection.model}`
            : "feature/generated",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-branch-model"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-branch-model"),
          role: "user",
          text: "Add a safer reconnect backoff.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateBranchName.mock.calls.length === 1);
    await waitFor(() => harness.refreshStatus.mock.calls.length === 1);
    expect(harness.generateBranchName.mock.calls[0]?.[0]).toMatchObject({
      message: "Add a safer reconnect backoff.",
    });
    expect(harness.refreshStatus.mock.calls[0]?.[0]).toBe("/tmp/provider-project-worktree");
  });

  it("forwards codex model options through session start and turn send", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-fast"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-fast"),
          role: "user",
          text: "hello fast mode",
          attachments: [],
        },
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ]),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    });
  });

  it("forwards claude effort options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort"),
          role: "user",
          text: "hello with effort",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "max" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
  });

  it("forwards claude fast mode options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-fast-mode"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-fast-mode"),
          role: "user",
          text: "hello with fast mode",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "fastMode", value: true }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-opus-4-6",
        [{ id: "fastMode", value: true }],
      ),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-opus-4-6",
        [{ id: "fastMode", value: true }],
      ),
    });
  });

  it("forwards plan interaction mode to the provider turn request", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("cmd-interaction-mode-set-plan"),
        threadId: ThreadId.make("thread-1"),
        interactionMode: "plan",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-plan"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-plan"),
          role: "user",
          text: "plan this change",
          attachments: [],
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      interactionMode: "plan",
    });
  });

  it("preserves the active session model when in-session model switching is unsupported", async () => {
    const harness = await createHarness({ sessionModelSwitch: "unsupported" });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unsupported-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unsupported-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unsupported-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unsupported-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
    });
  });

  effectIt.effect(
    "rejects changing models after start when the provider requires a new thread",
    () =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() =>
          createHarness({ requiresNewThreadForModelChange: true }),
        );
        const now = "2026-01-01T00:00:00.000Z";

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-restricted-1"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-restricted-1"),
            role: "user",
            text: "first",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });

        yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-restricted-2"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-restricted-2"),
            role: "user",
            text: "second",
            attachments: [],
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.1-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });

        yield* Effect.promise(() =>
          waitFor(async () => {
            const readModel = await harness.readModel();
            const thread = readModel.threads.find(
              (entry) => entry.id === ThreadId.make("thread-1"),
            );
            return (
              thread?.activities.some(
                (activity) => activity.kind === "provider.turn.start.failed",
              ) ?? false
            );
          }),
        );

        expect(harness.sendTurn).toHaveBeenCalledTimes(1);
        const readModel = yield* Effect.promise(() => harness.readModel());
        const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
        expect(
          thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
        ).toMatchObject({
          payload: {
            detail: expect.stringContaining(
              "cannot switch models after the conversation has started",
            ),
          },
        });
      }),
  );

  it("starts a first turn on the requested provider instance even when it differs from the thread model", async () => {
    const harness = await createHarness({
      threadModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-first"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-first"),
          role: "user",
          text: "hello claude",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.providerName).toBe("claudeAgent");
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("claudeAgent"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toBeUndefined();
  });

  it("reuses the same provider session when runtime mode is unchanged", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unchanged-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unchanged-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);
  });

  it("restarts an existing Codex thread on a compatible requested instance without reusing its cursor", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-compatible-codex-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-compatible-codex-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-compatible-codex-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-compatible-codex-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex_work"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.startSession).toHaveBeenCalledTimes(2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex_work"),
    });
    expect(harness.startSession.mock.calls[1]?.[1]).not.toHaveProperty("resumeCursor");
    const handoff = JSON.parse(
      (harness.sendTurn.mock.calls[1]?.[0] as { input?: string } | undefined)?.input ?? "{}",
    ) as {
      kind?: string;
      context?: { handoff?: { reason?: string } };
      currentRequest?: string;
    };
    expect(handoff).toMatchObject({
      kind: "t3.provider-handoff-turn",
      context: { handoff: { reason: "manual_provider_switch" } },
      currentRequest: "second",
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("codex_work"));
  });

  it("restarts the provider session when the thread workspace changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-workspace-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-workspace-1"),
          role: "user",
          text: "first in project root",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-worktree-change"),
        threadId: ThreadId.make("thread-1"),
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-workspace-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-workspace-2"),
          role: "user",
          text: "second in worktree",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      cwd: "/tmp/provider-project-worktree",
      resumeCursor: { opaque: "resume-1" },
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
      runtimeMode: "approval-required",
    });
  });

  it("restarts claude sessions when claude effort changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort-1"),
          role: "user",
          text: "first claude turn",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "medium" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort-2"),
          role: "user",
          text: "second claude turn",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "max" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      resumeCursor: { opaque: "resume-1" },
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
  });

  it("restarts claude after metadata advances before a fast-mode settings turn", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";
    const fastSelection = createModelSelection(
      ProviderInstanceId.make("claudeAgent"),
      "claude-opus-4-6",
      [{ id: "fastMode", value: true }],
    );
    const normalSelection = createModelSelection(
      ProviderInstanceId.make("claudeAgent"),
      "claude-opus-4-6",
      [{ id: "fastMode", value: false }],
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-fast-on"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-fast-on"),
          role: "user",
          text: "first fast turn",
          attachments: [],
        },
        modelSelection: fastSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    // The UI persists the desired metadata before it starts the settings turn.
    // That projection must not be mistaken for the live SDK session state.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-fast-off-metadata"),
        threadId: ThreadId.make("thread-1"),
        modelSelection: normalSelection,
      }),
    );
    await waitFor(async () => {
      const readModel = await harness.readModel();
      return Equal.equals(
        readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.modelSelection,
        normalSelection,
      );
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-fast-off"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-fast-off"),
          role: "user",
          text: "Settings updated: normal speed. Apply these settings immediately.",
          attachments: [],
        },
        modelSelection: normalSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      resumeCursor: { opaque: "resume-1" },
      modelSelection: normalSelection,
    });
  });

  it("restarts the provider session when runtime mode is updated on the thread", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-initial-full-access"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-runtime-mode-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-1"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-runtime-mode-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      resumeCursor: { opaque: "resume-1" },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  it("does not inject derived model options when restarting claude on runtime mode changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-runtime-mode-claude"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-claude-no-options"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
      runtimeMode: "approval-required",
    });
  });

  it("does not stop the active session when restart fails before rebind", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-initial-full-access-2"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-restart-failure-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-restart-failure-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    harness.startSession.mockImplementationOnce(
      (_: unknown, __: unknown) => Effect.fail("simulated restart failure") as never,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-restart-failure"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await harness.drain();

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(1);

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("full-access");
  });

  it("continues a bound thread on another provider with a JSON handoff", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-switch-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-switch-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-running-before-provider-switch"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-provider-switch-source"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-switch-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-switch-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.interruptTurn).toHaveBeenCalledWith({
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-provider-switch-source"),
    });
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    });
    expect(harness.startSession.mock.calls[1]?.[1]).not.toHaveProperty("resumeCursor");
    const handoff = JSON.parse(
      (harness.sendTurn.mock.calls[1]?.[0] as { input?: string } | undefined)?.input ?? "{}",
    ) as {
      kind?: string;
      context?: { handoff?: { reason?: string } };
      currentRequest?: string;
    };
    expect(handoff).toMatchObject({
      kind: "t3.provider-handoff-turn",
      context: { handoff: { reason: "manual_provider_switch" } },
      currentRequest: "second",
    });

    await harness.drain();
    await waitFor(async () => {
      const projected = (await harness.readModel()).threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );
      return (
        projected?.activities.some((activity) => activity.kind === "provider.handoff.completed") ??
        false
      );
    });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.providerName).toBe("claudeAgent");
    expect(thread?.session?.providerInstanceId).toBe("claudeAgent");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.handoff.completed"),
    ).toMatchObject({
      summary: "Switched from codex to claudeAgent",
      payload: expect.objectContaining({
        targetModel: "claude-opus-4-6",
        immediateRequirement: "second",
      }),
    });
  });

  it("continues a stopped projected thread on another provider with a JSON handoff", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-stopped-provider-switch"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "stopped",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-meta-update-stopped-provider-switch"),
        threadId: ThreadId.make("thread-1"),
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-stopped-provider-switch"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-stopped-provider-switch"),
          role: "user",
          text: "continue with claude",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    });
    expect(harness.startSession.mock.calls[0]?.[1]).not.toHaveProperty("resumeCursor");
    const handoff = JSON.parse(
      (harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined)?.input ?? "{}",
    ) as {
      kind?: string;
      context?: { handoff?: { reason?: string } };
      currentRequest?: string;
    };
    expect(handoff).toMatchObject({
      kind: "t3.provider-handoff-turn",
      context: { handoff: { reason: "manual_provider_switch" } },
      currentRequest: "continue with claude",
    });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.providerName).toBe("claudeAgent");
    expect(thread?.session?.providerInstanceId).toBe("claudeAgent");
  });

  it("reacts to thread.turn.interrupt-requested by calling provider interrupt", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.runtimeSessions.push({
      threadId: ThreadId.make("thread-1"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      activeTurnId: asTurnId("provider-turn-1"),
      createdAt: now,
      updatedAt: now,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-turn-interrupt"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
    });
    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    expect(harness.stopSession.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
    });
    expect(harness.runtimeSessions).toHaveLength(0);
    await harness.drain();
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session).toMatchObject({
      status: "stopped",
      activeTurnId: null,
    });
  });

  it("starts a fresh session when only projected session state exists", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-stale"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-stale"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-stale"),
          role: "user",
          text: "resume codex",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
    });
  });

  it("rejects active runtime sessions that are missing provider instance ids", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-missing-instance"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    harness.runtimeSessions.push({
      provider: ProviderDriverKind.make("codex"),
      status: "ready",
      runtimeMode: "approval-required",
      threadId: ThreadId.make("thread-1"),
      cwd: "/tmp/provider-project",
      resumeCursor: { opaque: "resume-without-instance" },
      createdAt: now,
      updatedAt: now,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-missing-instance"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-missing-instance"),
          role: "user",
          text: "resume codex",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(0);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("without a provider instance id"),
      },
    });
  });

  it("reacts to thread.approval.respond by forwarding provider approval response", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-approval"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.make("cmd-approval-respond"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        decision: "accept",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToRequest.mock.calls.length === 1);
    expect(harness.respondToRequest.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "approval-request-1",
      decision: "accept",
    });
  });

  it("reacts to thread.user-input.respond by forwarding structured user input answers", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-user-input"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.make("cmd-user-input-respond"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("user-input-request-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToUserInput.mock.calls.length === 1);
    expect(harness.respondToUserInput.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "user-input-request-1",
      answers: {
        sandbox_mode: "workspace-write",
      },
    });
  });

  it("surfaces stale provider approval request failures without faking approval resolution", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.respondToRequest.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("codex"),
          method: "session/request_permission",
          detail: "Unknown pending permission request: approval-request-1",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-approval-error"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-approval-requested"),
        threadId: ThreadId.make("thread-1"),
        activity: {
          id: EventId.make("activity-approval-requested"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Command approval requested",
          payload: {
            requestId: "approval-request-1",
            requestKind: "command",
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.make("cmd-approval-respond-stale"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        decision: "acceptForSession",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      if (!thread) return false;
      return thread.activities.some(
        (activity) => activity.kind === "provider.approval.respond.failed",
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread).toBeDefined();

    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.approval.respond.failed",
    );
    expect(failureActivity).toBeDefined();
    expect(failureActivity?.payload).toMatchObject({
      requestId: "approval-request-1",
      detail: expect.stringContaining("Stale pending approval request: approval-request-1"),
    });

    const resolvedActivity = thread?.activities.find(
      (activity) =>
        activity.kind === "approval.resolved" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === "approval-request-1",
    );
    expect(resolvedActivity).toBeUndefined();
  });

  it("surfaces non-resumable provider user-input callbacks as stale failures", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.respondToUserInput.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("claudeAgent"),
          method: "item/tool/respondToUserInput",
          detail: "Unknown pending Codex user input request: user-input-request-1",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-user-input-error"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-user-input-requested"),
        threadId: ThreadId.make("thread-1"),
        activity: {
          id: EventId.make("activity-user-input-requested"),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            requestId: "user-input-request-1",
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
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.make("cmd-user-input-respond-stale"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("user-input-request-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      if (!thread) return false;
      return thread.activities.some(
        (activity) => activity.kind === "provider.user-input.respond.failed",
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread).toBeDefined();

    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.user-input.respond.failed",
    );
    expect(failureActivity).toBeDefined();
    expect(failureActivity?.payload).toMatchObject({
      requestId: "user-input-request-1",
      detail: expect.stringContaining("Stale pending user-input request: user-input-request-1"),
    });

    const resolvedActivity = thread?.activities.find(
      (activity) =>
        activity.kind === "user-input.resolved" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === "user-input-request-1",
    );
    expect(resolvedActivity).toBeUndefined();
  });

  it("reacts to thread.session.stop by stopping provider session and clearing thread session state", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    // eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- This legacy async harness exposes the dispatch Effect directly.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-stop"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex_work"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    // eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- This legacy async harness exposes the dispatch Effect directly.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("cmd-session-stop"),
        threadId: ThreadId.make("thread-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session).not.toBeNull();
    expect(thread?.session?.status).toBe("stopped");
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("codex_work"));
    expect(thread?.session?.activeTurnId).toBeNull();
  });
});
