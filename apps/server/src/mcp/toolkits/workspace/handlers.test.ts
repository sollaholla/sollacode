import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ORCHESTRATOR_THREAD_ID,
  ProjectId,
  ProviderInstanceId,
  TerminalSessionLookupError,
  ThreadId,
  type IsoDateTime,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type TerminalSessionSnapshot,
  type TerminalSummary,
  type TerminalWriteInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { TerminalManager } from "../../../terminal/Manager.ts";
import { handleWorkspaceOrchestration, summarizeThread } from "./handlers.ts";

const createdAt = "2026-08-16T12:00:00.000Z" as IsoDateTime;
const projectId = ProjectId.make("project-workspace-test");
const codexInstanceId = ProviderInstanceId.make("codex");

const workingThreadId = ThreadId.make("thread-working");
const blockedThreadId = ThreadId.make("thread-blocked");
const settledThreadId = ThreadId.make("thread-settled");
const sideChatThreadId = ThreadId.make("thread-side");

const makeThread = (
  id: ThreadId,
  title: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => ({
  id,
  projectId,
  title,
  isSideChat: false,
  sideChatParentThreadId: null,
  modelSelection: { instanceId: codexInstanceId, model: "gpt-5.6-sol" },
  runtimeMode: "full-access",
  interactionMode: "default",
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
  ...overrides,
});

const createdAtMs = Date.parse(createdAt);
const summarize = (shell: OrchestrationThreadShell) =>
  summarizeThread(shell, { nowMs: createdAtMs });

const completedTurn = {
  turnId: "turn-1" as never,
  state: "completed" as const,
  requestedAt: createdAt,
  startedAt: createdAt,
  completedAt: createdAt,
  assistantMessageId: null,
};

const readySession = (threadId: ThreadId) => ({
  threadId,
  status: "ready" as const,
  providerName: "claudeAgent",
  runtimeMode: "full-access" as const,
  activeTurnId: null,
  lastError: null,
  updatedAt: createdAt,
});

const makeProject = (title: string): OrchestrationProjectShell => ({
  id: projectId,
  title,
  workspaceRoot: `/tmp/${title}`,
  defaultModelSelection: null,
  scripts: [],
  createdAt,
  updatedAt: createdAt,
});

const DEFAULT_THREADS: ReadonlyArray<OrchestrationThreadShell> = [
  makeThread(ORCHESTRATOR_THREAD_ID, "Orchestrator"),
  makeThread(workingThreadId, "Working", {
    latestTurn: {
      turnId: "turn-1" as never,
      state: "running",
      requestedAt: createdAt,
      startedAt: createdAt,
      completedAt: null,
      assistantMessageId: null,
    },
  }),
  makeThread(blockedThreadId, "Blocked", { hasPendingApprovals: true }),
  makeThread(settledThreadId, "Settled", { settledAt: createdAt }),
  makeThread(sideChatThreadId, "Side", {
    isSideChat: true,
    sideChatParentThreadId: workingThreadId,
  }),
];

const invocationFor = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-workspace-test"),
  threadId,
  providerSessionId: `provider-session-${threadId}`,
  providerInstanceId: codexInstanceId,
  capabilities: new Set<McpInvocationContext.McpCapability>(["collaboration"]),
  issuedAt: 1,
});

const makeTerminalSummary = (overrides: Partial<TerminalSummary> = {}): TerminalSummary => ({
  threadId: workingThreadId,
  terminalId: "term-1",
  cwd: "/tmp/rover",
  worktreePath: null,
  status: "running",
  pid: 42,
  exitCode: null,
  exitSignal: null,
  hasRunningSubprocess: true,
  label: "claude",
  updatedAt: createdAt,
  ...overrides,
});

const makeHarness = (
  threads: ReadonlyArray<OrchestrationThreadShell> = DEFAULT_THREADS,
  options: {
    readonly terminals?: ReadonlyArray<TerminalSummary>;
    readonly snapshots?: ReadonlyArray<TerminalSessionSnapshot>;
    readonly projects?: ReadonlyArray<OrchestrationProjectShell>;
  } = {},
) => {
  const commands: Array<OrchestrationCommand> = [];
  const writes: Array<TerminalWriteInput> = [];
  const terminals = [...(options.terminals ?? [])];
  const snapshots = new Map(
    (options.snapshots ?? []).map((snapshot) => [
      `${snapshot.threadId}:${snapshot.terminalId}`,
      snapshot,
    ]),
  );

  const projectionLayer = Layer.mock(ProjectionSnapshotQuery)({
    getShellSnapshot: () =>
      Effect.sync(() => ({
        snapshotSequence: 0,
        projects: [...(options.projects ?? [])],
        threads: [...threads],
        updatedAt: createdAt,
      })),
    getThreadShellById: (threadId) =>
      Effect.sync(() => Option.fromNullishOr(threads.find((thread) => thread.id === threadId))),
  });

  const engineLayer = Layer.mock(OrchestrationEngineService)({
    dispatch: (command: OrchestrationCommand) =>
      Effect.sync(() => {
        commands.push(command);
        return { sequence: commands.length };
      }),
    readEvents: () => Stream.empty,
    streamDomainEvents: Stream.empty,
    latestSequence: Effect.sync(() => commands.length),
  });

  const terminalLayer = Layer.succeed(TerminalManager, {
    open: () => Effect.die("unused"),
    attachStream: () => Effect.die("unused"),
    list: (input) =>
      Effect.succeed(
        input.threadId === undefined
          ? terminals
          : terminals.filter((terminal) => terminal.threadId === input.threadId),
      ),
    read: (input) => {
      const snapshot = snapshots.get(`${input.threadId}:${input.terminalId}`);
      if (snapshot === undefined) {
        return Effect.fail(
          new TerminalSessionLookupError({
            threadId: input.threadId,
            terminalId: input.terminalId,
          }),
        );
      }
      return Effect.succeed(snapshot);
    },
    write: (input) =>
      Effect.sync(() => {
        writes.push(input);
      }),
    resize: () => Effect.void,
    clear: () => Effect.void,
    restart: () => Effect.die("unused"),
    close: () => Effect.void,
    subscribe: () => Effect.succeed(() => undefined),
    subscribeMetadata: () => Effect.succeed(() => undefined),
    getLayout: () => Effect.succeed({ layout: null }),
    setLayout: () => Effect.die("unused"),
    subscribeLayouts: () => Effect.succeed(() => undefined),
  });

  return { commands, writes, layer: Layer.mergeAll(projectionLayer, engineLayer, terminalLayer) };
};

type HandlerEffect = ReturnType<typeof handleWorkspaceOrchestration>;

const runAs = (
  threadId: ThreadId,
  harness: ReturnType<typeof makeHarness>,
  effect: HandlerEffect,
) =>
  effect.pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocationFor(threadId)),
    Effect.provide(harness.layer),
  );

it.layer(NodeServices.layer)("workspace orchestration toolkit", (it) => {
  it.effect("refuses any caller that is not the orchestrator thread", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const error = yield* Effect.flip(
        runAs(workingThreadId, harness, handleWorkspaceOrchestration({ action: "list_threads" })),
      );
      // Gated on identity rather than a capability flag, so widening a
      // capability set elsewhere can never hand an ordinary thread
      // whole-workspace write access.
      expect((error as { readonly _tag: string })._tag).toBe("WorkspaceOrchestrationScopeError");
      expect(harness.commands).toHaveLength(0);
    }),
  );

  it.effect("lists every thread except itself, side chats and settled work", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const result = (yield* runAs(
        ORCHESTRATOR_THREAD_ID,
        harness,
        handleWorkspaceOrchestration({ action: "list_threads" }),
      )) as unknown as {
        readonly threads: ReadonlyArray<{ threadId: string; waitingOn?: string }>;
      };

      expect(result.threads.map((thread) => thread.threadId)).toEqual([
        workingThreadId,
        blockedThreadId,
      ]);
      // Listing itself would invite the model to message itself and loop.
      expect(result.threads.some((thread) => thread.threadId === ORCHESTRATOR_THREAD_ID)).toBe(
        false,
      );
    }),
  );

  it.effect("reports what each thread is blocked on", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const result = (yield* runAs(
        ORCHESTRATOR_THREAD_ID,
        harness,
        handleWorkspaceOrchestration({ action: "list_threads" }),
      )) as unknown as {
        readonly threads: ReadonlyArray<{
          threadId: string;
          waitingOn?: string;
          isWorking: boolean;
        }>;
      };

      const working = result.threads.find((thread) => thread.threadId === workingThreadId);
      const blocked = result.threads.find((thread) => thread.threadId === blockedThreadId);
      expect(working?.isWorking).toBe(true);
      expect(working?.waitingOn).toBe("nothing");
      expect(blocked?.waitingOn).toBe("approval");
      expect(blocked?.isWorking).toBe(false);
    }),
  );

  it("does not call a working thread blocked on the plan it is carrying out", () => {
    // The plan record stays actionable until the work it describes finishes, so
    // a thread that was approved and is now building still carries the flag.
    const building = summarize(
      makeThread(workingThreadId, "Working", {
        hasActionableProposedPlan: true,
        latestTurn: {
          turnId: "turn-1" as never,
          state: "running",
          requestedAt: createdAt,
          startedAt: createdAt,
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    );
    expect(building.isWorking).toBe(true);
    expect(building.waitingOn).toBe("nothing");

    const stopped = summarize(
      makeThread(workingThreadId, "Working", {
        hasActionableProposedPlan: true,
        interactionMode: "plan",
        latestTurn: {
          turnId: "turn-1" as never,
          state: "completed",
          requestedAt: createdAt,
          startedAt: createdAt,
          completedAt: createdAt,
          assistantMessageId: null,
        },
      }),
    );
    expect(stopped.waitingOn).toBe("proposed-plan");

    const leftover = summarize(
      makeThread(workingThreadId, "Working", { hasActionableProposedPlan: true }),
    );
    expect(leftover.waitingOn).toBe("nothing");

    const planModeWithoutSettledTurn = summarize(
      makeThread(workingThreadId, "Working", {
        hasActionableProposedPlan: true,
        interactionMode: "plan",
      }),
    );
    expect(planModeWithoutSettledTurn.waitingOn).toBe("nothing");
  });

  it("waits on an open plan an agent proposed outside Plan mode", () => {
    // The flag is the newest plan that is neither implemented nor closed, and a
    // plan is implemented as soon as the person answers in Build or Agent - so an
    // open plan in those modes is one the agent proposed on its own (Claude can
    // enter plan mode by itself) and is still waiting for an answer.
    const leftoverDefault = summarize(
      makeThread(workingThreadId, "Working", {
        hasActionableProposedPlan: true,
        interactionMode: "default",
        latestTurn: {
          turnId: "turn-1" as never,
          state: "completed",
          requestedAt: createdAt,
          startedAt: createdAt,
          completedAt: createdAt,
          assistantMessageId: null,
        },
      }),
    );
    expect(leftoverDefault.waitingOn).toBe("proposed-plan");

    const leftoverAgent = summarize(
      makeThread(workingThreadId, "Working", {
        hasActionableProposedPlan: true,
        interactionMode: "agent",
        latestTurn: {
          turnId: "turn-1" as never,
          state: "completed",
          requestedAt: createdAt,
          startedAt: createdAt,
          completedAt: createdAt,
          assistantMessageId: null,
        },
      }),
    );
    expect(leftoverAgent.waitingOn).toBe("proposed-plan");
  });

  it("reports proposed-plan only for a settled plan-mode turn with an unimplemented plan", () => {
    const stopped = summarize(
      makeThread(workingThreadId, "Working", {
        hasActionableProposedPlan: true,
        interactionMode: "plan",
        latestTurn: {
          turnId: "turn-1" as never,
          state: "completed",
          requestedAt: createdAt,
          startedAt: createdAt,
          completedAt: createdAt,
          assistantMessageId: null,
        },
      }),
    );
    expect(stopped.waitingOn).toBe("proposed-plan");
  });

  it("does not treat a working plan-mode thread as waiting on a plan", () => {
    const building = summarize(
      makeThread(workingThreadId, "Working", {
        hasActionableProposedPlan: true,
        interactionMode: "plan",
        latestTurn: {
          turnId: "turn-1" as never,
          state: "running",
          requestedAt: createdAt,
          startedAt: createdAt,
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    );
    expect(building.isWorking).toBe(true);
    expect(building.waitingOn).toBe("nothing");
  });

  it("does not treat an old unimplemented plan as a wait on a later turn", () => {
    const laterTurn = summarize(
      makeThread(workingThreadId, "Working", {
        hasActionableProposedPlan: false,
        interactionMode: "plan",
        latestTurn: {
          turnId: "turn-2" as never,
          state: "completed",
          requestedAt: createdAt,
          startedAt: createdAt,
          completedAt: createdAt,
          assistantMessageId: null,
        },
      }),
    );
    expect(laterTurn.waitingOn).toBe("nothing");
  });

  it.effect("names the conversation a side chat hangs off", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const result = (yield* runAs(
        ORCHESTRATOR_THREAD_ID,
        harness,
        handleWorkspaceOrchestration({ action: "describe_thread", threadId: sideChatThreadId }),
      )) as unknown as {
        readonly thread: { readonly isSideChat: boolean; readonly sideChatOf?: string };
      };

      expect(result.thread.isSideChat).toBe(true);
      // "It is a side chat" on its own sends the user looking in the sidebar,
      // which is the one place side chats never appear.
      expect(result.thread.sideChatOf).toBe("Working");
    }),
  );

  it.effect("leaves sideChatOf off an ordinary thread", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const result = (yield* runAs(
        ORCHESTRATOR_THREAD_ID,
        harness,
        handleWorkspaceOrchestration({ action: "describe_thread", threadId: workingThreadId }),
      )) as unknown as {
        readonly thread: { readonly isSideChat: boolean; readonly sideChatOf?: string };
      };

      expect(result.thread.isSideChat).toBe(false);
      expect(result.thread.sideChatOf).toBeUndefined();
    }),
  );

  it("counts background tasks a finished turn left running as working", () => {
    const backgroundTasks = { count: 2, startedAt: createdAt, lastActivityAt: createdAt };
    const running = summarize(
      makeThread(sideChatThreadId, "Facial hair pass", {
        latestTurn: completedTurn,
        session: readySession(sideChatThreadId),
        backgroundTasks,
      }),
    );
    expect(running).toMatchObject({ status: "ready", isWorking: true, backgroundTaskCount: 2 });

    // A task that stopped reporting half an hour ago is not still running.
    const stale = summarizeThread(
      makeThread(sideChatThreadId, "Facial hair pass", {
        latestTurn: completedTurn,
        session: readySession(sideChatThreadId),
        backgroundTasks,
      }),
      { nowMs: createdAtMs + 31 * 60 * 1000 },
    );
    expect(stale.isWorking).toBe(false);
    expect(stale.backgroundTaskCount).toBeUndefined();
  });

  it("counts a scheduled continuation as working and says what it waits on", () => {
    const sleeping = summarize(
      makeThread(workingThreadId, "Agent", {
        latestTurn: completedTurn,
        session: readySession(workingThreadId),
        pendingWork: { kind: "agent-continuation", state: "sleeping", since: createdAt },
      }),
    );
    expect(sleeping).toMatchObject({
      isWorking: true,
      pendingWork: { kind: "agent-continuation", state: "sleeping" },
    });

    // Held for a sign-in, nothing runs until a person acts.
    const blocked = summarize(
      makeThread(workingThreadId, "Agent", {
        latestTurn: completedTurn,
        session: readySession(workingThreadId),
        pendingWork: { kind: "startup-resume", state: "blocked-authentication", since: createdAt },
      }),
    );
    expect(blocked.isWorking).toBe(false);
    expect(blocked.pendingWork).toEqual({
      kind: "startup-resume",
      state: "blocked-authentication",
    });
  });

  it.effect("finds a side chat by its project and reports its background work", () =>
    Effect.gen(function* () {
      const parentId = ThreadId.make("thread-makehuman");
      const harness = makeHarness(
        [
          makeThread(ORCHESTRATOR_THREAD_ID, "Orchestrator"),
          makeThread(parentId, "AAA MakeHuman skin/hair + WebGPU demo", {
            latestTurn: completedTurn,
            session: readySession(parentId),
          }),
          makeThread(sideChatThreadId, "Facial Hair Quality Falls Short of MetaHuman", {
            isSideChat: true,
            sideChatParentThreadId: parentId,
            latestTurn: completedTurn,
            session: readySession(sideChatThreadId),
            backgroundTasks: { count: 2, startedAt: createdAt, lastActivityAt: createdAt },
          }),
        ],
        { projects: [makeProject("UndeadOpenWorld")] },
      );
      const result = (yield* runAs(
        ORCHESTRATOR_THREAD_ID,
        harness,
        handleWorkspaceOrchestration({
          action: "list_threads",
          includeSettled: true,
          includeSideChats: true,
        }),
      )) as unknown as {
        readonly threads: ReadonlyArray<{
          readonly threadId: string;
          readonly projectTitle?: string;
          readonly isWorking: boolean;
          readonly backgroundTaskCount?: number;
          readonly sideChatOf?: string;
        }>;
      };

      // Neither title mentions the project; only projectTitle connects them
      // to "Undead Open World" (2026-10-12).
      expect(result.threads.find((thread) => thread.threadId === sideChatThreadId)).toMatchObject({
        projectTitle: "UndeadOpenWorld",
        isWorking: true,
        backgroundTaskCount: 2,
        sideChatOf: "AAA MakeHuman skin/hair + WebGPU demo",
      });
      expect(result.threads.find((thread) => thread.threadId === parentId)).toMatchObject({
        projectTitle: "UndeadOpenWorld",
        isWorking: false,
      });
    }),
  );

  it.effect("opts settled threads and side chats back in on request", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const result = (yield* runAs(
        ORCHESTRATOR_THREAD_ID,
        harness,
        handleWorkspaceOrchestration({
          action: "list_threads",
          includeSettled: true,
          includeSideChats: true,
        }),
      )) as unknown as { readonly threads: ReadonlyArray<{ threadId: string }> };

      expect(result.threads.map((thread) => thread.threadId)).toEqual([
        workingThreadId,
        blockedThreadId,
        settledThreadId,
        sideChatThreadId,
      ]);
    }),
  );

  it.effect("sends a message into another thread as a real user turn", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* runAs(
        ORCHESTRATOR_THREAD_ID,
        harness,
        handleWorkspaceOrchestration({
          action: "send_to_thread",
          threadId: workingThreadId,
          message: "status please",
        }),
      );

      expect(harness.commands).toHaveLength(1);
      const command = harness.commands[0] as Extract<
        OrchestrationCommand,
        { type: "thread.turn.start" }
      >;
      expect(command.type).toBe("thread.turn.start");
      expect(command.threadId).toBe(workingThreadId);
      expect(command.message.text).toBe("status please");
      expect(command.message.role).toBe("user");
      expect(command.message.senderThreadId).toBe(ORCHESTRATOR_THREAD_ID);
      expect(command.message.senderThreadTitle).toBe("Orchestrator");
    }),
  );

  it.effect("refuses to send to itself, which would recurse", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.flip(
        runAs(
          ORCHESTRATOR_THREAD_ID,
          harness,
          handleWorkspaceOrchestration({
            action: "send_to_thread",
            threadId: ORCHESTRATOR_THREAD_ID,
            message: "loop",
          }),
        ),
      );
      expect(harness.commands).toHaveLength(0);
    }),
  );

  it.effect("fails cleanly for an unknown thread instead of dispatching", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const error = yield* Effect.flip(
        runAs(
          ORCHESTRATOR_THREAD_ID,
          harness,
          handleWorkspaceOrchestration({
            action: "send_to_thread",
            threadId: ThreadId.make("thread-does-not-exist"),
            message: "hello",
          }),
        ),
      );
      expect((error as { readonly _tag: string })._tag).toBe(
        "WorkspaceOrchestrationThreadNotFoundError",
      );
      expect(harness.commands).toHaveLength(0);
    }),
  );

  it.effect("interrupts an in-flight turn", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* runAs(
        ORCHESTRATOR_THREAD_ID,
        harness,
        handleWorkspaceOrchestration({
          action: "interrupt_thread",
          threadId: workingThreadId,
        }),
      );

      expect(harness.commands).toHaveLength(1);
      expect(harness.commands[0]?.type).toBe("thread.turn.interrupt");
    }),
  );

  it.effect("lists live terminals and attaches them to the owning thread", () =>
    Effect.gen(function* () {
      const terminal = makeTerminalSummary();
      const harness = makeHarness(DEFAULT_THREADS, { terminals: [terminal] });
      const listed = (yield* runAs(
        ORCHESTRATOR_THREAD_ID,
        harness,
        handleWorkspaceOrchestration({ action: "list_terminals" }),
      )) as {
        readonly terminals: ReadonlyArray<{
          readonly threadId: string;
          readonly threadTitle: string;
          readonly label: string;
        }>;
      };
      expect(listed.terminals).toEqual([
        {
          threadId: workingThreadId,
          threadTitle: "Working",
          terminalId: "term-1",
          label: "claude",
          status: "running",
          hasRunningSubprocess: true,
          cwd: "/tmp/rover",
        },
      ]);

      const threads = (yield* runAs(
        ORCHESTRATOR_THREAD_ID,
        harness,
        handleWorkspaceOrchestration({ action: "list_threads" }),
      )) as {
        readonly threads: ReadonlyArray<{
          readonly threadId: string;
          readonly terminals: ReadonlyArray<{ readonly label: string }>;
        }>;
      };
      expect(
        threads.threads.find((thread) => thread.threadId === workingThreadId)?.terminals,
      ).toEqual([
        { terminalId: "term-1", label: "claude", status: "running", hasRunningSubprocess: true },
      ]);
    }),
  );

  it.effect("reads a terminal's visible output without spawning", () =>
    Effect.gen(function* () {
      const harness = makeHarness(DEFAULT_THREADS, {
        terminals: [makeTerminalSummary()],
        snapshots: [
          {
            threadId: workingThreadId,
            terminalId: "term-1",
            cwd: "/tmp/rover",
            worktreePath: null,
            status: "running",
            pid: 42,
            history: "\u001b[32mclaude\u001b[0m ready\n",
            exitCode: null,
            exitSignal: null,
            label: "claude",
            updatedAt: createdAt,
          },
        ],
      });
      const result = (yield* runAs(
        ORCHESTRATOR_THREAD_ID,
        harness,
        handleWorkspaceOrchestration({
          action: "read_terminal",
          threadId: workingThreadId,
          terminalId: "term-1",
        }),
      )) as { readonly output: string; readonly terminal: { readonly label: string } };
      expect(result.output).toBe("claude ready\n");
      expect(result.terminal.label).toBe("claude");
    }),
  );

  it.effect("types into a running terminal and submits by default", () =>
    Effect.gen(function* () {
      const harness = makeHarness(DEFAULT_THREADS, {
        snapshots: [
          {
            threadId: workingThreadId,
            terminalId: "term-1",
            cwd: "/tmp/rover",
            worktreePath: null,
            status: "running",
            pid: 42,
            history: "",
            exitCode: null,
            exitSignal: null,
            label: "claude",
            updatedAt: createdAt,
          },
        ],
      });
      yield* runAs(
        ORCHESTRATOR_THREAD_ID,
        harness,
        handleWorkspaceOrchestration({
          action: "write_to_terminal",
          threadId: workingThreadId,
          terminalId: "term-1",
          data: "continue",
        }),
      );
      expect(harness.writes).toEqual([
        { threadId: workingThreadId, terminalId: "term-1", data: "continue\r" },
      ]);
    }),
  );

  it.effect("fails a write to a terminal that is not running", () =>
    Effect.gen(function* () {
      const harness = makeHarness(DEFAULT_THREADS, {
        snapshots: [
          {
            threadId: workingThreadId,
            terminalId: "term-1",
            cwd: "/tmp/rover",
            worktreePath: null,
            status: "exited",
            pid: null,
            history: "",
            exitCode: 0,
            exitSignal: null,
            label: "claude",
            updatedAt: createdAt,
          },
        ],
      });
      const error = yield* Effect.flip(
        runAs(
          ORCHESTRATOR_THREAD_ID,
          harness,
          handleWorkspaceOrchestration({
            action: "write_to_terminal",
            threadId: workingThreadId,
            terminalId: "term-1",
            data: "ls",
          }),
        ),
      );
      expect((error as { readonly _tag: string })._tag).toBe(
        "WorkspaceOrchestrationOperationFailedError",
      );
      expect(harness.writes).toHaveLength(0);
    }),
  );
});
