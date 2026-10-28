import { describe, expect, it } from "vite-plus/test";

import { agentCallTransferDetail, agentCallTransferTarget } from "./agentCallBridge.ts";

describe("agentCallTransferTarget", () => {
  it("reads back the agent a transfer moves to, and nothing else", () => {
    expect(agentCallTransferTarget(agentCallTransferDetail("agent-gregg"))).toBe("agent-gregg");
    expect(agentCallTransferTarget("transfer:")).toBeNull();
    expect(agentCallTransferTarget("The call failed.")).toBeNull();
    expect(agentCallTransferTarget(undefined)).toBeNull();
  });
});
