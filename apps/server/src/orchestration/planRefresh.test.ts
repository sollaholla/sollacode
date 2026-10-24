import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildPlanRefreshPrompt } from "../textGeneration/TextGenerationPrompts.ts";
import {
  buildPlanRefreshTranscript,
  derivePlanRefreshCurrentSteps,
  derivePlanRefreshProposedPlan,
} from "./planRefresh.ts";

let activitySeq = 0;

function activity(kind: string, payload: unknown): OrchestrationThreadActivity {
  activitySeq += 1;
  return {
    id: `event-${kind}-${activitySeq}`,
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: null,
    createdAt: "2026-08-01T00:00:00.000Z",
  } as unknown as OrchestrationThreadActivity;
}

describe("derivePlanRefreshCurrentSteps", () => {
  it("reads the newest plan, not an earlier one", () => {
    // The refresh must correct what the panel is showing; the panel shows the
    // latest plan activity, so anything older is the wrong starting point.
    const steps = derivePlanRefreshCurrentSteps([
      activity("turn.plan.updated", { plan: [{ step: "old", status: "pending" }] }),
      activity("turn.plan.updated", { plan: [{ step: "new", status: "completed" }] }),
    ]);
    expect(steps).toEqual([{ step: "new", status: "completed" }]);
  });

  it("ignores unrelated activity kinds", () => {
    const steps = derivePlanRefreshCurrentSteps([
      activity("task.started", { plan: [{ step: "not a plan", status: "pending" }] }),
    ]);
    expect(steps).toEqual([]);
  });

  it("returns empty when the thread has no plan yet", () => {
    expect(derivePlanRefreshCurrentSteps([])).toEqual([]);
  });

  it("drops blank steps and defaults an unrecognised status", () => {
    const steps = derivePlanRefreshCurrentSteps([
      activity("turn.plan.updated", {
        plan: [
          { step: "   ", status: "pending" },
          { step: "real", status: "nonsense" },
        ],
      }),
    ]);
    expect(steps).toEqual([{ step: "real", status: "pending" }]);
  });

  it("survives a malformed payload rather than throwing", () => {
    expect(
      derivePlanRefreshCurrentSteps([activity("turn.plan.updated", { plan: "nope" })]),
    ).toEqual([]);
    expect(derivePlanRefreshCurrentSteps([activity("turn.plan.updated", null)])).toEqual([]);
  });
});

describe("buildPlanRefreshTranscript", () => {
  it("labels each side so the model can tell who asked for what", () => {
    const transcript = buildPlanRefreshTranscript([
      { role: "user", text: "add a button" },
      { role: "assistant", text: "done" },
    ]);
    expect(transcript).toBe("User: add a button\nAssistant: done");
  });

  it("keeps the newest messages when the count is capped", () => {
    // The tail is what says whether the work finished, so it is what must
    // survive trimming.
    const messages = Array.from({ length: 10 }, (_, index) => ({
      role: "user" as const,
      text: `m${index}`,
    }));
    const transcript = buildPlanRefreshTranscript(messages, { maxMessages: 3 });
    expect(transcript).toBe("User: m7\nUser: m8\nUser: m9");
  });

  it("truncates a single runaway message instead of letting it crowd everything out", () => {
    const transcript = buildPlanRefreshTranscript([{ role: "user", text: "x".repeat(500) }], {
      maxMessageChars: 20,
    });
    expect(transcript.length).toBeLessThanOrEqual(len("User: ") + 20);
    expect(transcript.endsWith("...")).toBe(true);
  });

  it("drops oldest lines first when the whole transcript is too long", () => {
    const messages = Array.from({ length: 5 }, (_, index) => ({
      role: "user" as const,
      text: `message-${index}`,
    }));
    const transcript = buildPlanRefreshTranscript(messages, { maxTranscriptChars: 40 });
    expect(transcript).toContain("message-4");
    expect(transcript).not.toContain("message-0");
  });

  it("skips empty messages so they do not become blank turns", () => {
    const transcript = buildPlanRefreshTranscript([
      { role: "user", text: "   " },
      { role: "user", text: "real" },
    ]);
    expect(transcript).toBe("User: real");
  });

  it("is empty for a thread with nothing in it", () => {
    // The caller uses this to skip the refresh entirely rather than ask a model
    // to invent a plan from nothing.
    expect(buildPlanRefreshTranscript([])).toBe("");
  });
});

function len(value: string): number {
  return value.length;
}

describe("plan context for a task refresh", () => {
  const plan = (overrides: {
    readonly id: string;
    readonly createdAt: string;
    readonly implementedAt?: string | null;
    readonly closedAt?: string | null;
  }) => ({
    planMarkdown: `# ${overrides.id}\n\n- step`,
    implementedAt: null,
    closedAt: null,
    ...overrides,
  });

  it("ignores a task list made before the newest plan, as the panel does", () => {
    // 2026-08-01 list, 2026-08-02 plan: the old checklist is not the plan's steps.
    expect(
      derivePlanRefreshCurrentSteps(
        [activity("turn.plan.updated", { plan: [{ step: "Old work", status: "completed" }] })],
        [{ id: "plan-new", createdAt: "2026-08-02T00:00:00.000Z" }],
      ),
    ).toEqual([]);
  });

  it("tracks the newest plan unless the person closed it", () => {
    expect(
      derivePlanRefreshProposedPlan([
        plan({ id: "older", createdAt: "2026-08-01T00:00:00.000Z" }),
        plan({
          id: "building",
          createdAt: "2026-08-02T00:00:00.000Z",
          implementedAt: "2026-08-02T01:00:00.000Z",
        }),
      ]),
    ).toContain("# building");
    expect(
      derivePlanRefreshProposedPlan([
        plan({
          id: "set-aside",
          createdAt: "2026-08-02T00:00:00.000Z",
          closedAt: "2026-08-02T01:00:00.000Z",
        }),
      ]),
    ).toBeUndefined();
  });

  it("clips a long plan so it cannot crowd out the conversation", () => {
    const long = plan({ id: "long", createdAt: "2026-08-02T00:00:00.000Z" });
    const clipped = derivePlanRefreshProposedPlan([{ ...long, planMarkdown: "x".repeat(50) }], 20);
    expect(clipped).toHaveLength(20);
    expect(clipped?.endsWith("...")).toBe(true);
  });

  it("shows the model the plan as context only", () => {
    const { prompt } = buildPlanRefreshPrompt({
      transcript: "User: build it",
      currentSteps: [],
      proposedPlanMarkdown: "# Ship it\n\n- one",
    });
    expect(prompt).toContain("Proposed plan the work follows (context only; do not rewrite it):");
    expect(prompt).toContain("# Ship it");
    expect(buildPlanRefreshPrompt({ transcript: "x", currentSteps: [] }).prompt).not.toContain(
      "Proposed plan",
    );
  });
});
