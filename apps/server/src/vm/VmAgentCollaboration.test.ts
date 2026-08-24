import {
  DEFAULT_VM_AGENT_DELEGATION_LIMITS,
  VM_AGENT_COLLABORATION_LIST_LIMIT,
  VM_AGENT_DELEGATION_OUTPUT_PREVIEW_MAX_LENGTH,
  VM_AGENT_DELEGATION_TASK_PREVIEW_MAX_LENGTH,
  type VmAgentCollaborationAgentSummary,
  type VmAgentDelegation,
  type VmAgentLegacyDelegationSummary,
  VmAgentDelegationId,
  VmAgentDelegationListItem,
  VmAgentId,
  VmAgentTaskId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeBuffer from "node:buffer";
import * as Schema from "effect/Schema";

import {
  boundedCollaborationSnapshot,
  boundedDelegationPreview,
  boundedLegacyCollaborationSnapshot,
  collaborationSubscriptionMode,
  collaborationSnapshotPage,
  delegationDetailMessageLimit,
  delegationListItem,
  delegationSummary,
  VM_AGENT_COLLABORATION_SNAPSHOT_MAX_BYTES,
} from "./VmAgentCollaboration.ts";

const iso = "2026-08-24T16:00:00.000Z";
const agentId = VmAgentId.make("compact-summary-agent");
const decodeDelegationListItem = Schema.decodeUnknownSync(VmAgentDelegationListItem);

const makeDelegation = (): VmAgentDelegation => {
  const delegationId = VmAgentDelegationId.make("compact-summary-delegation");
  const identity = {
    vmAgentId: agentId,
    name: "Compact summary agent",
    handle: "compact-summary-agent",
    purpose: `Purpose must not be repeated in every list row ${"P".repeat(1_900)}`,
  };
  return {
    delegationId,
    rootVmAgentId: agentId,
    sourceVmAgentId: agentId,
    rootDelegationId: null,
    parentDelegationId: null,
    depth: 1,
    target: { kind: "ephemeral", label: "One-off helper" },
    targetVmAgentId: null,
    workerThreadId: null,
    rootAgentSnapshot: identity,
    sourceAgentSnapshot: identity,
    targetAgentSnapshot: null,
    taskId: VmAgentTaskId.make(`delegation-task:${delegationId}`),
    runId: null,
    title: "Audit a large request",
    task: "T".repeat(50_000),
    completionCriteria: ["Return a focused result"],
    requestedCapabilities: ["workspace.consult"],
    status: "completed",
    followupCount: 2,
    messageCount: 5,
    effectiveLimits: DEFAULT_VM_AGENT_DELEGATION_LIMITS,
    revision: 3,
    createdAt: iso,
    startedAt: iso,
    completedAt: iso,
    expiresAt: iso,
    updatedAt: iso,
    result: {
      summary: "R".repeat(20_000),
      completedBy: "ephemeral-worker",
      completedAt: iso,
    },
    error: "E".repeat(4_000),
  };
};

const makeAgentSummary = (delegation: VmAgentDelegation): VmAgentCollaborationAgentSummary => ({
  vmAgentId: agentId,
  name: delegation.sourceAgentSnapshot.name,
  handle: delegation.sourceAgentSnapshot.handle,
  purpose: delegation.sourceAgentSnapshot.purpose,
  status: "running",
  controlMode: "agent",
  availability: "available",
  capabilities: ["workspace.consult", "browser.preview"],
  providerInstanceId: null,
  model: "large-model-name",
  activeDelegations: 1,
  canReceiveDelegation: true,
});

it("bounds delegation snapshot fields and omits full work payloads", () => {
  const delegation = makeDelegation();
  const item = delegationListItem(delegation);
  const liveAgent = makeAgentSummary(delegation);
  const summary = delegationSummary(delegation, new Map([[agentId, liveAgent]]));

  assert.lengthOf(item.taskPreview.text, VM_AGENT_DELEGATION_TASK_PREVIEW_MAX_LENGTH);
  assert.isTrue(item.taskPreview.truncated);
  assert.lengthOf(item.resultPreview?.text ?? "", VM_AGENT_DELEGATION_OUTPUT_PREVIEW_MAX_LENGTH);
  assert.isTrue(item.resultPreview?.truncated);
  assert.lengthOf(item.errorPreview?.text ?? "", VM_AGENT_DELEGATION_OUTPUT_PREVIEW_MAX_LENGTH);
  assert.isTrue(item.errorPreview?.truncated);
  assert.notProperty(item, "task");
  assert.notProperty(item, "completionCriteria");
  assert.notProperty(item, "requestedCapabilities");
  assert.notProperty(item, "effectiveLimits");
  assert.notProperty(item, "result");
  assert.notProperty(item, "error");
  assert.notProperty(item.rootAgentSnapshot, "purpose");
  assert.notProperty(summary.sourceAgent ?? {}, "purpose");
  assert.notProperty(summary.sourceAgent ?? {}, "capabilities");
  assert.notProperty(summary.sourceAgent ?? {}, "model");
  assert.isBelow(JSON.stringify(item).length, 5_000);
  assert.deepStrictEqual(decodeDelegationListItem(item), item);
});

it("leaves short previews intact and does not split a surrogate pair", () => {
  assert.deepStrictEqual(boundedDelegationPreview("short", 10), {
    text: "short",
    truncated: false,
  });
  assert.deepStrictEqual(boundedDelegationPreview("aaaa😀tail", 6), {
    text: "aaaa…",
    truncated: true,
  });
});

it("keeps compact and legacy snapshot items below the WebSocket byte cap", () => {
  const delegation = makeDelegation();
  const liveAgent = makeAgentSummary(delegation);
  const compactSummary = delegationSummary(delegation, new Map([[agentId, liveAgent]]));
  const legacySummary: VmAgentLegacyDelegationSummary = {
    delegation,
    rootAgent: liveAgent,
    sourceAgent: liveAgent,
    targetAgent: null,
    latestMessage: null,
  };
  const compact = boundedCollaborationSnapshot(
    Array.from({ length: 1_200 }, () => liveAgent),
    Array.from({ length: 1_200 }, () => compactSummary),
  );
  const legacy = boundedLegacyCollaborationSnapshot(
    [],
    Array.from({ length: 40 }, () => legacySummary),
  );

  assert.isAtMost(
    NodeBuffer.Buffer.byteLength(JSON.stringify(compact), "utf8") + 512,
    VM_AGENT_COLLABORATION_SNAPSHOT_MAX_BYTES + 512,
  );
  assert.isAtMost(
    NodeBuffer.Buffer.byteLength(JSON.stringify(legacy), "utf8") + 512,
    VM_AGENT_COLLABORATION_SNAPSHOT_MAX_BYTES + 512,
  );
  assert.isTrue(compact.hasMoreAgents);
  assert.isTrue(compact.hasMoreDelegations);
  assert.isAbove(compact.delegations.length, 0);
  assert.isTrue(legacy.hasMoreDelegations);
  assert.isAbove(legacy.delegations.length, 0);
});

it("preserves legacy subscribe and 200-message detail defaults until a client opts in", () => {
  assert.strictEqual(collaborationSubscriptionMode(undefined), "legacy");
  assert.strictEqual(collaborationSubscriptionMode(true), "compact");
  assert.strictEqual(delegationDetailMessageLimit(undefined), 200);
  assert.strictEqual(delegationDetailMessageLimit(true), 40);
});

it("uses the 501st prioritized row as a truncation sentinel", () => {
  const rows = Array.from({ length: VM_AGENT_COLLABORATION_LIST_LIMIT + 1 }, (_, index) => index);
  const page = collaborationSnapshotPage(rows);

  assert.lengthOf(page.rows, VM_AGENT_COLLABORATION_LIST_LIMIT);
  assert.isTrue(page.hasMore);
  assert.strictEqual(page.rows[0], 0);
  assert.strictEqual(page.rows.at(-1), VM_AGENT_COLLABORATION_LIST_LIMIT - 1);
});
