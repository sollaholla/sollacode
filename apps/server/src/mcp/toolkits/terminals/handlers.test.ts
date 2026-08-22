import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  TerminalSessionLookupError,
  ThreadId,
  type IsoDateTime,
  type OrchestrationThreadShell,
  type TerminalSessionSnapshot,
  type TerminalSummary,
  type TerminalWriteInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { TerminalManager } from "../../../terminal/Manager.ts";
import { handleThreadTerminals } from "./handlers.ts";

const createdAt = "2026-08-19T17:00:00.000Z" as IsoDateTime;
const callerThreadId = ThreadId.make("thread-main");
const otherThreadId = ThreadId.make("thread-other");
const instanceId = ProviderInstanceId.make("grok");

const invocationFor = (
  threadId: ThreadId,
  capabilities = new Set<McpInvocationContext.McpCapability>(["terminals"]),
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-terminals-test"),
  threadId,
  providerSessionId: `provider-session-${threadId}`,
  providerInstanceId: instanceId,
  capabilities,
  issuedAt: 1,
});

const makeTerminalSummary = (overrides: Partial<TerminalSummary> = {}): TerminalSummary => ({
  threadId: callerThreadId,
  terminalId: "term-1",
  cwd: "/tmp/rover",
  worktreePath: null,
  status: "running",
  pid: 42,
  exitCode: null,
  exitSignal: null,
  hasRunningSubprocess: true,
  label: "grok",
  updatedAt: createdAt,
  ...overrides,
});

const makeSnapshot = (
  overrides: Partial<TerminalSessionSnapshot> = {},
): TerminalSessionSnapshot => ({
  threadId: callerThreadId,
  terminalId: "term-1",
  cwd: "/tmp/rover",
  worktreePath: null,
  status: "running",
  pid: 42,
  history: "ready>\n",
  exitCode: null,
  exitSignal: null,
  label: "grok",
  updatedAt: createdAt,
  ...overrides,
});

const makeThread = (id: ThreadId, title: string): OrchestrationThreadShell => ({
  id,
  projectId: ProjectId.make("project-terminals-test"),
  title,
  isSideChat: false,
  sideChatParentThreadId: null,
  modelSelection: { instanceId, model: "grok-4.6" },
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
});

const makeHarness = (
  options: {
    readonly terminals?: ReadonlyArray<TerminalSummary>;
    readonly snapshots?: ReadonlyArray<TerminalSessionSnapshot>;
    readonly threads?: ReadonlyArray<OrchestrationThreadShell>;
  } = {},
) => {
  const writes: Array<TerminalWriteInput> = [];
  const terminals = [...(options.terminals ?? [])];
  const snapshots = new Map(
    (options.snapshots ?? []).map((snapshot) => [
      `${snapshot.threadId}:${snapshot.terminalId}`,
      snapshot,
    ]),
  );

  const threads = options.threads ?? [
    makeThread(callerThreadId, "Update Solla Code"),
    makeThread(otherThreadId, "Other work"),
  ];

  const projectionLayer = Layer.mock(ProjectionSnapshotQuery)({
    getShellSnapshot: () =>
      Effect.sync(() => ({
        snapshotSequence: 0,
        projects: [],
        threads: [...threads],
        updatedAt: createdAt,
      })),
    getThreadShellById: (threadId) =>
      Effect.sync(() => Option.fromNullishOr(threads.find((thread) => thread.id === threadId))),
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

  return { writes, layer: Layer.mergeAll(projectionLayer, terminalLayer) };
};

const runAs = (
  threadId: ThreadId,
  harness: ReturnType<typeof makeHarness>,
  effect: ReturnType<typeof handleThreadTerminals>,
  capabilities?: Set<McpInvocationContext.McpCapability>,
) =>
  effect.pipe(
    Effect.provideService(
      McpInvocationContext.McpInvocationContext,
      invocationFor(threadId, capabilities),
    ),
    Effect.provide(harness.layer),
  );

it.layer(NodeServices.layer)("thread terminals toolkit", (it) => {
  it.effect("refuses a caller without the terminals capability", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const error = yield* Effect.flip(
        runAs(
          callerThreadId,
          harness,
          handleThreadTerminals({ action: "list_terminals" }),
          new Set(),
        ),
      );
      expect((error as { readonly _tag: string })._tag).toBe(
        "ThreadTerminalsCapabilityUnavailableError",
      );
    }),
  );

  it.effect("lists every live terminal when threadId is omitted", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        terminals: [
          makeTerminalSummary(),
          makeTerminalSummary({
            threadId: otherThreadId,
            terminalId: "term-2",
            label: "zsh",
            hasRunningSubprocess: false,
          }),
        ],
        snapshots: [
          makeSnapshot({ history: "Grok 4.6 (xhigh)\nClaude is still not resuming\n" }),
          makeSnapshot({
            threadId: otherThreadId,
            terminalId: "term-2",
            label: "zsh",
            history: "ready>\n",
          }),
        ],
      });
      const result = (yield* runAs(
        callerThreadId,
        harness,
        handleThreadTerminals({ action: "list_terminals" }),
      )) as {
        readonly callerThreadId: string;
        readonly terminals: ReadonlyArray<{
          readonly terminalId: string;
          readonly threadTitle: string;
          readonly belongsToThisChat: boolean;
          readonly preview: string;
        }>;
      };
      expect(result.callerThreadId).toBe(callerThreadId);
      expect(result.terminals.map((terminal) => terminal.terminalId)).toEqual(["term-1", "term-2"]);
      expect(result.terminals[0]).toMatchObject({
        threadTitle: "Update Solla Code",
        belongsToThisChat: true,
        preview: expect.stringContaining("Claude is still not resuming"),
      });
      expect(result.terminals[1]).toMatchObject({
        threadTitle: "Other work",
        belongsToThisChat: false,
      });
    }),
  );

  it.effect("reads the calling thread's only terminal without an explicit id", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        terminals: [makeTerminalSummary()],
        snapshots: [makeSnapshot({ history: "hello from grok\n" })],
      });
      const result = (yield* runAs(
        callerThreadId,
        harness,
        handleThreadTerminals({ action: "read_terminal" }),
      )) as {
        readonly output: string;
        readonly terminal: { readonly label: string; readonly threadTitle: string };
      };
      expect(result.output).toContain("hello from grok");
      expect(result.terminal.label).toBe("grok");
      expect(result.terminal.threadTitle).toBe("Update Solla Code");
    }),
  );

  it.effect("types into a running terminal and submits by default", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        terminals: [makeTerminalSummary()],
        snapshots: [makeSnapshot()],
      });
      const result = (yield* runAs(
        callerThreadId,
        harness,
        handleThreadTerminals({
          action: "write_to_terminal",
          terminalId: "term-1",
          data: "continue",
        }),
      )) as { readonly written: boolean; readonly submitted: boolean };
      expect(result).toEqual({
        action: "write_to_terminal",
        threadId: callerThreadId,
        terminalId: "term-1",
        written: true,
        submitted: true,
      });
      expect(harness.writes).toEqual([
        { threadId: callerThreadId, terminalId: "term-1", data: "continue\r" },
      ]);
    }),
  );

  it.effect("fails a write to a terminal that is not running", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        terminals: [makeTerminalSummary({ status: "exited" })],
        snapshots: [makeSnapshot({ status: "exited" })],
      });
      const error = yield* Effect.flip(
        runAs(
          callerThreadId,
          harness,
          handleThreadTerminals({
            action: "write_to_terminal",
            terminalId: "term-1",
            data: "continue",
          }),
        ),
      );
      expect((error as { readonly _tag: string })._tag).toBe("ThreadTerminalsOperationFailedError");
      expect(harness.writes).toEqual([]);
    }),
  );
});
