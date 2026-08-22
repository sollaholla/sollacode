import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type IsoDateTime,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type RuntimeMode,
  type ServerProvider,
  VmAgentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { VmAgentCollaborationStore } from "../../../persistence/Services/VmAgentCollaborations.ts";
import { VmAgentStore } from "../../../persistence/Services/VmAgents.ts";
import * as ThreadHistoryQuery from "../history/ThreadHistoryQuery.ts";

const createdAt = "2026-08-03T12:00:00.000Z" as IsoDateTime;
const projectId = ProjectId.make("project-collaboration-test");
const mainThreadId = ThreadId.make("thread-main");
const sideThreadId = ThreadId.make("thread-side");
const siblingThreadId = ThreadId.make("thread-sibling");
const unrelatedThreadId = ThreadId.make("thread-unrelated");
const codexInstanceId = ProviderInstanceId.make("codex");
const claudeInstanceId = ProviderInstanceId.make("claudeAgent");

const makeThread = (
  id: ThreadId,
  title: string,
  options: {
    readonly isSideChat?: boolean;
    readonly parentThreadId?: ThreadId | null;
    readonly runtimeMode?: RuntimeMode;
    readonly interactionMode?: "default" | "plan" | "agent";
  } = {},
): OrchestrationThreadShell => ({
  id,
  projectId,
  title,
  isSideChat: options.isSideChat ?? false,
  sideChatParentThreadId: options.parentThreadId ?? null,
  modelSelection: { instanceId: codexInstanceId, model: "gpt-5.6-sol" },
  runtimeMode: options.runtimeMode ?? "full-access",
  interactionMode: options.interactionMode ?? "default",
  branch: "main",
  worktreePath: null,
  latestTurn: null,
  createdAt,
  updatedAt: createdAt,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

const provider: ServerProvider = {
  instanceId: codexInstanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: createdAt,
  availability: "available",
  models: [
    {
      slug: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      isCustom: false,
      capabilities: null,
    },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
};

const claudeProvider: ServerProvider = {
  ...provider,
  instanceId: claudeInstanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  models: [
    {
      slug: "claude-fable-5",
      name: "Claude Fable 5",
      isCustom: false,
      capabilities: null,
    },
  ],
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  initializePayload: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "collaboration-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const invocationFor = (
  threadId: ThreadId,
  capabilities = new Set<McpInvocationContext.McpCapability>(["collaboration"]),
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-collaboration-test"),
  threadId,
  providerSessionId: `provider-session-${threadId}`,
  providerInstanceId: codexInstanceId,
  capabilities,
  issuedAt: 1,
});

const makeHarness = (
  initialThreads: ReadonlyArray<OrchestrationThreadShell> = [
    makeThread(mainThreadId, "Main"),
    makeThread(sideThreadId, "Side", { isSideChat: true, parentThreadId: mainThreadId }),
    makeThread(siblingThreadId, "Sibling", {
      isSideChat: true,
      parentThreadId: mainThreadId,
    }),
    makeThread(unrelatedThreadId, "Unrelated"),
  ],
  options: {
    readonly lagCreatedSideChatProjection?: boolean;
    readonly delegatedThreadIds?: ReadonlySet<ThreadId>;
    readonly vmAgentThreadIds?: ReadonlySet<ThreadId>;
  } = {},
) => {
  let threads = [...initialThreads];
  let laggingCreatedSideChat: OrchestrationThreadShell | undefined;
  const commands: Array<OrchestrationCommand> = [];
  const queriedThreadIds: Array<ThreadId> = [];
  let sequence = 0;

  const replaceThread = (
    threadId: ThreadId,
    update: (thread: OrchestrationThreadShell) => OrchestrationThreadShell,
  ) => {
    threads = threads.map((thread) => (thread.id === threadId ? update(thread) : thread));
  };

  const dispatch = (command: OrchestrationCommand) =>
    Effect.sync(() => {
      commands.push(command);
      sequence += 1;
      switch (command.type) {
        case "thread.fork": {
          const source = threads.find((thread) => thread.id === command.sourceThreadId)!;
          const createdThread: OrchestrationThreadShell = {
            ...source,
            id: command.threadId,
            title: command.title ?? `${source.title} (fork)`,
            modelSelection: command.modelSelection ?? source.modelSelection,
            runtimeMode: command.runtimeMode ?? source.runtimeMode,
            interactionMode: command.interactionMode ?? source.interactionMode,
            isSideChat: command.isSideChat === true,
            sideChatParentThreadId:
              command.isSideChat === true ? (command.sideChatParentThreadId ?? source.id) : null,
            latestTurn: null,
            session: null,
            latestUserMessageAt: null,
            createdAt: command.createdAt,
            updatedAt: command.createdAt,
          };
          threads.push(createdThread);
          if (options.lagCreatedSideChatProjection === true && command.isSideChat === true) {
            laggingCreatedSideChat = createdThread;
          }
          break;
        }
        case "thread.meta.update":
          replaceThread(command.threadId, (thread) => ({
            ...thread,
            ...(command.modelSelection ? { modelSelection: command.modelSelection } : {}),
          }));
          break;
        case "thread.runtime-mode.set":
          replaceThread(command.threadId, (thread) => ({
            ...thread,
            runtimeMode: command.runtimeMode,
          }));
          break;
        case "thread.interaction-mode.set":
          replaceThread(command.threadId, (thread) => ({
            ...thread,
            interactionMode: command.interactionMode,
          }));
          break;
        case "thread.turn.start":
          replaceThread(command.threadId, (thread) => ({
            ...thread,
            latestTurn: {
              turnId: TurnId.make(`turn-${sequence}`),
              state: "running",
              requestedAt: command.createdAt,
              startedAt: null,
              completedAt: null,
              assistantMessageId: null,
            },
            latestUserMessageAt: command.createdAt,
          }));
          break;
        default:
          break;
      }
      return { sequence };
    });

  const projectionLayer = Layer.mock(ProjectionSnapshotQuery)({
    getShellSnapshot: () =>
      Effect.sync(() => ({
        snapshotSequence: sequence,
        projects: [],
        threads,
        updatedAt: createdAt,
      })),
    getThreadShellById: (threadId) =>
      Effect.sync(() =>
        Option.fromNullishOr(
          laggingCreatedSideChat?.id === threadId
            ? laggingCreatedSideChat
            : threads.find((thread) => thread.id === threadId),
        ),
      ),
  });
  const engineLayer = Layer.mock(OrchestrationEngineService)({
    dispatch,
    readEvents: () => Stream.empty,
    streamDomainEvents: Stream.empty,
    latestSequence: Effect.sync(() => sequence),
  });
  const providerLayer = Layer.mock(ProviderRegistry)({
    getProviders: Effect.succeed([provider, claudeProvider]),
  });
  const historyLayer = Layer.succeed(ThreadHistoryQuery.ThreadHistoryQuery, {
    query: (request) =>
      Effect.sync(() => {
        queriedThreadIds.push(request.threadId);
        const thread = threads.find((entry) => entry.id === request.threadId)!;
        return {
          thread: {
            threadId: thread.id,
            title: thread.title,
            modelSelection: thread.modelSelection,
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            updatedAt: thread.updatedAt,
            session: null,
          },
          resolvedThreadIdFromInvocation: request.resolvedThreadIdFromInvocation,
          entries: [],
          resumeContext: {
            latestUserMessage: null,
            latestAssistantMessage: null,
            latestActivity: null,
            activeTurn: null,
          },
          pagination: {
            pageSize: request.pageSize ?? 40,
            returned: 0,
            scanned: 0,
            hasMore: false,
            nextCursor: null,
            scanLimitReached: false,
          },
          query: {
            text: request.query ?? null,
            matchMode: request.matchMode ?? "literal",
            regexFlags: request.matchMode === "regex" ? (request.regexFlags ?? "i") : null,
            sources: request.sources ?? ["messages", "activities"],
            roles: request.roles ?? [],
            activityKinds: request.activityKinds ?? [],
            turnIds: request.turnIds ?? [],
            since: request.since ?? null,
            until: request.until ?? null,
            order: request.order ?? "desc",
          },
        };
      }),
  });
  const agentCollaborationLayer = Layer.mock(VmAgentCollaborationStore)({
    hasActiveTargetThread: (threadId) =>
      Effect.succeed(options.delegatedThreadIds?.has(ThreadId.make(threadId)) === true),
  });
  const vmAgentLayer = Layer.mock(VmAgentStore)({
    getByThreadId: (threadId) =>
      Effect.succeed(
        options.vmAgentThreadIds?.has(ThreadId.make(threadId)) === true
          ? Option.some({ vmAgentId: VmAgentId.make(`agent:${threadId}`) } as never)
          : Option.none(),
      ),
  });

  const layer = McpHttpServer.ThreadCollaborationToolkitRegistration.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(projectionLayer),
    Layer.provide(engineLayer),
    Layer.provide(providerLayer),
    Layer.provide(historyLayer),
    Layer.provide(agentCollaborationLayer),
    Layer.provide(vmAgentLayer),
    Layer.provide(NodeServices.layer),
  );
  return { layer, commands, queriedThreadIds, readThreads: () => threads };
};

const callTool = (
  arguments_: Record<string, unknown>,
  invocation: McpInvocationContext.McpInvocationScope,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name: "thread_collaboration", arguments: arguments_ })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it.effect("registers one non-destructive thread collaboration MCP tool", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const tool = server.tools.find(({ tool }) => tool.name === "thread_collaboration");
    expect(tool?.tool.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(tool?.tool._meta).toMatchObject({ "anthropic/alwaysLoad": true });
    expect(tool?.tool.inputSchema).toMatchObject({ type: "object" });
  }).pipe(Effect.provide(harness.layer));
});

it.effect("changes only the credential-bound chat model without sending a message", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const result = yield* callTool(
      {
        action: "set_model",
        modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
      },
      invocationFor(sideThreadId),
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      action: "set_model",
      threadId: sideThreadId,
      modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
      effectiveOn: "next_turn",
    });
    expect(harness.commands).toHaveLength(1);
    expect(harness.commands[0]).toMatchObject({
      type: "thread.meta.update",
      threadId: sideThreadId,
    });
  }).pipe(Effect.provide(harness.layer));
});

it.effect(
  "applies access and interaction modes instead of discarding set_model wire fields",
  () => {
    const harness = makeHarness([
      makeThread(sideThreadId, "Side", {
        isSideChat: true,
        parentThreadId: mainThreadId,
        runtimeMode: "full-access",
        interactionMode: "agent",
      }),
    ]);
    return Effect.gen(function* () {
      const result = yield* callTool(
        {
          action: "set_model",
          modelSelection: { instanceId: codexInstanceId, model: "gpt-5.6-sol" },
          runtimeMode: "approval-required",
          interactionMode: "default",
        },
        invocationFor(sideThreadId),
      );
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        action: "set_model",
        threadId: sideThreadId,
        previousRuntimeMode: "full-access",
        runtimeMode: "approval-required",
        previousInteractionMode: "agent",
        interactionMode: "default",
      });
      expect(harness.commands).toHaveLength(2);
      expect(harness.commands[0]).toMatchObject({
        type: "thread.runtime-mode.set",
        threadId: sideThreadId,
        runtimeMode: "approval-required",
      });
      expect(harness.commands[1]).toMatchObject({
        type: "thread.interaction-mode.set",
        threadId: sideThreadId,
        interactionMode: "default",
      });
      expect(harness.readThreads()[0]).toMatchObject({
        runtimeMode: "approval-required",
        interactionMode: "default",
      });
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("creates and starts an Agent side task while leaving the source active", () => {
  const source = {
    ...makeThread(mainThreadId, "Main"),
    latestTurn: {
      turnId: TurnId.make("turn-main-running"),
      state: "running" as const,
      requestedAt: createdAt,
      startedAt: createdAt,
      completedAt: null,
      assistantMessageId: null,
    },
  };
  const harness = makeHarness([source], { lagCreatedSideChatProjection: true });
  return Effect.gen(function* () {
    const result = yield* callTool(
      { action: "create_side_chat", title: "Investigate renderer", task: "Trace the jank." },
      invocationFor(mainThreadId),
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      action: "create_side_chat",
      sourceThreadId: mainThreadId,
      sideChat: {
        title: "Investigate renderer",
        relationship: "child",
        isSideChat: true,
        parentThreadId: mainThreadId,
        interactionMode: "agent",
        isWorking: true,
      },
      taskSubmitted: true,
    });
    expect(harness.commands.map((command) => command.type)).toEqual([
      "thread.fork",
      "thread.turn.start",
    ]);
    expect(harness.commands[0]).toMatchObject({
      type: "thread.fork",
      sourceThreadId: mainThreadId,
      sideChatParentThreadId: mainThreadId,
      modelSelection: { instanceId: codexInstanceId, model: "gpt-5.6-sol" },
      runtimeMode: "full-access",
      interactionMode: "agent",
    });
    expect(harness.commands[1]).toMatchObject({
      type: "thread.turn.start",
      message: { text: "Trace the jank.", attachments: [] },
      interactionMode: "agent",
      runtimeMode: "full-access",
      modelSelection: { instanceId: codexInstanceId, model: "gpt-5.6-sol" },
    });
    expect(
      harness.readThreads().find((thread) => thread.id === mainThreadId)?.latestTurn?.state,
    ).toBe("running");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("blocks the legacy side-chat bypass for a delegated worker", () => {
  const harness = makeHarness(undefined, {
    delegatedThreadIds: new Set([sideThreadId]),
  });
  return Effect.gen(function* () {
    const result = yield* callTool(
      { action: "create_side_chat", title: "Nested", task: "Create a grandchild." },
      invocationFor(sideThreadId),
    );
    expect(result.isError).toBe(true);
    expect(harness.commands).toEqual([]);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("routes VM-root worker creation away from the legacy side-chat path", () => {
  const harness = makeHarness(undefined, {
    vmAgentThreadIds: new Set([mainThreadId]),
  });
  return Effect.gen(function* () {
    const result = yield* callTool(
      { action: "create_side_chat", title: "Worker", task: "Do bounded work." },
      invocationFor(mainThreadId),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("agent_collaboration.delegate"),
    });
    expect(harness.commands).toEqual([]);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("binds an explicitly selected provider atomically to the side-chat fork", () => {
  const harness = makeHarness([makeThread(mainThreadId, "Main")]);
  return Effect.gen(function* () {
    const result = yield* callTool(
      {
        action: "create_side_chat",
        title: "Claude verification",
        task: "Call the collaboration tool.",
        modelSelection: { instanceId: claudeInstanceId, model: "claude-fable-5" },
        runtimeMode: "approval-required",
        interactionMode: "agent",
      },
      invocationFor(mainThreadId),
    );

    expect(result.isError).toBe(false);
    expect(harness.commands.map((command) => command.type)).toEqual([
      "thread.fork",
      "thread.turn.start",
    ]);
    expect(harness.commands[0]).toMatchObject({
      type: "thread.fork",
      sourceThreadId: mainThreadId,
      modelSelection: { instanceId: claudeInstanceId, model: "claude-fable-5" },
      runtimeMode: "approval-required",
      interactionMode: "agent",
    });
    expect(harness.commands[1]).toMatchObject({
      type: "thread.turn.start",
      modelSelection: { instanceId: claudeInstanceId, model: "claude-fable-5" },
      runtimeMode: "approval-required",
      interactionMode: "agent",
    });
  }).pipe(Effect.provide(harness.layer));
});

it.effect("creates side tasks requested by a side agent as visible siblings", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const result = yield* callTool(
      { action: "create_side_chat", title: "Sibling task", task: "Investigate independently." },
      invocationFor(sideThreadId),
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      action: "create_side_chat",
      sourceThreadId: sideThreadId,
      sideChat: {
        title: "Sibling task",
        relationship: "sibling",
        parentThreadId: mainThreadId,
        interactionMode: "agent",
        isWorking: true,
      },
    });
    expect(harness.commands[0]).toMatchObject({
      type: "thread.fork",
      sourceThreadId: sideThreadId,
      sideChatParentThreadId: mainThreadId,
    });
  }).pipe(Effect.provide(harness.layer));
});

it.effect(
  "lets a side chat list and query its parent and siblings but not unrelated threads",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const invocation = invocationFor(sideThreadId);
      const listed = yield* callTool({ action: "list_related_chats" }, invocation);
      expect(listed.isError).toBe(false);
      expect(listed.structuredContent).toMatchObject({
        action: "list_related_chats",
        callerThreadId: sideThreadId,
        relatedChats: [
          { threadId: sideThreadId, relationship: "self" },
          { threadId: mainThreadId, relationship: "parent" },
          { threadId: siblingThreadId, relationship: "sibling" },
        ],
      });

      const queried = yield* callTool(
        {
          action: "query_related_chat",
          threadId: siblingThreadId,
          history: { pageSize: 5 },
        },
        invocation,
      );
      expect(queried.isError).toBe(false);
      expect(queried.structuredContent).toMatchObject({
        action: "query_related_chat",
        target: { threadId: siblingThreadId, relationship: "sibling" },
        history: { pagination: { pageSize: 5 } },
      });
      expect(harness.queriedThreadIds).toEqual([siblingThreadId]);

      const denied = yield* callTool(
        { action: "query_related_chat", threadId: unrelatedThreadId },
        invocation,
      );
      expect(denied.isError).toBe(true);
      expect(denied.content[0]).toMatchObject({
        type: "text",
        text: "The requested thread is not related to this agent's credential-bound chat.",
      });
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect(
  "rejects credentials without collaboration capability before reading or dispatching",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const result = yield* callTool(
        { action: "list_related_chats" },
        invocationFor(mainThreadId, new Set(["history"])),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: "This MCP credential does not grant thread-collaboration access.",
      });
      expect(harness.commands).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  },
);
