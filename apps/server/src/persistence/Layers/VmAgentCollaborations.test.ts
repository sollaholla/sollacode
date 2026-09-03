import {
  DEFAULT_VM_AGENT_DELEGATION_LIMITS,
  MessageId,
  ThreadId,
  VM_AGENT_COLLABORATION_LIST_LIMIT,
  VM_AGENT_DELEGATION_OUTPUT_PREVIEW_MAX_LENGTH,
  VM_AGENT_DELEGATION_TASK_PREVIEW_MAX_LENGTH,
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
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

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
      icon: null,
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
  it.effect("returns a 501st truncation sentinel while prioritizing active work", () =>
    Effect.gen(function* () {
      const collaboration = yield* VmAgentCollaborationStore;
      const sql = yield* SqlClient.SqlClient;
      const agent = yield* insertAgent("snapshot-sentinel");
      yield* Effect.forEach(
        Array.from({ length: VM_AGENT_COLLABORATION_LIST_LIMIT }, (_, index) => index),
        (index) => {
          const work = makeDelegation(agent, `snapshot-terminal-${index}`, laterAt);
          return collaboration.create({
            ...work,
            delegation: {
              ...work.delegation,
              status: "completed",
              startedAt: laterAt,
              completedAt: laterAt,
              result: {
                summary: "Completed before the active handoff.",
                completedBy: "ephemeral-worker",
                completedAt: laterAt,
              },
            },
            idempotencyKey: `snapshot-terminal-request-${index}`,
            schedulerVmAgentId: agent.vmAgentId,
          });
        },
        { discard: true },
      );
      const active = makeDelegation(agent, "snapshot-active", createdAt);
      yield* collaboration.create({
        ...active,
        idempotencyKey: "snapshot-active-request",
        schedulerVmAgentId: agent.vmAgentId,
      });

      const fullRows = yield* collaboration.list();
      const compactRows = yield* collaboration.listSummaries();
      assert.lengthOf(fullRows, VM_AGENT_COLLABORATION_LIST_LIMIT + 1);
      assert.lengthOf(compactRows, VM_AGENT_COLLABORATION_LIST_LIMIT + 1);
      assert.strictEqual(fullRows[0]?.delegationId, active.delegation.delegationId);
      assert.strictEqual(compactRows[0]?.delegationId, active.delegation.delegationId);
      // These synthetic rows exist only to prove the 501st sentinel. Retire
      // their task carriers so this shared in-memory layer cannot leak due work
      // into the scheduler serialization case below.
      yield* sql`UPDATE vm_agent_tasks SET status = 'completed', next_run_at = NULL
        WHERE vm_agent_id = ${agent.vmAgentId}`;
    }),
  );

  it.effect("projects bounded list rows before decoding full payload columns", () =>
    Effect.gen(function* () {
      const collaboration = yield* VmAgentCollaborationStore;
      const sql = yield* SqlClient.SqlClient;
      const agent = yield* insertAgent("compact-list");
      const work = makeDelegation(agent, "compact-list", createdAt);
      yield* collaboration.create({
        ...work,
        idempotencyKey: "compact-list-request",
        schedulerVmAgentId: agent.vmAgentId,
      });

      const oversizedIdentity = {
        ...work.delegation.rootAgentSnapshot,
        purpose: `${"P".repeat(3_000)}hidden-purpose-tail`,
      };
      const oversizedTask = `${"T".repeat(60_000)}hidden-task-tail`;
      const oversizedResult = `${"R".repeat(25_000)}hidden-result-tail`;
      const oversizedError = `${"E".repeat(5_000)}hidden-error-tail`;
      yield* sql`UPDATE vm_agent_delegations SET
        task = ${oversizedTask},
        root_agent_snapshot_json = ${encodeUnknownJson(oversizedIdentity)},
        source_agent_snapshot_json = ${encodeUnknownJson(oversizedIdentity)},
        result_json = ${encodeUnknownJson({
          summary: oversizedResult,
          completedBy: "ephemeral-worker",
          completedAt: laterAt,
        })},
        error = ${oversizedError}
        WHERE delegation_id = ${work.delegation.delegationId}`;

      const summaries = yield* collaboration.listSummaries();
      const summary = summaries.find(
        (candidate) => candidate.delegationId === work.delegation.delegationId,
      );
      assert.isDefined(summary);
      assert.lengthOf(summary.taskPreview.text, VM_AGENT_DELEGATION_TASK_PREVIEW_MAX_LENGTH);
      assert.isTrue(summary.taskPreview.truncated);
      assert.lengthOf(
        summary.resultPreview?.text ?? "",
        VM_AGENT_DELEGATION_OUTPUT_PREVIEW_MAX_LENGTH,
      );
      assert.isTrue(summary.resultPreview?.truncated);
      assert.lengthOf(
        summary.errorPreview?.text ?? "",
        VM_AGENT_DELEGATION_OUTPUT_PREVIEW_MAX_LENGTH,
      );
      assert.isTrue(summary.errorPreview?.truncated);
      assert.notInclude(summary.taskPreview.text, "hidden-task-tail");
      assert.notInclude(summary.resultPreview?.text ?? "", "hidden-result-tail");
      assert.notInclude(summary.errorPreview?.text ?? "", "hidden-error-tail");
      assert.notProperty(summary.rootAgentSnapshot, "purpose");
      assert.notProperty(summary.sourceAgentSnapshot, "purpose");

      const scoped = yield* collaboration.listSummariesForAgent(agent.vmAgentId);
      assert.deepInclude(scoped, summary);
      yield* collaboration.cancel({
        delegationId: work.delegation.delegationId,
        status: "cancelled",
        detail: "Compact projection test complete.",
        completedAt: laterAt,
      });
    }),
  );

  it.effect("pages messages newest-first at SQL and returns each page chronologically", () =>
    Effect.gen(function* () {
      const collaboration = yield* VmAgentCollaborationStore;
      const agent = yield* insertAgent("message-page");
      const work = makeDelegation(agent, "message-page", createdAt);
      yield* collaboration.create({
        ...work,
        idempotencyKey: "message-page-request",
        schedulerVmAgentId: agent.vmAgentId,
      });
      yield* Effect.forEach([2, 3, 4, 5, 6], (sequence) =>
        collaboration.appendMessage({
          messageId: VmAgentDelegationMessageId.make(
            `delegation-message:${work.delegation.delegationId}:${sequence}`,
          ),
          delegationId: work.delegation.delegationId,
          sender: "source-agent",
          senderVmAgentId: agent.vmAgentId,
          kind: "note",
          delivery: "delivered",
          text: `Message ${sequence}`,
          createdAt: laterAt,
          incrementFollowup: false,
        }),
      );

      const newest = yield* collaboration.listMessagesPage(work.delegation.delegationId, null, 2);
      assert.deepStrictEqual(
        newest.messages.map((message) => message.sequence),
        [5, 6],
      );
      assert.isTrue(newest.hasEarlierMessages);

      const middle = yield* collaboration.listMessagesPage(
        work.delegation.delegationId,
        newest.messages[0]?.sequence ?? null,
        2,
      );
      assert.deepStrictEqual(
        middle.messages.map((message) => message.sequence),
        [3, 4],
      );
      assert.isTrue(middle.hasEarlierMessages);

      const oldest = yield* collaboration.listMessagesPage(
        work.delegation.delegationId,
        middle.messages[0]?.sequence ?? null,
        2,
      );
      assert.deepStrictEqual(
        oldest.messages.map((message) => message.sequence),
        [1, 2],
      );
      assert.isFalse(oldest.hasEarlierMessages);

      const fullHistory = yield* collaboration.listMessages(work.delegation.delegationId);
      assert.deepStrictEqual(
        fullHistory.map((message) => message.sequence),
        [1, 2, 3, 4, 5, 6],
      );
      yield* collaboration.cancel({
        delegationId: work.delegation.delegationId,
        status: "cancelled",
        detail: "Message pagination test complete.",
        completedAt: laterAt,
      });
    }),
  );

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
