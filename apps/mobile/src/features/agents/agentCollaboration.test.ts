import { VmAgentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { delegationFollowupKind, isDelegationRelatedToAgent } from "./agentCollaboration";

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
});
