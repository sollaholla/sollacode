import {
  EnvironmentId,
  VmAgentDelegationId,
  VmAgentDelegationMessageId,
  VmAgentId,
  type VmAgentCollaborationAgentSummary,
  type VmAgentCollaborationSnapshot,
  type VmAgentDelegationSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentDelegationsFor,
  capabilityChips,
  captureDelegationCancellation,
  delegationActivityMessages,
  delegationHistoryLoadState,
  delegationRole,
  delegationStatusActivity,
  emptyDelegationListCopy,
  hasEarlierAfterDelegationPage,
  mergeDelegationMessages,
} from "./AgentCollaborationPanel";
import { agentCollaborationDraftKey } from "./agentCollaborationDraft";

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
    rootAgentSnapshot: {
      vmAgentId: VmAgentId.make(root),
      name: root,
      handle: root,
    },
    sourceAgentSnapshot: {
      vmAgentId: VmAgentId.make(source),
      name: source,
      handle: source,
    },
    targetAgentSnapshot: {
      vmAgentId: VmAgentId.make(target),
      name: target,
      handle: target,
    },
    title: id,
    taskPreview: { text: `${id} task`, truncated: false },
    status: "running",
    followupCount: 0,
    messageCount: 0,
    revision: 1,
    createdAt: "2026-08-21T00:00:00.000Z",
    startedAt: "2026-08-21T00:00:00.000Z",
    completedAt: null,
    expiresAt: "2026-08-21T00:30:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
    resultPreview: null,
    errorPreview: null,
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

describe("capabilityChips", () => {
  it("maps known capability ids to friendly labels and hides the rest", () => {
    expect(
      capabilityChips([
        "workspace.tasks",
        "workspace.consult",
        "browser.preview",
        "collaboration.receive",
        "vm",
      ]),
    ).toEqual(["Tasks", "Consult", "Browser"]);
    expect(capabilityChips(["collaboration.receive", "unknown.future"])).toEqual([]);
    expect(capabilityChips(["workspace.tasks", "workspace.tasks"])).toEqual(["Tasks"]);
  });
});

describe("collaboration interaction identity", () => {
  it("keeps cancellation bound to the delegation captured when confirmation opens", () => {
    let selected = delegation("first-id", "root", "source", "target");
    const confirmation = captureDelegationCancellation(selected);

    selected = delegation("second-id", "root", "source", "target");

    expect(selected.delegation.delegationId).toBe("second-id");
    expect(confirmation).toEqual({ delegationId: "first-id", title: "first-id" });
  });

  it("merges paged messages by sequence without duplicating page boundaries", () => {
    const message = (sequence: number, text: string) => ({
      messageId: VmAgentDelegationMessageId.make(`message-${sequence}`),
      delegationId: VmAgentDelegationId.make("delegation"),
      sequence,
      sender: "system" as const,
      senderVmAgentId: null,
      kind: "note" as const,
      delivery: "delivered" as const,
      text,
      createdAt: `2026-08-21T00:00:0${sequence}.000Z`,
    });

    expect(
      mergeDelegationMessages(
        [message(3, "old three"), message(4, "four")],
        [message(1, "one"), message(2, "two"), message(3, "new three")],
      ).map(({ sequence, text }) => [sequence, text]),
    ).toEqual([
      [1, "one"],
      [2, "two"],
      [3, "new three"],
      [4, "four"],
    ]);
  });

  it("does not repeat the full brief as the first activity message", () => {
    const first = {
      messageId: VmAgentDelegationMessageId.make("brief-message"),
      delegationId: VmAgentDelegationId.make("delegation"),
      sequence: 1,
      sender: "source-agent" as const,
      senderVmAgentId: VmAgentId.make("source"),
      kind: "note" as const,
      delivery: "delivered" as const,
      text: "Build the level with a broad central gap.",
      createdAt: "2026-08-21T00:00:00.000Z",
    };
    const update = {
      ...first,
      messageId: VmAgentDelegationMessageId.make("real-update"),
      sequence: 2,
      sender: "target-agent" as const,
      text: "I have started blocking out the terrain.",
    };

    expect(
      delegationActivityMessages([first, update], "Build the level with a broad\ncentral gap."),
    ).toEqual([update]);
  });

  it("gives every handoff state a concise activity summary", () => {
    expect(delegationStatusActivity("queued")).toMatchObject({
      title: "Waiting for collaborator",
      tone: "neutral",
    });
    expect(delegationStatusActivity("running")).toMatchObject({
      title: "Work in progress",
      tone: "info",
    });
    expect(delegationStatusActivity("completed")).toMatchObject({
      title: "Handoff completed",
      tone: "success",
    });
  });

  it("stops paging when an older host ignores the message cursor", () => {
    const message = (sequence: number) => ({
      messageId: VmAgentDelegationMessageId.make(`message-${sequence}`),
      delegationId: VmAgentDelegationId.make("delegation"),
      sequence,
      sender: "system" as const,
      senderVmAgentId: null,
      kind: "note" as const,
      delivery: "delivered" as const,
      text: `Message ${sequence}`,
      createdAt: "2026-08-21T00:00:00.000Z",
    });

    expect(
      hasEarlierAfterDelegationPage({
        beforeSequence: 41,
        page: [message(161), message(200)],
        mergedMessageCount: 200,
        totalMessageCount: 240,
        serverValue: undefined,
      }),
    ).toBe(false);
    expect(
      hasEarlierAfterDelegationPage({
        beforeSequence: 41,
        page: [message(1), message(40)],
        mergedMessageCount: 80,
        totalMessageCount: 120,
        serverValue: true,
      }),
    ).toBe(true);
  });

  it("distinguishes an older-page failure from an in-flight load", () => {
    const request = { delegationId: VmAgentDelegationId.make("first-id") };

    expect(
      delegationHistoryLoadState(request, "first-id", { isPending: true, hasError: false }),
    ).toEqual({ selectedRequest: true, isLoading: true, hasError: false });
    expect(
      delegationHistoryLoadState(request, "first-id", { isPending: false, hasError: true }),
    ).toEqual({ selectedRequest: true, isLoading: false, hasError: true });
    expect(
      delegationHistoryLoadState(request, "second-id", { isPending: true, hasError: true }),
    ).toEqual({ selectedRequest: false, isLoading: false, hasError: false });
  });

  it("does not claim a bounded empty snapshot has no handoffs", () => {
    expect(emptyDelegationListCopy(false)).toEqual({
      title: "No handoffs yet",
      detail: "Delegated work, questions, and results will appear here.",
    });
    expect(emptyDelegationListCopy(true)).toEqual({
      title: "Handoff history is bounded",
      detail: "Some older handoffs are outside this live view.",
    });
  });

  it("scopes collaboration drafts by both environment and agent", () => {
    const agentId = VmAgentId.make("same-agent-id");

    expect(agentCollaborationDraftKey(EnvironmentId.make("mac"), agentId)).not.toBe(
      agentCollaborationDraftKey(EnvironmentId.make("windows"), agentId),
    );
    expect(agentCollaborationDraftKey(EnvironmentId.make("mac"), agentId)).toBe(
      agentCollaborationDraftKey(EnvironmentId.make("mac"), agentId),
    );
  });
});
