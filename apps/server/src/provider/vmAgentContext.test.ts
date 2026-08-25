import { describe, expect, it } from "vite-plus/test";

import { T3_BROWSER_CONTROL_POLICY } from "../browserControlPolicy.ts";
import { buildVmAgentContext, withVmAgentContext } from "./vmAgentContext.ts";

const agent = { name: "Scout", purpose: "Watch the Okta tenant thread" };

describe("buildVmAgentContext", () => {
  it("tells the agent to schedule and end its turn rather than poll for a clock time", () => {
    // The regression this guards: an agent waiting for a noon follow-up stayed
    // awake polling `agent_workspace` in-context for hours. That burns the
    // context window it needs when the moment arrives, and leaves its task run
    // marked `running`, so other agents read it as a stalled worker. It could
    // always just end the turn — nothing told it so, and the user had to.
    const context = buildVmAgentContext(agent);
    expect(context).toContain("END YOUR TURN");
    expect(context).toContain("Never poll in-context for a future moment");
  });

  it("identifies the agent and carries its standing purpose", () => {
    const context = buildVmAgentContext(agent);
    expect(context).toContain("You are Scout");
    expect(context).toContain("Watch the Okta tenant thread");
  });

  it("requires explicit browser tab reuse and cleanup decisions", () => {
    const context = buildVmAgentContext(agent);
    expect(context).toContain(T3_BROWSER_CONTROL_POLICY);
    expect(context).toContain("selection-required");
    expect(context).toContain("preview_close");
    expect(context).toContain("Never close a reused tab merely as cleanup");
  });

  it("asks for direction when no purpose is set", () => {
    expect(buildVmAgentContext({ name: "Scout", purpose: "   " })).toContain(
      "no standing purpose set yet",
    );
  });

  it("wraps a user message without losing the context block", () => {
    const wrapped = withVmAgentContext("check the inbox", agent);
    expect(wrapped).toContain("<solla_vm_agent_context>");
    expect(wrapped).toContain("<vm_agent_user_message>\ncheck the inbox\n</vm_agent_user_message>");
  });

  it("emits the bare context when there is no user message", () => {
    expect(withVmAgentContext("   ", agent)).not.toContain("<vm_agent_user_message>");
  });
});
