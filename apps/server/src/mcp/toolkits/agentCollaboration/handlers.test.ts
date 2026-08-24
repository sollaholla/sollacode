import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  VmAgentDelegationId,
  VmAgentId,
  type VmAgent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
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
const delegationId = VmAgentDelegationId.make("delegation-collaboration-test");
const iso = "2026-08-21T20:00:00.000Z";

const sourceAgent = {
  vmAgentId: sourceAgentId,
  threadId: sourceThreadId,
  controlMode: "agent",
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

const makeHarness = (actor: "agent" | "worker") => {
  const delegated: Array<{ readonly source: VmAgentId; readonly input: DelegateVmAgentWorkInput }> =
    [];
  let wakeCount = 0;
  const agentStore = Layer.mock(VmAgentStore)({
    getByThreadId: (threadId) =>
      Effect.succeed(
        actor === "agent" && threadId === sourceThreadId ? Option.some(sourceAgent) : Option.none(),
      ),
  });
  const collaborationStore = Layer.mock(VmAgentCollaborationStore)({
    getByWorkerThreadId: (threadId) =>
      Effect.succeed(
        actor === "worker" && threadId === workerThreadId ? Option.some(delegation) : Option.none(),
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
  });
  const scheduler = Layer.mock(VmAgentTaskScheduler)({
    wake: () => Effect.sync(() => void (wakeCount += 1)),
  });
  return {
    delegated,
    wakeCount: () => wakeCount,
    layer: Layer.mergeAll(agentStore, collaborationStore, collaboration, scheduler),
  };
};

type Services =
  | VmAgentStore
  | VmAgentCollaborationStore
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
    const harness = makeHarness("agent");
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
    const harness = makeHarness("worker");
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
    const harness = makeHarness("worker");
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
    const harness = makeHarness("agent");
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
