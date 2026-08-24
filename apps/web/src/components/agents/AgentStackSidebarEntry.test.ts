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

describe("waiting-on-you badge", () => {
  const source = () =>
    NodeFS.readFileSync(NodePath.join(import.meta.dirname, "AgentStackSidebarEntry.tsx"), "utf8");

  it("renders as a counted amber pill, not a bare icon", () => {
    // It shipped as a dim grey hand with no number beside a full blue
    // notification pill, so the count it stood for was invisible.
    const badge = source().slice(source().indexOf("props.openBlockers > 0"));
    expect(badge).toContain("bg-warning");
    expect(badge.slice(0, 700)).toContain("{props.openBlockers}");
  });

  it("keeps the icon out of SidebarMenuButton's direct-child svg override", () => {
    // `[&>svg]:text-sidebar-muted-foreground [&>svg]:opacity-60` on
    // SidebarMenuButton has no `:not([class*='text-'])` escape, so a direct
    // <svg> child is repainted grey at 60% whatever colour it asks for. The
    // span wrapper is what keeps the amber.
    const sidebar = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "..", "ui", "sidebar.tsx"),
      "utf8",
    );
    expect(sidebar).toContain("[&>svg]:text-sidebar-muted-foreground");
    expect(source()).not.toContain(
      '<HandIcon\n            className="size-3.5 shrink-0 text-amber',
    );
  });
});
