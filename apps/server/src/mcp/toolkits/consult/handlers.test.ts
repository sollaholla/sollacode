import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  VmAgent,
  VmAgentId,
  VmId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { VmAgentStore } from "../../../persistence/Services/VmAgents.ts";
import { handleWorkspaceConsult } from "./handlers.ts";

const agentThreadId = ThreadId.make("thread-scout");
const inheritedBrowserProfileThreadId = ThreadId.make("thread-browser-root");
const medicalThreadId = ThreadId.make("thread-medical");
const medicalProjectId = ProjectId.make("project-medical");

const invocation = (
  capabilities = new Set<McpInvocationContext.McpCapability>(["vm"]),
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("env-consult-test"),
  threadId: agentThreadId,
  providerSessionId: "provider-session-scout",
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
  projectId: ProjectId.make("solla-agents"),
  title: "Scout",
});

const completedTurn = {
  turnId: TurnId.make("turn-1"),
  state: "completed",
  requestedAt: iso,
  startedAt: iso,
  completedAt: iso,
  assistantMessageId: MessageId.make("m-2"),
};

const makeHarness = (options: {
  readonly boundAgent?: VmAgent | null;
  readonly threads?: ReadonlyArray<unknown>;
  readonly shellById?: unknown;
  readonly messages?: ReadonlyArray<unknown>;
}) => {
  const commands: OrchestrationCommand[] = [];
  const storeLayer = Layer.mock(VmAgentStore)({
    getByThreadId: () =>
      Effect.succeed(
        options.boundAgent === null ? Option.none() : Option.some(options.boundAgent ?? agent),
      ),
  });
  const projectionLayer = Layer.mock(ProjectionSnapshotQuery)({
    getShellSnapshot: () =>
      Effect.succeed({
        snapshotSequence: 1,
        projects: [projectShell],
        threads: options.threads ?? [threadShell(), agentThreadShell],
        updatedAt: iso,
      } as never),
    getThreadShellById: () =>
      Effect.succeed(
        options.shellById === undefined ? Option.none() : Option.some(options.shellById as never),
      ),
    getThreadDetailById: () =>
      Effect.succeed(
        Option.some({
          messages: options.messages ?? [],
          proposedPlans: [],
          taskTitle: null,
        } as never),
      ),
  });
  const engineLayer = Layer.mock(OrchestrationEngineService)({
    dispatch: (command: OrchestrationCommand) =>
      Effect.sync(() => {
        commands.push(command);
      }) as never,
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
    layer: Layer.mergeAll(storeLayer, projectionLayer, engineLayer, cryptoLayer),
  };
};

type ConsultServices =
  | VmAgentStore
  | ProjectionSnapshotQuery
  | OrchestrationEngineService
  | Crypto.Crypto;

const run = <A, E>(
  effect: Effect.Effect<A, E, McpInvocationContext.McpInvocationContext | ConsultServices>,
  layer: Layer.Layer<ConsultServices>,
  capabilities?: Set<McpInvocationContext.McpCapability>,
) =>
  effect.pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
    Effect.provide(layer),
  );

it.effect("refuses a chat that is not a VM agent", () =>
  Effect.gen(function* () {
    const { layer } = makeHarness({ boundAgent: null });
    const error = yield* Effect.flip(
      run(handleWorkspaceConsult({ action: "list_projects" }), layer),
    );
    assert.strictEqual(error._tag, "WorkspaceConsultNotAnAgentError");
  }),
);

it.effect("refuses a call without the vm capability", () =>
  Effect.gen(function* () {
    const { layer } = makeHarness({});
    const error = yield* Effect.flip(
      run(handleWorkspaceConsult({ action: "list_projects" }), layer, new Set(["terminals"])),
    );
    assert.strictEqual(error._tag, "WorkspaceConsultUnavailableError");
  }),
);

it.effect("lists projects the agent can consult", () =>
  Effect.gen(function* () {
    const { layer } = makeHarness({});
    const result = yield* run(handleWorkspaceConsult({ action: "list_projects" }), layer);
    assert.deepStrictEqual(
      result.projects?.map((project) => project.title),
      ["Example Studio"],
    );
    assert.strictEqual(result.projects?.[0]?.threadCount, 1);
  }),
);

it.effect("never offers the agent its own thread to talk to", () =>
  Effect.gen(function* () {
    const { layer } = makeHarness({});
    const result = yield* run(handleWorkspaceConsult({ action: "list_threads" }), layer);
    const ids = result.threads?.map((thread) => thread.threadId) ?? [];
    assert.deepStrictEqual(ids, [medicalThreadId]);
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
    const result = yield* run(
      handleWorkspaceConsult({
        action: "ask",
        projectId: medicalProjectId,
        question: "Does Example Studio gate exports behind a licence check?",
        waitMs: 0,
      }),
      layer,
    );

    if (result.action !== "ask") return assert.fail("expected an ask result");
    const created = commands.find((command) => command.type === "thread.create");
    const started = commands.find((command) => command.type === "thread.turn.start");
    assert.isDefined(created);
    assert.isDefined(started);
    // The new conversation belongs to the consulted project, not the agent's.
    assert.strictEqual(created.projectId, medicalProjectId);
    assert.strictEqual(created.createdByThreadId, agentThreadId);
    assert.strictEqual(created.browserProfileThreadId, inheritedBrowserProfileThreadId);
    assert.strictEqual(
      (started as { message: { text: string } }).message.text,
      "Does Example Studio gate exports behind a licence check?",
    );
    // Nothing answered yet, so the agent is handed the thread to poll.
    assert.strictEqual(result.answered, false);
    assert.isDefined(result.threadId);
  }),
);

it.effect("returns the reply once the consulted thread has answered", () =>
  Effect.gen(function* () {
    const { layer } = makeHarness({
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
        {
          id: MessageId.make("m-2"),
          role: "assistant",
          text: "Yes — exports check the licence flag before rendering.",
          turnId: TurnId.make("turn-1"),
          streaming: false,
          createdAt: iso,
          updatedAt: iso,
        },
      ],
    });
    const result = yield* run(
      handleWorkspaceConsult({
        action: "ask",
        threadId: medicalThreadId,
        question: "Does Example Studio gate exports?",
        waitMs: 5_000,
      }),
      layer,
    );
    if (result.action !== "ask") return assert.fail("expected an ask result");
    assert.strictEqual(result.answered, true);
    assert.strictEqual(result.answer, "Yes — exports check the licence flag before rendering.");
  }),
);

it.effect("does not mistake a previous turn's reply for an answer", () =>
  Effect.gen(function* () {
    // The thread already carries a settled turn and an assistant message from a
    // question nobody just asked. Waiting must not hand that back as the answer.
    const { layer } = makeHarness({
      threads: [threadShell({ latestTurn: completedTurn })],
      shellById: threadShell({ latestTurn: completedTurn }),
      messages: [
        {
          id: MessageId.make("m-2"),
          role: "assistant",
          text: "An older answer about something else.",
          turnId: TurnId.make("turn-1"),
          streaming: false,
          createdAt: iso,
          updatedAt: iso,
        },
      ],
    });
    const result = yield* run(
      handleWorkspaceConsult({
        action: "ask",
        threadId: medicalThreadId,
        question: "A brand new question",
        waitMs: 0,
      }),
      layer,
    );
    if (result.action !== "ask") return assert.fail("expected an ask result");
    assert.strictEqual(result.answered, false);
    assert.isUndefined(result.answer);
  }),
);
