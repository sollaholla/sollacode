import { describe, expect, it } from "vite-plus/test";

import {
  buildPlanImplementationPrompt,
  isProposedPlanOpen,
  newestProposedPlan,
  proposedPlanStatus,
  proposedPlanTitle,
  scanProposedPlanBlocks,
  unwrapProposedPlanBlocks,
  waitingProposedPlan,
  withoutShownProposedPlanBlocks,
  type ProposedPlanLifecycle,
} from "./proposedPlans.ts";

const plan = (
  id: string,
  createdAt: string,
  overrides: Partial<ProposedPlanLifecycle> = {},
): ProposedPlanLifecycle => ({ id, createdAt, implementedAt: null, closedAt: null, ...overrides });

describe("waitingProposedPlan", () => {
  it("waits on the newest plan while it is open", () => {
    const plans = [plan("b", "2026-01-02T00:00:00Z"), plan("a", "2026-01-01T00:00:00Z")];
    expect(waitingProposedPlan(plans)?.id).toBe("b");
  });

  it("does not fall back to an older plan when the newest is done with", () => {
    const older = plan("old", "2026-01-01T00:00:00Z");
    expect(
      waitingProposedPlan([older, plan("new", "2026-01-02T00:00:00Z", { closedAt: "x" })]),
    ).toBeNull();
    expect(
      waitingProposedPlan([older, plan("new", "2026-01-02T00:00:00Z", { implementedAt: "x" })]),
    ).toBeNull();
  });

  it("treats a missing closedAt from an older server as open", () => {
    expect(isProposedPlanOpen({ implementedAt: null })).toBe(true);
  });

  it("breaks creation-time ties by id so every reader agrees", () => {
    const at = "2026-01-01T00:00:00Z";
    expect(newestProposedPlan([plan("b", at), plan("a", at)])?.id).toBe("b");
    expect(newestProposedPlan([plan("a", at), plan("b", at)])?.id).toBe("b");
  });
});

describe("proposedPlanStatus", () => {
  it("says what became of every plan in a thread", () => {
    const plans = [
      plan("built", "2026-01-01T00:00:00Z", { implementedAt: "2026-01-01T01:00:00Z" }),
      plan("set-aside", "2026-01-02T00:00:00Z", { closedAt: "2026-01-02T01:00:00Z" }),
      plan("replaced", "2026-01-03T00:00:00Z"),
      plan("current", "2026-01-04T00:00:00Z"),
    ];
    expect(plans.map((entry) => proposedPlanStatus(entry, plans))).toEqual([
      "implemented",
      "closed",
      "superseded",
      "waiting",
    ]);
  });

  it("lets implementation win over closing", () => {
    const both = plan("p", "2026-01-01T00:00:00Z", { implementedAt: "x", closedAt: "y" });
    expect(proposedPlanStatus(both, [both])).toBe("implemented");
  });
});

describe("plan text helpers", () => {
  it("names a plan by its first heading", () => {
    expect(proposedPlanTitle("Intro\n## Security hardening\n- step")).toBe("Security hardening");
    expect(proposedPlanTitle("- just a list")).toBeNull();
  });

  it("sends the whole plan to implement", () => {
    expect(buildPlanImplementationPrompt("  # Plan\n- a\n")).toBe(
      "PLEASE IMPLEMENT THIS PLAN:\n# Plan\n- a",
    );
  });
});

describe("proposed plan blocks", () => {
  const message = [
    "Here is the approach.",
    "<proposed_plan>",
    "# Auth rewrite",
    "",
    "Use the existing session store.",
    "</proposed_plan>",
    "Then a second option:",
    "  <proposed_plan>",
    "# Token rotation",
    "  </proposed_plan>",
    "<proposed_plan>",
    "# Still streaming",
  ].join("\n");

  it("reads each completed block as its own plan, in order", () => {
    const scanned = scanProposedPlanBlocks(message);
    expect(scanned.plans).toEqual([
      "# Auth rewrite\n\nUse the existing session store.",
      "# Token rotation",
    ]);
    // Everything after the last completed block is still unread.
    expect(message.slice(scanned.end)).toBe("\n<proposed_plan>\n# Still streaming");
  });

  it("never reads prose that mentions the tags as a plan", () => {
    expect(
      scanProposedPlanBlocks("Keep the tags exactly as `<proposed_plan>` and `</proposed_plan>`."),
    ).toEqual({ plans: [], end: 0 });
    expect(
      scanProposedPlanBlocks("Inline <proposed_plan> # Plan </proposed_plan> text").plans,
    ).toEqual([]);
  });

  it("hides only the blocks a plan card already shows", () => {
    const shown = new Set(["# Auth rewrite\n\nUse the existing session store."]);
    const visible = withoutShownProposedPlanBlocks(message, shown);
    expect(visible).not.toContain("# Auth rewrite");
    expect(visible).toContain("Here is the approach.");
    // No card shows this one, so the person can still read it.
    expect(visible).toContain("# Token rotation");
    expect(visible).toContain("# Still streaming");
    expect(withoutShownProposedPlanBlocks(message, new Set())).toBe(message);
  });

  it("keeps the plan but drops the tags where no card is drawn", () => {
    const unwrapped = unwrapProposedPlanBlocks(message);
    expect(unwrapped).not.toContain("proposed_plan>\n# Auth");
    expect(unwrapped).toContain(
      "Here is the approach.\n# Auth rewrite\n\nUse the existing session store.",
    );
    // An unfinished block is left as it streams.
    expect(unwrapped).toContain("<proposed_plan>\n# Still streaming");
  });
});
