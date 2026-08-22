import {
  DEFAULT_VM_AGENT_DELEGATION_LIMITS,
  MessageId,
  ThreadId,
  type VmAgent,
  type VmAgentDelegation,
  type VmAgentDelegationMessage,
  VmAgentDelegationId,
  VmAgentDelegationMessageId,
  VmAgentId,
  VmAgentTaskId,
  VmAgentTaskRunId,
  VmId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { VmAgentStoreLive } from "./VmAgents.ts";
import { VmAgentCollaborationStoreLive } from "./VmAgentCollaborations.ts";
import { VmAgentWorkspaceStoreLive } from "./VmAgentWorkspaces.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { VmAgentStore } from "../Services/VmAgents.ts";
import { VmAgentCollaborationStore } from "../Services/VmAgentCollaborations.ts";
import { VmAgentWorkspaceStore } from "../Services/VmAgentWorkspaces.ts";

const stores = Layer.mergeAll(
  VmAgentStoreLive,
  VmAgentCollaborationStoreLive,
  VmAgentWorkspaceStoreLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));
const layer = it.layer(stores);
const createdAt = "2026-08-21T20:00:00.000Z";
const laterAt = "2026-08-21T20:01:00.000Z";
const claimAt = "2026-08-21T20:02:00.000Z";

const insertAgent = (suffix: string) =>
  Effect.gen(function* () {
    const store = yield* VmAgentStore;
    const agent: VmAgent = {
      vmAgentId: VmAgentId.make(`collaboration-source-${suffix}`),
      name: `Collaboration Source ${suffix}`,
      handle: `collaboration-source-${suffix}`,
      purpose: "Delegate focused work",
      vmId: VmId.make(`collaboration-source-vm-${suffix}`),
      threadId: ThreadId.make(`collaboration-source-thread-${suffix}`),
      status: "running",
      controlMode: "agent",
      guestIp: "127.0.0.1",
      lastError: null,
      createdAt,
      updatedAt: createdAt,
    };
    yield* store.insert(agent);
    return agent;
  });

const makeDelegation = (
  agent: VmAgent,
  suffix: string,
  timestamp: string,
): {
  readonly delegation: VmAgentDelegation;
  readonly initialMessage: VmAgentDelegationMessage;
} => {
  const delegationId = VmAgentDelegationId.make(`delegation-${suffix}`);
  const snapshot = {
    vmAgentId: agent.vmAgentId,
    name: agent.name,
    handle: agent.handle,
    purpose: agent.purpose,
  };
  const delegation: VmAgentDelegation = {
    delegationId,
    rootVmAgentId: agent.vmAgentId,
    sourceVmAgentId: agent.vmAgentId,
    rootDelegationId: null,
    parentDelegationId: null,
    depth: 1,
    target: { kind: "ephemeral", label: `Worker ${suffix}` },
    targetVmAgentId: null,
    workerThreadId: null,
    rootAgentSnapshot: snapshot,
    sourceAgentSnapshot: snapshot,
    targetAgentSnapshot: null,
    taskId: VmAgentTaskId.make(`delegation-task:${delegationId}`),
    runId: null,
    title: `Delegation ${suffix}`,
    task: `Complete delegated work ${suffix}.`,
    completionCriteria: ["Report the result"],
    requestedCapabilities: ["workspace.consult"],
    status: "queued",
    followupCount: 0,
    messageCount: 1,
    effectiveLimits: DEFAULT_VM_AGENT_DELEGATION_LIMITS,
    revision: 1,
    createdAt: timestamp,
    startedAt: null,
    completedAt: null,
    expiresAt: "2026-08-21T20:30:00.000Z",
    updatedAt: timestamp,
    result: null,
    error: null,
  };
  return {
    delegation,
    initialMessage: {
      messageId: VmAgentDelegationMessageId.make(`delegation-message:${delegationId}:1`),
      delegationId,
      sequence: 1,
      sender: "source-agent",
      senderVmAgentId: agent.vmAgentId,
      kind: "note",
      delivery: "pending",
      text: delegation.task,
      createdAt: timestamp,
    },
  };
};

layer("VmAgentCollaborationStore", (it) => {
  it.effect("serializes two ephemeral delegations through the source scheduler slot", () =>
    Effect.gen(function* () {
      const collaboration = yield* VmAgentCollaborationStore;
      const workspace = yield* VmAgentWorkspaceStore;
      const agent = yield* insertAgent("serialization");
      const first = makeDelegation(agent, "first", createdAt);
      const second = makeDelegation(agent, "second", laterAt);
      yield* collaboration.create({
        ...first,
        idempotencyKey: "first-request",
        schedulerVmAgentId: agent.vmAgentId,
      });
      yield* collaboration.create({
        ...second,
        idempotencyKey: "second-request",
        schedulerVmAgentId: agent.vmAgentId,
      });

      const firstClaim = yield* workspace.claimNextDue({
        runId: VmAgentTaskRunId.make("delegation-run-first"),
        now: claimAt,
      });
      assert.isTrue(Option.isSome(firstClaim));
      assert.strictEqual(Option.getOrThrow(firstClaim).task.taskId, first.delegation.taskId);

      const whileActive = yield* workspace.claimNextDue({
        runId: VmAgentTaskRunId.make("delegation-run-blocked"),
        now: claimAt,
      });
      assert.isTrue(Option.isNone(whileActive));

      yield* workspace.completeRun({
        runId: Option.getOrThrow(firstClaim).run.runId,
        status: "completed",
        turnId: "delegation-turn-first",
        resultSummary: "Done",
        error: null,
        completedAt: claimAt,
      });
      const secondClaim = yield* workspace.claimNextDue({
        runId: VmAgentTaskRunId.make("delegation-run-second"),
        now: claimAt,
      });
      assert.isTrue(Option.isSome(secondClaim));
      assert.strictEqual(Option.getOrThrow(secondClaim).task.taskId, second.delegation.taskId);
    }),
  );

  it.effect("re-arms one pending follow-up after the current one-shot run settles", () =>
    Effect.gen(function* () {
      const collaboration = yield* VmAgentCollaborationStore;
      const workspace = yield* VmAgentWorkspaceStore;
      const agent = yield* insertAgent("followup");
      const work = makeDelegation(agent, "followup", createdAt);
      yield* collaboration.create({
        ...work,
        idempotencyKey: "followup-request",
        schedulerVmAgentId: agent.vmAgentId,
      });
      const firstClaim = Option.getOrThrow(
        yield* workspace.claimNextDue({
          runId: VmAgentTaskRunId.make("delegation-run-followup-first"),
          now: claimAt,
        }),
      );
      yield* collaboration.markRunClaimed({
        taskId: firstClaim.task.taskId,
        runId: firstClaim.run.runId,
        updatedAt: claimAt,
      });
      yield* workspace.setRunBooting(firstClaim.run.runId, claimAt);
      yield* workspace.setRunRunning({
        runId: firstClaim.run.runId,
        messageId: MessageId.make("delegation-followup-first-message"),
        startedAt: claimAt,
      });
      yield* collaboration.markRunning({
        runId: firstClaim.run.runId,
        messageId: MessageId.make("delegation-followup-first-message"),
        startedAt: claimAt,
      });
      yield* collaboration.appendMessage({
        messageId: VmAgentDelegationMessageId.make("delegation-followup-message"),
        delegationId: work.delegation.delegationId,
        sender: "source-agent",
        senderVmAgentId: agent.vmAgentId,
        kind: "note",
        delivery: "pending",
        text: "Check the remaining edge case.",
        createdAt: claimAt,
        incrementFollowup: true,
        nextStatus: "queued",
      });

      yield* workspace.completeRun({
        runId: firstClaim.run.runId,
        status: "completed",
        turnId: "delegation-followup-first-turn",
        resultSummary: "Initial work done",
        error: null,
        completedAt: claimAt,
      });
      yield* collaboration.requeuePendingFollowup({
        delegationId: work.delegation.delegationId,
        updatedAt: claimAt,
      });

      const followup = yield* workspace.claimNextDue({
        runId: VmAgentTaskRunId.make("delegation-run-followup-second"),
        now: claimAt,
      });
      assert.isTrue(Option.isSome(followup));
      assert.strictEqual(Option.getOrThrow(followup).task.taskId, work.delegation.taskId);
      const duplicate = yield* workspace.claimNextDue({
        runId: VmAgentTaskRunId.make("delegation-run-followup-duplicate"),
        now: claimAt,
      });
      assert.isTrue(Option.isNone(duplicate));
    }),
  );
});
