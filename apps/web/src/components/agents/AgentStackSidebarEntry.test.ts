import { VmAgentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { activeDelegationsForAgent } from "./AgentStackSidebarEntry";

describe("activeDelegationsForAgent", () => {
  it("projects compact active-work counts without borrowing another agent's work", () => {
    const agents = [
      { vmAgentId: VmAgentId.make("scout"), activeDelegations: 2 },
      { vmAgentId: VmAgentId.make("builder"), activeDelegations: 1 },
    ];

    expect(activeDelegationsForAgent(agents, "scout")).toBe(2);
    expect(activeDelegationsForAgent(agents, "builder")).toBe(1);
    expect(activeDelegationsForAgent(agents, "missing")).toBe(0);
  });
});
