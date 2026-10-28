import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  ORCHESTRATOR_THREAD_ID,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  VmAgent,
  VmAgentDelegationId,
  VmAgentId,
  VmId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { VmAgentStore } from "../../../persistence/Services/VmAgents.ts";
import { type ConsultAskLog, handleWorkspaceConsult } from "./handlers.ts";
import type { WorkspaceConsultInput } from "./types.ts";

const agentThreadId = ThreadId.make("thread-scout");
const inheritedBrowserProfileThreadId = ThreadId.make("thread-browser-root");
const medicalThreadId = ThreadId.make("thread-medical");
const notesThreadId = ThreadId.make("thread-notes");
const medicalProjectId = ProjectId.make("project-medical");
const agentsProjectId = ProjectId.make("solla-agents");

const invocation = (
  threadId: ThreadId,
  capabilities: Set<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("env-consult-test"),
  threadId,
  providerSessionId: "provider-session-consult",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  capabilities,
  issuedAt: 1,
});

const agent: VmAgent = {
  vmAgentId: VmAgentId.make("agent-scout"),
  name: "Scout",
  handle: "scout",
  purpose: "answer email",
  vmId: VmId.make("vm-scout"),
  threadId: agentThreadId,
  status: "running",
  controlMode: "agent",
  icon: null,
  guestIp: "127.0.0.1",
  lastError: null,
  createdAt: "2026-08-21T00:00:00.000Z",
  updatedAt: "2026-08-21T00:00:00.000Z",
};

const iso = "2026-08-21T00:00:00.000Z";
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" };

const projectShell = {
  id: medicalProjectId,
  title: "Example Studio",
  workspaceRoot: "/repos/example-studio",
  defaultModelSelection: modelSelection,
  scripts: [],
  createdAt: iso,
  updatedAt: iso,
};

const threadShell = (overrides: Record<string, unknown> = {}) => ({
  id: medicalThreadId,
  projectId: medicalProjectId,
  title: "Export review",
  modelSelection,
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: iso,
  updatedAt: iso,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: iso,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...overrides,
});

const agentThreadShell = threadShell({
  id: agentThreadId,
  projectId: agentsProjectId,
  title: "Scout",
});

const notesThreadShell = threadShell({ id: notesThreadId, title: "Release notes" });

const turn = (turnId: string, state: string) => ({
  turnId: TurnId.make(turnId),
  state,
  requestedAt: iso,
  startedAt: iso,
  completedAt: state === "running" ? null : iso,
  assistantMessageId: null,
});

const completedTurn = turn("turn-1", "completed");

const assistantMessage = (id: string, text: string, turnId: string, createdAt = iso) => ({
  id: MessageId.make(id),
  role: "assistant",
  text,
  turnId: TurnId.make(turnId),
  streaming: false,
  createdAt,
  updatedAt: createdAt,
});

const makeHarness = (options: {
  /** Custom agents, by their own chat. Defaults to Scout on its own thread. */
  readonly agents?: ReadonlyArray<VmAgent>;
  readonly threads?: ReadonlyArray<unknown>;
  /** What the asked thread looks like while `ask` waits for its reply. */
  readonly shellById?: unknown;
  readonly messages?: ReadonlyArray<unknown>;
  /** The chats whose messages reached each thread's current work, oldest first. */
  readonly senders?: Readonly<Record<string, ThreadId | ReadonlyArray<ThreadId>>>;
  /** Threads whose current work a delegation reached. */
  readonly delegatedThreads?: ReadonlyArray<ThreadId>;
  readonly events?: PubSub.PubSub<OrchestrationEvent>;
  /** Runs on every read of the asked thread's shell while waiting. */
  readonly onReplyCheck?: Effect.Effect<void>;
}) => {
  const commands: OrchestrationCommand[] = [];
  const detailReads: Array<{ activityLimit?: number; messageLimit?: number } | undefined> = [];
  const threads = options.threads ?? [threadShell(), agentThreadShell];
  const state = { shellById: options.shellById, messages: options.messages ?? [] };
  const agents = options.agents ?? [agent];
  const storeLayer = Layer.mock(VmAgentStore)({
    list: () => Effect.succeed(agents),
    getByThreadId: (threadId) =>
      Effect.succeed(Option.fromNullishOr(agents.find((entry) => entry.threadId === threadId))),
  });
  const projectionLayer = Layer.mock(ProjectionSnapshotQuery)({
    getShellSnapshot: () =>
      Effect.succeed({
        snapshotSequence: 1,
        projects: [projectShell],
        threads,
        updatedAt: iso,
      } as never),
    getThreadShellById: (threadId) =>
      Effect.gen(function* () {
        const waited = state.shellById as { readonly id?: string } | undefined;
        if (waited !== undefined && waited.id === threadId) {
          if (options.onReplyCheck) yield* options.onReplyCheck;
          return Option.some(state.shellById as never);
        }
        const known = threads.find((thread) => (thread as { id: string }).id === threadId);
        return Option.fromNullishOr(known as never);
      }),
    getThreadDetailById: (_threadId, readOptions) =>
      Effect.sync(() => {
        detailReads.push(readOptions);
        return Option.some({
          messages: state.messages,
          proposedPlans: [],
          taskTitle: null,
        } as never);
      }),
    getTurnTrigger: (threadId) =>
      Effect.sync(() => {
        const sender = options.senders?.[threadId];
        const delegated = options.delegatedThreads?.includes(threadId) === true;
        if (sender === undefined && !delegated) return Option.none();
        const senderThreadIds =
          sender === undefined ? [] : typeof sender === "string" ? [sender] : sender;
        return Option.some({
          senderThreadId: senderThreadIds[0] ?? null,
          delegationId: delegated ? VmAgentDelegationId.make("delegation-consult") : null,
          senderThreadIds,
        });
      }),
  });
  const engineLayer = Layer.mock(OrchestrationEngineService)({
    dispatch: (command: OrchestrationCommand) =>
      Effect.sync(() => {
        commands.push(command);
      }) as never,
    streamDomainEvents: options.events ? Stream.fromPubSub(options.events) : Stream.never,
  });
  // Deterministic bytes: ids only need to be well-formed and unique-per-call
  // here, and a fixed source keeps failures reproducible.
  let seed = 0;
  const cryptoLayer = Layer.succeed(
    Crypto.Crypto,
    Crypto.make({
      randomBytes: (size) => Uint8Array.from({ length: size }, () => (seed++ * 7 + 13) % 256),
      digest: (_algorithm, data) => Effect.succeed(data),
    }),
  );
  return {
    commands,
    detailReads,
    state,
    layer: Layer.mergeAll(storeLayer, projectionLayer, engineLayer, cryptoLayer),
  };
};

type ConsultServices =
  | VmAgentStore
  | ProjectionSnapshotQuery
  | OrchestrationEngineService
  | Crypto.Crypto;

const consult = (
  input: WorkspaceConsultInput,
  layer: Layer.Layer<ConsultServices>,
  options: {
    readonly caller?: ThreadId;
    readonly capabilities?: Set<McpInvocationContext.McpCapability>;
    readonly askLog?: ConsultAskLog;
  } = {},
) =>
  handleWorkspaceConsult(input, options.askLog ?? new Map()).pipe(
    Effect.provideService(
      McpInvocationContext.McpInvocationContext,
      invocation(
        options.caller ?? agentThreadId,
        options.capabilities ?? new Set(["collaboration"]),
      ),
    ),
    Effect.provide(layer),
  );

/** {@link consult} for an `ask`, narrowed to the ask result. */
const consultAsk = (...args: Parameters<typeof consult>) =>
  consult(...args).pipe(
    Effect.flatMap((result) =>
      result.action === "ask" ? Effect.succeed(result) : Effect.die("expected an ask result"),
    ),
  );

const startedMessage = (commands: ReadonlyArray<OrchestrationCommand>) => {
  const started = commands.find((command) => command.type === "thread.turn.start");
  if (started?.type !== "thread.turn.start") return assert.fail("expected a turn start");
  return started.message;
};

const ask = (threadId: ThreadId, waitMs = 0): WorkspaceConsultInput => ({
  action: "ask",
  threadId,
  question: "Does Example Studio gate exports?",
  waitMs,
});

it.effect("refuses a call without the collaboration capability", () =>
  Effect.gen(function* () {
    const { layer } = makeHarness({});
    const error = yield* Effect.flip(
      consult({ action: "list_projects" }, layer, { capabilities: new Set(["terminals"]) }),
    );
    assert.strictEqual(error._tag, "WorkspaceConsultUnavailableError");
  }),
);

it.effect("lets any chat with the collaboration capability ask, not only agents", () =>
  Effect.gen(function* () {
    const { commands, layer } = makeHarness({
      agents: [],
      threads: [threadShell(), notesThreadShell],
    });
    const result = yield* consult(ask(medicalThreadId), layer, { caller: notesThreadId });
    assert.strictEqual(result.action, "ask");
    const message = startedMessage(commands);
    // The sender is the real calling thread, labelled with its own title.
    assert.strictEqual(message.senderThreadId, notesThreadId);
    assert.strictEqual(message.senderThreadTitle, "Release notes");
  }),
);

it.effect("labels an untitled chat as another chat, and only the orchestrator as itself", () =>
  Effect.gen(function* () {
    const untitled = makeHarness({
      agents: [],
      threads: [threadShell(), threadShell({ id: notesThreadId, title: "  " })],
    });
    yield* consult(ask(medicalThreadId), untitled.layer, { caller: notesThreadId });
    assert.strictEqual(startedMessage(untitled.commands).senderThreadTitle, "Another chat");

    const orchestrator = makeHarness({
      agents: [],
      threads: [threadShell(), threadShell({ id: ORCHESTRATOR_THREAD_ID, title: "Ops" })],
    });
    yield* consult(ask(medicalThreadId), orchestrator.layer, { caller: ORCHESTRATOR_THREAD_ID });
    const message = startedMessage(orchestrator.commands);
    assert.strictEqual(message.senderThreadTitle, "Orchestrator");
    assert.strictEqual(message.senderThreadId, ORCHESTRATOR_THREAD_ID);
  }),
);

it.effect("never labels another chat or agent as the orchestrator", () =>
  Effect.gen(function* () {
    const renamed = makeHarness({
      agents: [],
      threads: [threadShell(), threadShell({ id: notesThreadId, title: " orchestrator " })],
    });
    yield* consult(ask(medicalThreadId), renamed.layer, { caller: notesThreadId });
    const message = startedMessage(renamed.commands);
    assert.strictEqual(message.senderThreadTitle, "Another chat");
    assert.strictEqual(message.senderThreadId, notesThreadId);

    const namedAgent = makeHarness({ agents: [{ ...agent, name: "Orchestrator" }] });
    yield* consult(ask(medicalThreadId), namedAgent.layer);
    assert.strictEqual(startedMessage(namedAgent.commands).senderThreadTitle, "Another chat");
  }),
);

it.effect("speaks as the agent from a side chat forked from the agent's chat", () =>
  Effect.gen(function* () {
    const parentId = ThreadId.make("thread-scout-parent");
    const { commands, layer } = makeHarness({
      agents: [{ ...agent, threadId: parentId }],
      threads: [
        threadShell(),
        threadShell({ id: parentId, projectId: agentsProjectId, title: "Scout" }),
        threadShell({
          id: agentThreadId,
          title: "Side task",
          isSideChat: true,
          sideChatParentThreadId: parentId,
        }),
      ],
    });
    yield* consult(ask(medicalThreadId), layer);
    const message = startedMessage(commands);
    assert.strictEqual(message.senderThreadTitle, "Scout");
    assert.strictEqual(message.senderThreadId, agentThreadId);
    // Its agent's own chat is family, never a conversation to ask.
    const error = yield* Effect.flip(consult(ask(parentId), layer));
    assert.strictEqual(error._tag, "WorkspaceConsultRefusedError");
  }),
);

it.effect("lists projects the chat can consult", () =>
  Effect.gen(function* () {
    const { layer } = makeHarness({});
    const result = yield* consult({ action: "list_projects" }, layer);
    assert.deepStrictEqual(
      result.projects?.map((project) => project.title),
      ["Example Studio"],
    );
    assert.strictEqual(result.projects?.[0]?.threadCount, 1);
  }),
);

it.effect("never offers its own family, the orchestrator, Agent Builder or worker chats", () =>
  Effect.gen(function* () {
    const otherAgentThreadId = ThreadId.make("thread-ledger");
    const { layer } = makeHarness({
      agents: [
        agent,
        {
          ...agent,
          vmAgentId: VmAgentId.make("agent-ledger"),
          name: "Ledger",
          threadId: otherAgentThreadId,
        },
      ],
      threads: [
        threadShell(),
        agentThreadShell,
        threadShell({
          id: ThreadId.make("thread-scout-side"),
          isSideChat: true,
          sideChatParentThreadId: agentThreadId,
        }),
        threadShell({ id: ORCHESTRATOR_THREAD_ID }),
        threadShell({ id: ThreadId.make("agent-builder:session") }),
        threadShell({ id: ThreadId.make("delegation-worker:d-1") }),
        threadShell({ id: ThreadId.make("thread-archived"), archivedAt: iso }),
        threadShell({ id: otherAgentThreadId, projectId: agentsProjectId, title: "Ledger" }),
      ],
    });
    const result = yield* consult({ action: "list_threads" }, layer);
    assert.deepStrictEqual(
      result.threads?.map((thread) => [thread.threadId, thread.isAgent]),
      [
        [medicalThreadId, false],
        [otherAgentThreadId, true],
      ],
    );
  }),
);

it.effect("refuses to ask its parent chat, which may be the turn waiting on it", () =>
  Effect.gen(function* () {
    const { commands, layer } = makeHarness({
      agents: [],
      threads: [
        threadShell(),
        threadShell({
          id: notesThreadId,
          isSideChat: true,
          sideChatParentThreadId: medicalThreadId,
        }),
      ],
    });
    const error = yield* Effect.flip(
      consult(ask(medicalThreadId), layer, { caller: notesThreadId }),
    );
    assert.strictEqual(error._tag, "WorkspaceConsultRefusedError");
    assert.deepStrictEqual(commands, []);
  }),
);

it.effect("refuses Agent Builder, delegated-worker and orchestrator targets", () =>
  Effect.gen(function* () {
    const builderId = ThreadId.make("agent-builder:session");
    const workerId = ThreadId.make("delegation-worker:d-1");
    const { commands, layer } = makeHarness({
      threads: [
        threadShell({ id: builderId }),
        threadShell({ id: workerId }),
        threadShell({ id: ORCHESTRATOR_THREAD_ID }),
      ],
    });
    for (const threadId of [builderId, workerId, ORCHESTRATOR_THREAD_ID]) {
      const asked = yield* Effect.flip(consult(ask(threadId), layer));
      assert.strictEqual(asked._tag, "WorkspaceConsultRefusedError");
      const read = yield* Effect.flip(consult({ action: "read_thread", threadId }, layer));
      assert.strictEqual(read._tag, "WorkspaceConsultRefusedError");
    }
    assert.deepStrictEqual(commands, []);
  }),
);

it.effect("refuses to ask back a chat that is waiting on this one", () =>
  Effect.gen(function* () {
    // Export review asked Scout; Scout asking Export review now would loop.
    const { commands, layer } = makeHarness({ senders: { [agentThreadId]: medicalThreadId } });
    const error = yield* Effect.flip(consult(ask(medicalThreadId), layer));
    assert.strictEqual(error._tag, "WorkspaceConsultRefusedError");
    assert.include(error.message, "waiting on this chat's answer");
    assert.deepStrictEqual(commands, []);
  }),
);

it.effect("refuses to ask back a chat whose question was steered into this one's work", () =>
  Effect.gen(function* () {
    // The person started Scout's turn; Release notes then asked Scout, and the
    // question joined that running turn.
    const { commands, layer } = makeHarness({
      threads: [threadShell(), notesThreadShell, agentThreadShell],
      senders: { [agentThreadId]: [ORCHESTRATOR_THREAD_ID, notesThreadId] },
    });
    const error = yield* Effect.flip(consult(ask(notesThreadId), layer));
    assert.strictEqual(error._tag, "WorkspaceConsultRefusedError");
    assert.include(error.message, "waiting on this chat's answer");
    assert.deepStrictEqual(commands, []);

    // Any other conversation is still fine.
    yield* consult(ask(medicalThreadId), layer);
    assert.strictEqual(startedMessage(commands).senderThreadId, agentThreadId);
  }),
);

it.effect("counts depth through every chat that reached this one's work", () =>
  Effect.gen(function* () {
    const first = ThreadId.make("thread-first");
    const second = ThreadId.make("thread-second");
    const third = ThreadId.make("thread-third");
    // The person's own sender is shallow, but a steered question came from
    // a chat that is itself two chats deep.
    const { commands, layer } = makeHarness({
      senders: {
        [agentThreadId]: [ORCHESTRATOR_THREAD_ID, third],
        [third]: second,
        [second]: first,
      },
    });
    const error = yield* Effect.flip(consult(ask(medicalThreadId), layer));
    assert.strictEqual(error._tag, "WorkspaceConsultRefusedError");
    assert.include(error.message, "already 3 chats deep");
    assert.deepStrictEqual(commands, []);
  }),
);

it.effect("refuses a request that has already passed through three chats", () =>
  Effect.gen(function* () {
    const first = ThreadId.make("thread-first");
    const second = ThreadId.make("thread-second");
    const third = ThreadId.make("thread-third");
    const deep = makeHarness({
      senders: { [agentThreadId]: third, [third]: second, [second]: first },
    });
    const error = yield* Effect.flip(consult(ask(medicalThreadId), deep.layer));
    assert.strictEqual(error._tag, "WorkspaceConsultRefusedError");
    assert.include(error.message, "already 3 chats deep");
    assert.deepStrictEqual(deep.commands, []);

    // Two hops is fine, and the orchestrator speaks for the person: it ends the chain.
    const shallow = makeHarness({
      senders: { [agentThreadId]: second, [second]: first, [first]: ORCHESTRATOR_THREAD_ID },
    });
    const result = yield* consult(ask(medicalThreadId), shallow.layer);
    assert.strictEqual(result.action, "ask");
  }),
);

it.effect("allows twenty asks per ten minutes from one chat", () =>
  Effect.gen(function* () {
    const { commands, layer } = makeHarness({});
    const askLog: ConsultAskLog = new Map();
    for (let index = 0; index < 20; index++) {
      yield* consult(ask(medicalThreadId), layer, { askLog });
    }
    const error = yield* Effect.flip(consult(ask(medicalThreadId), layer, { askLog }));
    assert.strictEqual(error._tag, "WorkspaceConsultRefusedError");
    assert.include(error.message, "Wait a few minutes");
    assert.strictEqual(commands.length, 20);

    yield* TestClock.adjust("10 minutes");
    yield* consult(ask(medicalThreadId), layer, { askLog });
    assert.strictEqual(commands.length, 21);
  }),
);

const askProject: WorkspaceConsultInput = {
  action: "ask",
  projectId: medicalProjectId,
  question: "Anything?",
  waitMs: 0,
};

it.effect("lets delegated work ask existing threads but not open new ones", () =>
  Effect.gen(function* () {
    const { commands, layer } = makeHarness({ delegatedThreads: [agentThreadId] });
    const error = yield* Effect.flip(consult(askProject, layer));
    assert.strictEqual(error._tag, "WorkspaceConsultRefusedError");
    assert.include(error.message, "Delegated work cannot open new conversations");
    assert.deepStrictEqual(commands, []);

    yield* consult(ask(medicalThreadId), layer);
    assert.strictEqual(startedMessage(commands).senderThreadId, agentThreadId);

    // A worker's chat is delegated work whatever its current turn reads as.
    const workerId = ThreadId.make("delegation-worker:d-1");
    const worker = makeHarness({ threads: [threadShell(), threadShell({ id: workerId })] });
    const workerError = yield* Effect.flip(consult(askProject, worker.layer, { caller: workerId }));
    assert.strictEqual(workerError._tag, "WorkspaceConsultRefusedError");
    assert.deepStrictEqual(worker.commands, []);
  }),
);

it.effect("lets an agent's own chat open threads on the person's turn", () =>
  Effect.gen(function* () {
    // A delegation to Scout may still be queued; this turn is the person's.
    const { commands, layer } = makeHarness({});
    const result = yield* consultAsk(askProject, layer);
    assert.strictEqual(result.answered, false);
    assert.isDefined(commands.find((command) => command.type === "thread.create"));
  }),
);

it.effect("refuses to wake a stopped agent", () =>
  Effect.gen(function* () {
    const ledgerThreadId = ThreadId.make("thread-ledger");
    const { commands, layer } = makeHarness({
      agents: [
        agent,
        {
          ...agent,
          vmAgentId: VmAgentId.make("agent-ledger"),
          name: "Ledger",
          threadId: ledgerThreadId,
          status: "stopped",
        },
      ],
      threads: [threadShell({ id: ledgerThreadId, projectId: agentsProjectId }), agentThreadShell],
    });
    const error = yield* Effect.flip(consult(ask(ledgerThreadId), layer));
    assert.strictEqual(error._tag, "WorkspaceConsultRefusedError");
    assert.include(error.message, "Ledger is stopped");
    assert.deepStrictEqual(commands, []);
  }),
);

it.effect("refuses to wake a stopped agent through one of its side chats", () =>
  Effect.gen(function* () {
    const ledgerThreadId = ThreadId.make("thread-ledger");
    const ledgerSideId = ThreadId.make("thread-ledger-side");
    const { commands, layer } = makeHarness({
      agents: [
        agent,
        {
          ...agent,
          vmAgentId: VmAgentId.make("agent-ledger"),
          name: "Ledger",
          threadId: ledgerThreadId,
          status: "stopped",
        },
      ],
      threads: [
        threadShell({ id: ledgerThreadId, projectId: agentsProjectId, title: "Ledger" }),
        threadShell({
          id: ledgerSideId,
          projectId: agentsProjectId,
          title: "Side task",
          isSideChat: true,
          sideChatParentThreadId: ledgerThreadId,
        }),
        agentThreadShell,
      ],
    });
    const error = yield* Effect.flip(consult(ask(ledgerSideId), layer));
    assert.strictEqual(error._tag, "WorkspaceConsultRefusedError");
    assert.include(error.message, "Ledger is stopped");
    assert.deepStrictEqual(commands, []);

    // Only the agent's own chat is marked as the agent.
    const listed = yield* consult({ action: "list_threads" }, layer);
    assert.deepStrictEqual(
      listed.threads?.map((thread) => [thread.threadId, thread.isAgent]),
      [
        [ledgerThreadId, true],
        [ledgerSideId, false],
      ],
    );
  }),
);

it.effect("caps the open conversations one chat has opened", () =>
  Effect.gen(function* () {
    const opened = Array.from({ length: 10 }, (_, index) =>
      threadShell({
        id: ThreadId.make(`thread-opened-${index}`),
        createdByThreadId: agentThreadId,
      }),
    );
    const { commands, layer } = makeHarness({ threads: [...opened, agentThreadShell] });
    const error = yield* Effect.flip(consult(askProject, layer));
    assert.strictEqual(error._tag, "WorkspaceConsultRefusedError");
    assert.deepStrictEqual(commands, []);
  }),
);

it.effect("does not count side chats or delegated workers toward the cap", () =>
  Effect.gen(function* () {
    // Ten side chats and workers record Scout as their creator, but ask
    // opened none of them, plus nine threads it did open.
    const forks = Array.from({ length: 10 }, (_, index) =>
      threadShell({
        id: ThreadId.make(
          index % 2 === 0 ? `thread-side-${index}` : `delegation-worker:d-${index}`,
        ),
        projectId: agentsProjectId,
        createdByThreadId: agentThreadId,
        isSideChat: true,
        sideChatParentThreadId: agentThreadId,
      }),
    );
    const opened = Array.from({ length: 9 }, (_, index) =>
      threadShell({
        id: ThreadId.make(`thread-opened-${index}`),
        createdByThreadId: agentThreadId,
      }),
    );
    const { commands, layer } = makeHarness({
      threads: [...forks, ...opened, agentThreadShell],
    });
    yield* consult(askProject, layer);
    assert.isDefined(commands.find((command) => command.type === "thread.create"));
  }),
);

it.effect("opens a thread in the project and asks the question there", () =>
  Effect.gen(function* () {
    const { commands, layer } = makeHarness({
      threads: [
        threadShell(),
        { ...agentThreadShell, browserProfileThreadId: inheritedBrowserProfileThreadId },
      ],
    });
    const result = yield* consult(
      {
        action: "ask",
        projectId: medicalProjectId,
        question: "Does Example Studio gate exports behind a licence check?",
        waitMs: 0,
      },
      layer,
    );

    if (result.action !== "ask") return assert.fail("expected an ask result");
    const created = commands.find((command) => command.type === "thread.create");
    assert.isDefined(created);
    // The new conversation belongs to the consulted project, not the caller's.
    assert.strictEqual(created.projectId, medicalProjectId);
    assert.strictEqual(created.createdByThreadId, agentThreadId);
    assert.strictEqual(created.browserProfileThreadId, inheritedBrowserProfileThreadId);
    assert.strictEqual(
      startedMessage(commands).text,
      "Does Example Studio gate exports behind a licence check?",
    );
    // Nothing answered yet, so the caller is handed the thread to poll.
    assert.strictEqual(result.answered, false);
    assert.isDefined(result.threadId);
  }),
);

it.effect("returns the reply once the consulted thread has answered", () =>
  Effect.gen(function* () {
    const { layer, detailReads } = makeHarness({
      shellById: threadShell({ latestTurn: completedTurn }),
      messages: [
        {
          id: MessageId.make("m-1"),
          role: "user",
          text: "Does Example Studio gate exports?",
          turnId: TurnId.make("turn-1"),
          streaming: false,
          createdAt: iso,
          updatedAt: iso,
        },
        assistantMessage("m-2", "Yes — exports check the licence flag before rendering.", "turn-1"),
      ],
    });
    const result = yield* consult(ask(medicalThreadId, 5_000), layer);
    if (result.action !== "ask") return assert.fail("expected an ask result");
    assert.strictEqual(result.answered, true);
    assert.strictEqual(result.answer, "Yes — exports check the licence flag before rendering.");
    assert.deepStrictEqual(detailReads, [{ messageLimit: 20, activityLimit: 0 }]);
  }),
);

it.effect("reads conversation messages through a bounded read", () =>
  Effect.gen(function* () {
    const { layer, detailReads } = makeHarness({
      messages: [
        { role: "user", text: "First", createdAt: iso },
        { role: "assistant", text: "", createdAt: iso },
        { role: "assistant", text: "Latest answer", createdAt: iso },
      ],
    });
    const result = yield* consult(
      { action: "read_thread", threadId: medicalThreadId, limit: 1 },
      layer,
    );
    assert.deepStrictEqual(result.messages, [
      { role: "assistant", text: "Latest answer", createdAt: iso },
    ]);
    assert.deepStrictEqual(detailReads, [{ messageLimit: 2, activityLimit: 0 }]);
  }),
);

it.effect("does not mistake a previous turn's reply for an answer", () =>
  Effect.gen(function* () {
    // The thread already carries a settled turn and an assistant message from a
    // question nobody just asked. Waiting must not hand that back as the answer.
    const { layer } = makeHarness({
      threads: [threadShell({ latestTurn: completedTurn }), agentThreadShell],
      shellById: threadShell({ latestTurn: completedTurn }),
      messages: [assistantMessage("m-2", "An older answer about something else.", "turn-1")],
    });
    const result = yield* consult(ask(medicalThreadId), layer);
    if (result.action !== "ask") return assert.fail("expected an ask result");
    assert.strictEqual(result.answered, false);
    assert.isUndefined(result.answer);
  }),
);

it.effect("takes the reply from a running turn the question was steered into", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(
      DateTime.toEpochMillis(DateTime.makeUnsafe("2026-08-21T00:00:05.000Z")),
    );
    // The thread was busy when asked, so the question joined turn-1 rather
    // than starting a turn of its own.
    const { layer, state } = makeHarness({
      threads: [threadShell({ latestTurn: turn("turn-1", "running") }), agentThreadShell],
      shellById: threadShell({ latestTurn: turn("turn-1", "running") }),
      messages: [
        assistantMessage("m-before", "Working on the person's task.", "turn-1"),
        assistantMessage(
          "m-reply",
          "Yes, exports are gated.",
          "turn-1",
          "2026-08-21T00:00:09.000Z",
        ),
      ],
    });
    const stillRunning = yield* consultAsk(ask(medicalThreadId), layer);
    assert.strictEqual(stillRunning.answered, false);

    state.shellById = threadShell({ latestTurn: completedTurn });
    const settled = yield* consultAsk(ask(medicalThreadId), layer);
    assert.strictEqual(settled.answered, true);
    assert.strictEqual(settled.answer, "Yes, exports are gated.");
  }),
);

it.effect("wakes on the asked thread's events instead of polling", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    const firstCheck = yield* Deferred.make<void>();
    const { layer, state } = makeHarness({
      events,
      shellById: threadShell(),
      onReplyCheck: Deferred.succeed(firstCheck, undefined).pipe(Effect.asVoid),
    });
    const asking = yield* Effect.forkChild(consultAsk(ask(medicalThreadId, 60_000), layer));
    yield* Deferred.await(firstCheck);

    state.shellById = threadShell({ latestTurn: turn("turn-2", "completed") });
    state.messages = [assistantMessage("m-3", "Exports are gated.", "turn-2")];
    yield* PubSub.publish(events, {
      aggregateKind: "thread",
      aggregateId: medicalThreadId,
      type: "thread.session-set",
      payload: {},
    } as never);

    const result = yield* Fiber.join(asking);
    assert.strictEqual(result.answered, true);
    assert.strictEqual(result.answer, "Exports are gated.");
  }),
);

it.effect("hands back the thread to poll once the wait runs out", () =>
  Effect.gen(function* () {
    const firstCheck = yield* Deferred.make<void>();
    const { layer } = makeHarness({
      shellById: threadShell({ latestTurn: turn("turn-2", "running") }),
      onReplyCheck: Deferred.succeed(firstCheck, undefined).pipe(Effect.asVoid),
    });
    const asking = yield* Effect.forkChild(consultAsk(ask(medicalThreadId, 5_000), layer));
    yield* Deferred.await(firstCheck);
    yield* TestClock.adjust("5 seconds");
    const result = yield* Fiber.join(asking);
    assert.strictEqual(result.answered, false);
    assert.strictEqual(result.threadId, medicalThreadId);
  }),
);
