import {
  VmAgentDelegationId,
  VmAgentId,
  VmAgentTaskId,
  type VmAgentCollaborationAgentSummary,
  type VmAgentCollaborationSnapshot,
  type VmAgentDelegationSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { agentDelegationsFor, delegationRole } from "./AgentCollaborationPanel";

const agent = (id: string) =>
  ({
    vmAgentId: VmAgentId.make(id),
    name: id,
    handle: id,
    purpose: `${id} purpose`,
    status: "running",
    controlMode: "agent",
    availability: "available",
    capabilities: ["collaboration"],
    providerInstanceId: null,
    model: null,
    activeDelegations: 0,
    canReceiveDelegation: true,
  }) as VmAgentCollaborationAgentSummary;

const delegation = (
  id: string,
  root: string,
  source: string,
  target: string,
): VmAgentDelegationSummary => ({
  delegation: {
    delegationId: VmAgentDelegationId.make(id),
    rootVmAgentId: VmAgentId.make(root),
    sourceVmAgentId: VmAgentId.make(source),
    rootDelegationId: null,
    parentDelegationId: null,
    depth: 1,
    target: { kind: "agent", vmAgentId: VmAgentId.make(target) },
    targetVmAgentId: VmAgentId.make(target),
    workerThreadId: null,
    rootAgentSnapshot: {
      vmAgentId: VmAgentId.make(root),
      name: root,
      handle: root,
      purpose: `${root} purpose`,
    },
    sourceAgentSnapshot: {
      vmAgentId: VmAgentId.make(source),
      name: source,
      handle: source,
      purpose: `${source} purpose`,
    },
    targetAgentSnapshot: {
      vmAgentId: VmAgentId.make(target),
      name: target,
      handle: target,
      purpose: `${target} purpose`,
    },
    taskId: VmAgentTaskId.make(`task-${id}`),
    runId: null,
    title: id,
    task: `${id} task`,
    completionCriteria: [],
    requestedCapabilities: [],
    status: "running",
    followupCount: 0,
    messageCount: 0,
    effectiveLimits: {
      maxDepth: 1,
      maxChildDelegations: 3,
      maxFollowups: 5,
      maxMessages: 200,
      maxWallClockMinutes: 30,
    },
    revision: 1,
    createdAt: "2026-08-21T00:00:00.000Z",
    startedAt: "2026-08-21T00:00:00.000Z",
    completedAt: null,
    expiresAt: "2026-08-21T00:30:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
    result: null,
    error: null,
  },
  rootAgent: agent(root),
  sourceAgent: agent(source),
  targetAgent: agent(target),
  latestMessage: null,
});

describe("agentDelegationsFor", () => {
  it("keeps work where the agent is root, source, or target", () => {
    const snapshot: VmAgentCollaborationSnapshot = {
      type: "snapshot",
      agents: [agent("scout"), agent("builder"), agent("writer")],
      delegations: [
        delegation("root", "scout", "scout", "builder"),
        delegation("source", "writer", "scout", "builder"),
        delegation("target", "writer", "writer", "scout"),
        delegation("unrelated", "builder", "builder", "writer"),
      ],
    };

    expect(
      agentDelegationsFor(snapshot, "scout").map(({ delegation }) => delegation.delegationId),
    ).toEqual(["root", "source", "target"]);
  });

  it("distinguishes the durable root from a downstream source and target", () => {
    const nested = delegation("nested", "scout", "builder", "writer").delegation;
    expect(delegationRole(nested, "scout")).toBe("Root agent");
    expect(delegationRole(nested, "builder")).toBe("Source agent");
    expect(delegationRole(nested, "writer")).toBe("Target agent");
  });
});
