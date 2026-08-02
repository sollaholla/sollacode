import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildPlanRefreshTranscript, derivePlanRefreshCurrentSteps } from "./planRefresh.ts";

function activity(kind: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id: `event-${kind}-${Math.random()}`,
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
