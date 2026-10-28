import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  VmAgentDelegationId,
  VmAgentId,
  type OrchestrationThreadShell,
  type VmAgent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { VmAgentCollaborationStore } from "../../../persistence/Services/VmAgentCollaborations.ts";
import { VmAgentStore } from "../../../persistence/Services/VmAgents.ts";
import {
  type DelegateVmAgentWorkInput,
  VmAgentCollaboration,
} from "../../../vm/VmAgentCollaboration.ts";
import { VmAgentTaskScheduler } from "../../../vm/VmAgentTaskScheduler.ts";
import { handleAgentCollaboration } from "./handlers.ts";

const sourceAgentId = VmAgentId.make("agent-collaboration-source");
const targetAgentId = VmAgentId.make("agent-collaboration-target");
const sourceThreadId = ThreadId.make("thread-collaboration-source");
const workerThreadId = ThreadId.make("thread-collaboration-worker");
const agentSideChatThreadId = ThreadId.make("thread-collaboration-agent-side-chat");
const plainThreadId = ThreadId.make("thread-collaboration-plain");
const delegationId = VmAgentDelegationId.make("delegation-collaboration-test");
const iso = "2026-08-21T20:00:00.000Z";

const sourceAgent = {
  vmAgentId: sourceAgentId,
  threadId: sourceThreadId,
  controlMode: "agent",
  icon: null,
} as VmAgent;
const delegation = {
  delegationId,
  rootVmAgentId: sourceAgentId,
  sourceVmAgentId: sourceAgentId,
  targetVmAgentId: null,
  status: "running",
} as never;
const receipt = {
  operation: "delegate",
  delegationId,
  status: "queued",
  revision: 1,
  acceptedAt: iso,
} as const;

const invocation = (
  threadId: ThreadId,
  capabilities = new Set<McpInvocationContext.McpCapability>(["collaboration"]),
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-agent-collaboration"),
  threadId,
  providerSessionId: `provider-session:${threadId}`,
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities,
  issuedAt: 1,
});

/** Both the worker and the user's side chat hang off the source agent's chat. */
const sideChatParents = new Map<ThreadId, ThreadId>([
  [workerThreadId, sourceThreadId],
  [agentSideChatThreadId, sourceThreadId],
]);

const makeHarness = () => {
  const delegated: Array<{ readonly source: VmAgentId; readonly input: DelegateVmAgentWorkInput }> =
    [];
  let wakeCount = 0;
  const agentStore = Layer.mock(VmAgentStore)({
    getByThreadId: (threadId) =>
      Effect.succeed(threadId === sourceThreadId ? Option.some(sourceAgent) : Option.none()),
  });
  const collaborationStore = Layer.mock(VmAgentCollaborationStore)({
    getByWorkerThreadId: (threadId) =>
      Effect.succeed(threadId === workerThreadId ? Option.some(delegation) : Option.none()),
  });
  const projection = Layer.mock(ProjectionSnapshotQuery)({
    getThreadShellById: (threadId) =>
      Effect.succeed(
        Option.fromNullishOr(sideChatParents.get(threadId)).pipe(
          Option.map(
            (parent) =>
              ({
                id: threadId,
                isSideChat: true,
                sideChatParentThreadId: parent,
              }) as OrchestrationThreadShell,
          ),
        ),
      ),
  });
  const collaboration = Layer.mock(VmAgentCollaboration)({
    delegate: (source, input) =>
      Effect.sync(() => {
        delegated.push({ source, input });
        return { delegation, receipt } as never;
      }),
    snapshotForAgent: () =>
      Effect.succeed({
        type: "snapshot",
        hasMoreAgents: true,
        hasMoreDelegations: true,
        agents: [
          { vmAgentId: sourceAgentId },
          { vmAgentId: targetAgentId },
          { vmAgentId: VmAgentId.make("unrelated-agent") },
        ],
        delegations: [
          {
            delegation,
            rootAgent: null,
            sourceAgent: null,
            targetAgent: null,
            latestMessage: null,
          },
        ],
      } as never),
    snapshot: () =>
      Effect.succeed({
        type: "snapshot",
        hasMoreAgents: false,
        agents: [{ vmAgentId: sourceAgentId }, { vmAgentId: targetAgentId }],
        delegations: [{ delegation }],
      } as never),
  });
  const scheduler = Layer.mock(VmAgentTaskScheduler)({
    wake: () => Effect.sync(() => void (wakeCount += 1)),
  });
  return {
    delegated,
    wakeCount: () => wakeCount,
    layer: Layer.mergeAll(agentStore, collaborationStore, projection, collaboration, scheduler),
  };
};

type Services =
  | VmAgentStore
  | VmAgentCollaborationStore
  | ProjectionSnapshotQuery
  | VmAgentCollaboration
  | VmAgentTaskScheduler;

const run = <A, E>(
  effect: Effect.Effect<A, E, McpInvocationContext.McpInvocationContext | Services>,
  layer: Layer.Layer<Services>,
  threadId: ThreadId,
) =>
  effect.pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(threadId)),
    Effect.provide(layer),
  );

it.effect("derives the delegation source from the credential-bound VM agent", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const result = yield* run(
      handleAgentCollaboration({
        action: "delegate",
        targetKind: "agent",
        targetVmAgentId: targetAgentId,
        title: "Review state",
        task: "Review the state machine.",
        idempotencyKey: "review-state-v1",
      }),
      harness.layer,
      sourceThreadId,
    );
    assert.strictEqual(result.receipt?.delegationId, delegationId);
    assert.strictEqual(harness.delegated[0]?.source, sourceAgentId);
    assert.deepStrictEqual(harness.delegated[0]?.input.target, {
      kind: "agent",
      vmAgentId: targetAgentId,
    });
    assert.strictEqual(harness.wakeCount(), 1);
  }),
);

it.effect("prevents an ephemeral worker from creating a grandchild", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const error = yield* Effect.flip(
      run(
        handleAgentCollaboration({
          action: "delegate",
          targetKind: "ephemeral",
          title: "Nested work",
          task: "Create another worker.",
          idempotencyKey: "nested-work-v1",
        }),
        harness.layer,
        workerThreadId,
      ),
    );
    assert.strictEqual(error._tag, "AgentCollaborationInvalidInputError");
    assert.strictEqual(harness.delegated.length, 0);
  }),
);

it.effect("limits an ephemeral worker's discovery to its own delegation family", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const result = yield* run(
      handleAgentCollaboration({ action: "list_agents" }),
      harness.layer,
      workerThreadId,
    );
    assert.deepStrictEqual(
      result.agents?.map((agent) => agent.vmAgentId),
      [sourceAgentId],
    );
  }),
);

it.effect("reports bounded agent and work lists to the calling agent", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const agents = yield* run(
      handleAgentCollaboration({ action: "list_agents" }),
      harness.layer,
      sourceThreadId,
    );
    const work = yield* run(
      handleAgentCollaboration({ action: "list_work" }),
      harness.layer,
      sourceThreadId,
    );

    assert.isTrue(agents.hasMoreAgents);
    assert.isTrue(work.hasMoreWork);
  }),
);

it.effect("acts as the owning agent from one of the agent's side chats", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* run(
      handleAgentCollaboration({
        action: "delegate",
        targetKind: "agent",
        targetVmAgentId: targetAgentId,
        title: "Review state",
        task: "Review the state machine.",
        idempotencyKey: "review-state-side-chat",
      }),
      harness.layer,
      agentSideChatThreadId,
    );
    assert.strictEqual(harness.delegated[0]?.source, sourceAgentId);
  }),
);

it.effect("keeps a delegated worker a worker though it is a side chat of the agent", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    // Resolving the worker through its parent would make it the agent, free to
    // create grandchildren.
    const error = yield* Effect.flip(
      run(
        handleAgentCollaboration({
          action: "delegate",
          targetKind: "agent",
          targetVmAgentId: targetAgentId,
          title: "Nested work",
          task: "Hand this on.",
          idempotencyKey: "nested-agent-work",
        }),
        harness.layer,
        workerThreadId,
      ),
    );
    assert.strictEqual(error._tag, "AgentCollaborationInvalidInputError");
    assert.strictEqual(harness.delegated.length, 0);
  }),
);

it.effect("shows any chat the agent roster and points it at workspace_consult", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const result = yield* run(
      handleAgentCollaboration({ action: "list_agents" }),
      harness.layer,
      plainThreadId,
    );
    assert.deepStrictEqual(
      result.agents?.map((agent) => agent.vmAgentId),
      [sourceAgentId, targetAgentId],
    );
    assert.isUndefined(result.work);
    assert.include(result.status, "workspace_consult");

    for (const action of [
      "list_work",
      "delegate",
      "read_work",
      "send_message",
      "cancel",
    ] as const) {
      const error = yield* Effect.flip(
        run(
          handleAgentCollaboration({ action, delegationId, message: "hi" }),
          harness.layer,
          plainThreadId,
        ),
      );
      assert.strictEqual(error._tag, "AgentCollaborationNoActorError");
      assert.include(error.message, "workspace_consult ask");
    }
    assert.strictEqual(harness.delegated.length, 0);
  }),
);
