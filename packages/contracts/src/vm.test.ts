import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_VM_AGENT_DELEGATION_LIMITS,
  VmAgentCollaborationAgentSummary,
  VmAgentCollaborationSubscribeInput,
  VmAgentCollaborationWireStreamItem,
  VmAgentDelegationId,
  VmAgentDelegationRef,
  VmAgentLegacyDelegationSummary,
} from "./vm.ts";

const createdAt = "2026-08-24T16:00:00.000Z";
const delegationId = "rolling-upgrade-delegation";
const vmAgentId = "rolling-upgrade-agent";
const agent = {
  vmAgentId,
  name: "Rolling upgrade agent",
  handle: "rolling-upgrade-agent",
  purpose: "Proves old and new collaboration clients can overlap during a release.",
  status: "running",
  controlMode: "agent",
  availability: "available",
  capabilities: ["workspace.consult"],
  providerInstanceId: null,
  model: null,
  activeDelegations: 1,
  canReceiveDelegation: true,
};
const identity = {
  vmAgentId,
  name: agent.name,
  handle: agent.handle,
  purpose: agent.purpose,
};
const legacySummary = {
  delegation: {
    delegationId,
    rootVmAgentId: vmAgentId,
    sourceVmAgentId: vmAgentId,
    rootDelegationId: null,
    parentDelegationId: null,
    depth: 1,
    target: { kind: "ephemeral", label: "One-off helper" },
    targetVmAgentId: null,
    workerThreadId: null,
    rootAgentSnapshot: identity,
    sourceAgentSnapshot: identity,
    targetAgentSnapshot: null,
    taskId: `delegation-task:${delegationId}`,
    runId: null,
    title: "Rolling upgrade handoff",
    task: "Retain the full legacy row on the legacy wire path.",
    completionCriteria: [],
    requestedCapabilities: [],
    status: "running",
    followupCount: 0,
    messageCount: 1,
    effectiveLimits: DEFAULT_VM_AGENT_DELEGATION_LIMITS,
    revision: 1,
    createdAt,
    startedAt: createdAt,
    completedAt: null,
    expiresAt: createdAt,
    updatedAt: createdAt,
    result: null,
    error: null,
  },
  rootAgent: agent,
  sourceAgent: agent,
  targetAgent: null,
  latestMessage: null,
};

describe("VM agent collaboration rolling upgrades", () => {
  it("accepts legacy and opt-in request payloads", () => {
    const decodeSubscribe = Schema.decodeUnknownSync(VmAgentCollaborationSubscribeInput);
    const decodeDetail = Schema.decodeUnknownSync(VmAgentDelegationRef);

    expect(decodeSubscribe({})).toEqual({});
    expect(decodeSubscribe({ compact: true })).toEqual({ compact: true });
    expect(decodeDetail({ delegationId })).toEqual({
      delegationId: VmAgentDelegationId.make(delegationId),
    });
    expect(decodeDetail({ delegationId, paged: true, beforeSequence: 42 })).toEqual({
      delegationId: VmAgentDelegationId.make(delegationId),
      paged: true,
      beforeSequence: 42,
    });
  });

  it("decodes both compact-capable snapshots and old full-row snapshots", () => {
    const decodeWireItem = Schema.decodeUnknownSync(VmAgentCollaborationWireStreamItem);

    expect(
      decodeWireItem({
        type: "snapshot",
        compact: true,
        agents: [],
        delegations: [],
      }),
    ).toMatchObject({ type: "snapshot", compact: true });
    expect(
      decodeWireItem({
        type: "snapshot",
        agents: [agent],
        delegations: [legacySummary],
      }),
    ).toMatchObject({
      type: "snapshot",
      delegations: [{ delegation: { task: legacySummary.delegation.task } }],
    });
  });

  it("lets pre-upgrade request and response schemas accept new opt-in metadata", () => {
    const legacySubscribeInput = Schema.Struct({});
    const legacyDetailInput = Schema.Struct({ delegationId: VmAgentDelegationId });
    const legacySnapshot = Schema.Struct({
      type: Schema.Literal("snapshot"),
      agents: Schema.Array(VmAgentCollaborationAgentSummary),
      delegations: Schema.Array(VmAgentLegacyDelegationSummary),
    });

    expect(Schema.decodeUnknownSync(legacySubscribeInput)({ compact: true })).toEqual({
      compact: true,
    });
    expect(
      Schema.decodeUnknownSync(legacyDetailInput)({
        delegationId,
        paged: true,
        beforeSequence: 42,
      }),
    ).toEqual({ delegationId: VmAgentDelegationId.make(delegationId) });
    expect(
      Schema.decodeUnknownSync(legacySnapshot)({
        type: "snapshot",
        hasMoreDelegations: true,
        agents: [agent],
        delegations: [legacySummary],
      }),
    ).toMatchObject({ type: "snapshot", delegations: [legacySummary] });
  });
});
