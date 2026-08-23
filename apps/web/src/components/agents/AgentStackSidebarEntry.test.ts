// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { VmAgentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { activeDelegationsForAgent, attentionForAgent } from "./AgentStackSidebarEntry";

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

describe("attentionForAgent", () => {
  it("keeps unread and waiting signals scoped to their agent", () => {
    const agents = [
      { vmAgentId: "scout", unreadNotificationCount: 3, openBlockerCount: 1 },
      { vmAgentId: "builder", unreadNotificationCount: 0, openBlockerCount: 2 },
    ];

    expect(attentionForAgent(agents, "scout")).toMatchObject({
      unreadNotificationCount: 3,
      openBlockerCount: 1,
    });
    expect(attentionForAgent(agents, "missing")).toMatchObject({
      unreadNotificationCount: 0,
      openBlockerCount: 0,
    });
  });
});

describe("agent row delete affordance", () => {
  it("collapses the X out of layout instead of reserving a transparent slot", () => {
    // Reserved-but-invisible left the status dot sitting beside a hole at the
    // row's edge. The X collapses with display, so at rest the dot is the last
    // flex item and holds the edge; hover or focus-within materialises the X
    // beside it — both stay visible — and focus-within is also what makes the
    // X tabbable at all. The dot itself never hides: it is the one glyph that
    // must survive every state.
    const source = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "AgentStackSidebarEntry.tsx"),
      "utf8",
    );
    expect(source).toContain(
      "hidden group-hover/agent-row:inline-flex group-focus-within/agent-row:inline-flex",
    );
    expect(source).not.toContain("group-hover/agent-row:hidden");
    expect(source).not.toContain("group-hover/agent-row:opacity-100");
  });
});
