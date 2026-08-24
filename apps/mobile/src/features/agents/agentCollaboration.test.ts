import { VmAgentDelegationId, VmAgentDelegationMessageId, VmAgentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boundedCollaborationPreview,
  delegationDirectionLabel,
  delegationFollowupKind,
  emptyDelegationListMessage,
  hasEarlierAfterCollaborationPage,
  hasEarlierCollaborationMessages,
  isDelegationRelatedToAgent,
  mergeCollaborationMessages,
} from "./agentCollaboration";

describe("mobile agent collaboration", () => {
  const delegation = {
    rootVmAgentId: VmAgentId.make("root"),
    sourceVmAgentId: VmAgentId.make("source"),
    targetVmAgentId: VmAgentId.make("target"),
  };

  it("shows work where an agent is the persistent root, source, or target", () => {
    expect(isDelegationRelatedToAgent(delegation, "root")).toBe(true);
    expect(isDelegationRelatedToAgent(delegation, "source")).toBe(true);
    expect(isDelegationRelatedToAgent(delegation, "target")).toBe(true);
    expect(isDelegationRelatedToAgent(delegation, "unrelated")).toBe(false);
  });

  it("answers waiting questions and otherwise sends a bounded note", () => {
    expect(delegationFollowupKind("waiting-input")).toBe("answer");
    expect(delegationFollowupKind("running")).toBe("note");
    expect(delegationFollowupKind("pending-approval")).toBe("note");
  });

  it("describes a handoff relative to the agent whose workspace is open", () => {
    const summary = {
      delegation: {
        targetVmAgentId: VmAgentId.make("target"),
        target: { kind: "agent" as const, vmAgentId: VmAgentId.make("target") },
        sourceAgentSnapshot: {
          vmAgentId: VmAgentId.make("source"),
          name: "Source agent",
          handle: "source",
        },
        targetAgentSnapshot: {
          vmAgentId: VmAgentId.make("target"),
          name: "Target agent",
          handle: "target",
        },
      },
      sourceAgent: { name: "Live source" },
      targetAgent: { name: "Live target" },
    };

    expect(delegationDirectionLabel(summary, "source")).toBe("to Live target");
    expect(delegationDirectionLabel(summary, "target")).toBe("from Live source");
    expect(
      delegationDirectionLabel(
        {
          ...summary,
          delegation: {
            ...summary.delegation,
            targetVmAgentId: null,
            target: { kind: "ephemeral" as const, label: "Research helper" },
            targetAgentSnapshot: null,
          },
          targetAgent: null,
        },
        "source",
      ),
    ).toBe("to Research helper");
  });

  it("does not present a bounded empty snapshot as complete history", () => {
    expect(emptyDelegationListMessage(false)).toBe(
      "No delegated work yet. The root can create a named or ephemeral collaborator through chat.",
    );
    expect(emptyDelegationListMessage(true)).toBe(
      "Some older handoffs are outside this bounded live view.",
    );
  });

  it("keeps contract-sized collaboration text out of collapsed mobile views", () => {
    const preview = boundedCollaborationPreview(`start ${"x".repeat(20_000)} tail`, {
      maxCharacters: 400,
      maxLines: 4,
    });
    expect(preview.truncated).toBe(true);
    expect(preview.text.length).toBeLessThanOrEqual(400);
    expect(preview.text).not.toContain("tail");
    expect(
      boundedCollaborationPreview("one\ntwo\nthree", { maxCharacters: 100, maxLines: 2 }),
    ).toEqual({ text: "one\ntwo…", truncated: true });
    expect(boundedCollaborationPreview("ab😀tail", { maxCharacters: 4, maxLines: 1 })).toEqual({
      text: "ab…",
      truncated: true,
    });
  });

  it("merges message pages by sequence and lets the newest page replace an overlap", () => {
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
      mergeCollaborationMessages(
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

  it("uses the loaded count when an older server omits the pagination flag", () => {
    expect(hasEarlierCollaborationMessages(undefined, 80, 40)).toBe(true);
    expect(hasEarlierCollaborationMessages(undefined, 40, 40)).toBe(false);
    expect(hasEarlierCollaborationMessages(false, 80, 40)).toBe(false);
    expect(hasEarlierCollaborationMessages(true, 80, 80)).toBe(false);
  });

  it("stops paging when an older host returns the newest page for an older cursor", () => {
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
      hasEarlierAfterCollaborationPage({
        beforeSequence: 41,
        page: [message(161), message(200)],
        mergedMessageCount: 200,
        totalMessageCount: 240,
        serverValue: undefined,
      }),
    ).toBe(false);
    expect(
      hasEarlierAfterCollaborationPage({
        beforeSequence: 41,
        page: [message(1), message(40)],
        mergedMessageCount: 80,
        totalMessageCount: 120,
        serverValue: true,
      }),
    ).toBe(true);
  });
});
