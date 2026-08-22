import { describe, expect, it } from "@effect/vitest";

import {
  buildGrokCollaborationInstructions,
  extractCompletedProposedPlans,
  grokCollaborationPromptBlock,
  resolveGrokPermissionAction,
} from "./GrokCollaboration.ts";

describe("buildGrokCollaborationInstructions", () => {
  it("uses plan instructions only for plan mode", () => {
    expect(buildGrokCollaborationInstructions("plan")).toContain("Plan Mode");
    expect(buildGrokCollaborationInstructions("plan")).toContain("<proposed_plan>");
    expect(buildGrokCollaborationInstructions("default")).toContain("Default Mode");
    expect(buildGrokCollaborationInstructions("agent")).toContain("Default Mode");
  });
});

describe("grokCollaborationPromptBlock", () => {
  it("omits a prompt block when the turn has no interaction mode", () => {
    expect(grokCollaborationPromptBlock(undefined)).toBeUndefined();
    expect(grokCollaborationPromptBlock("plan")).toEqual({
      type: "text",
      text: buildGrokCollaborationInstructions("plan"),
    });
  });
});

describe("extractCompletedProposedPlans", () => {
  it("extracts complete proposed-plan blocks and ignores unfinished ones", () => {
    expect(
      extractCompletedProposedPlans(`
Some preamble
<proposed_plan>
# Auth rewrite

Use the existing session store.
</proposed_plan>
trailing text
<proposed_plan>
# Incomplete
`),
    ).toEqual(["# Auth rewrite\n\nUse the existing session store."]);
  });
});

describe("resolveGrokPermissionAction", () => {
  it("denies mutating work in plan mode even with full access", () => {
    expect(
      resolveGrokPermissionAction({
        runtimeMode: "full-access",
        interactionMode: "plan",
        kind: "edit",
      }),
    ).toBe("deny");
    expect(
      resolveGrokPermissionAction({
        runtimeMode: "full-access",
        interactionMode: "plan",
        kind: "execute",
      }),
    ).toBe("deny");
  });

  it("allows read-only exploration in plan mode", () => {
    expect(
      resolveGrokPermissionAction({
        runtimeMode: "approval-required",
        interactionMode: "plan",
        kind: "search",
      }),
    ).toBe("allow");
  });

  it("auto-approves file edits in auto-accept and auto, but still asks for commands", () => {
    expect(
      resolveGrokPermissionAction({
        runtimeMode: "auto-accept-edits",
        interactionMode: "default",
        kind: "edit",
      }),
    ).toBe("allow");
    expect(
      resolveGrokPermissionAction({
        runtimeMode: "auto",
        interactionMode: "agent",
        kind: "delete",
      }),
    ).toBe("allow");
    expect(
      resolveGrokPermissionAction({
        runtimeMode: "auto-accept-edits",
        interactionMode: "default",
        kind: "execute",
      }),
    ).toBe("ask");
  });

  it("auto-approves every permission in full access outside plan mode", () => {
    expect(
      resolveGrokPermissionAction({
        runtimeMode: "full-access",
        interactionMode: "default",
        kind: "execute",
      }),
    ).toBe("allow");
  });
});
