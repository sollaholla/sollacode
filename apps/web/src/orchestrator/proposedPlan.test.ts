import { describe, expect, it } from "vite-plus/test";

import {
  describePlanAloud,
  findActionablePlan,
  summarizeProposedPlan,
  type ProposedPlanInput,
} from "./proposedPlan";

const plan = (overrides: Partial<ProposedPlanInput> = {}): ProposedPlanInput => ({
  planId: "plan-1",
  planMarkdown: "# Migrate auth\n\n- Add the table\n- Backfill it\n",
  implementedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  ...overrides,
});

describe("findActionablePlan", () => {
  it("ignores a plan that has already been acted on", () => {
    expect(findActionablePlan([plan({ implementedAt: "2026-01-01T01:00:00Z" })])).toBeNull();
  });

  it("takes the newest outstanding plan", () => {
    const older = plan({ planId: "old", createdAt: "2026-01-01T00:00:00Z" });
    const newer = plan({ planId: "new", createdAt: "2026-01-02T00:00:00Z" });
    expect(findActionablePlan([older, newer])?.planId).toBe("new");
    expect(findActionablePlan([newer, older])?.planId).toBe("new");
  });

  it("handles a thread with no plans", () => {
    expect(findActionablePlan([])).toBeNull();
  });
});

describe("summarizeProposedPlan", () => {
  it("titles the plan from its heading and counts the steps", () => {
    const summary = summarizeProposedPlan(plan());
    expect(summary.title).toBe("Migrate auth");
    expect(summary.stepCount).toBe(2);
    expect(summary.steps).toEqual(["Add the table", "Backfill it"]);
  });

  it("says who is holding it up", () => {
    // The point of the field: an agent that proposed a plan has stopped, and
    // nothing else can approve on the user's behalf.
    expect(summarizeProposedPlan(plan()).awaiting).toBe("user");
  });

  it("titles from prose when the plan has no heading", () => {
    // Titling it after the first bullet would read as though the plan were
    // only that one step.
    const summary = summarizeProposedPlan(
      plan({
        planMarkdown: "Here is how I would do it.\n\n1. Read the schema\n2. Write it back\n",
      }),
    );
    expect(summary.title).toBe("Here is how I would do it.");
    expect(summary.stepCount).toBe(2);
  });

  it("falls back to the first step when there is nothing else", () => {
    const summary = summarizeProposedPlan(plan({ planMarkdown: "- Just do the thing" }));
    expect(summary.title).toBe("Just do the thing");
  });

  it("strips markdown so nothing is read out as punctuation", () => {
    const summary = summarizeProposedPlan(
      plan({
        planMarkdown:
          "## **Rewrite** the `parser`\n\n- [ ] Replace [the lexer](https://example.com)\n",
      }),
    );
    expect(summary.title).toBe("Rewrite the parser");
    expect(summary.steps).toEqual(["Replace the lexer"]);
  });

  it("counts every step but only reads back the first few", () => {
    const steps = Array.from({ length: 12 }, (_, index) => `- Step ${index + 1}`).join("\n");
    const summary = summarizeProposedPlan(plan({ planMarkdown: `# Big\n\n${steps}` }));
    expect(summary.stepCount).toBe(12);
    expect(summary.steps).toHaveLength(5);
  });

  it("survives a plan with no structure at all", () => {
    const summary = summarizeProposedPlan(plan({ planMarkdown: "   \n\n   " }));
    expect(summary.title).toBe("an untitled plan");
    expect(summary.stepCount).toBe(0);
  });

  it("shortens a title too long to say", () => {
    const summary = summarizeProposedPlan(plan({ planMarkdown: `# ${"word ".repeat(60)}` }));
    expect(summary.title.length).toBeLessThanOrEqual(120);
    expect(summary.title.endsWith("…")).toBe(true);
  });
});

describe("describePlanAloud", () => {
  it("names the thread, the plan and who has to act", () => {
    const spoken = describePlanAloud(summarizeProposedPlan(plan()), "Rover");
    expect(spoken).toContain("Rover");
    expect(spoken).toContain("Migrate auth");
    expect(spoken).toContain("waiting for the user to approve");
    expect(spoken).toContain("2 steps");
  });

  it("says nothing about size when the plan lists no steps", () => {
    const spoken = describePlanAloud(
      summarizeProposedPlan(plan({ planMarkdown: "# Think about it" })),
      "Rover",
    );
    expect(spoken).not.toContain("step");
  });
});
