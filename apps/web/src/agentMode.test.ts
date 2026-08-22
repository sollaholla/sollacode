import { describe, expect, it } from "vite-plus/test";

import { AGENT_STOP_TOKEN } from "@t3tools/shared/agentMode";

import {
  AGENT_CONTINUE_PROMPT,
  AGENT_FALLBACK_ANSWER,
  agentAnswerForQuestion,
  buildAgentAnswers,
  isAgentContinuePrompt,
  isAgentMode,
  isAutoResumePendingWork,
  shouldAnnounceAgentAutoResume,
  selectRecommendedOption,
} from "./agentMode";

describe("isAgentContinuePrompt", () => {
  it("only identifies the app-authored Agent mode continuation", () => {
    expect(isAgentContinuePrompt(AGENT_CONTINUE_PROMPT)).toBe(true);
    expect(isAgentContinuePrompt(`prefix ${AGENT_CONTINUE_PROMPT}`)).toBe(false);
    expect(isAgentContinuePrompt("Agent auto-resuming")).toBe(false);
  });
});

describe("isAgentMode", () => {
  it("only treats the agent interaction mode as agent mode", () => {
    expect(isAgentMode("agent")).toBe(true);
    expect(isAgentMode("default")).toBe(false);
    expect(isAgentMode(undefined)).toBe(false);
  });
});

describe("isAutoResumePendingWork", () => {
  const pending = { kind: "agent-continuation", state: "pending", since: "2026-08-05T00:00:00Z" };

  it("treats absent and null pending work alike: nothing to show", () => {
    // `undefined` (old server) and `null` (nothing queued) both render no
    // affordance; the difference only matters to callers with a local
    // fallback signal.
    expect(isAutoResumePendingWork(undefined)).toBe(false);
    expect(isAutoResumePendingWork(null)).toBe(false);
  });

  it("shows the states the scheduler resolves on its own", () => {
    expect(isAutoResumePendingWork(pending)).toBe(true);
    expect(isAutoResumePendingWork({ ...pending, state: "sleeping" })).toBe(true);
    expect(isAutoResumePendingWork({ ...pending, state: "claimed" })).toBe(true);
  });

  it("hides executing work: the running turn already represents it", () => {
    // An executing obligation supervises the turn it dispatched, and its
    // terminal transition lands after the turn's final events — so a stale
    // "executing" in the last refetched shell must not assert progress over
    // an idle session.
    expect(isAutoResumePendingWork({ ...pending, state: "executing" })).toBe(false);
  });

  it("hides work waiting on the user, which has its own surfaces", () => {
    expect(isAutoResumePendingWork({ ...pending, state: "blocked-authentication" })).toBe(false);
    expect(isAutoResumePendingWork({ ...pending, state: "waiting-approval" })).toBe(false);
    expect(isAutoResumePendingWork({ ...pending, state: "waiting-user-input" })).toBe(false);
  });

  it("filters by kind when one is requested", () => {
    expect(isAutoResumePendingWork(pending, "agent-continuation")).toBe(true);
    expect(isAutoResumePendingWork(pending, "startup-resume")).toBe(false);
    expect(isAutoResumePendingWork({ ...pending, kind: "startup-resume" }, "startup-resume")).toBe(
      true,
    );
  });
});

describe("agent question answering", () => {
  it("picks the option marked recommended, whatever its position or casing", () => {
    const options = [{ label: "Delete everything" }, { label: "Keep going (Recommended)" }];
    expect(selectRecommendedOption(options)?.label).toBe("Keep going (Recommended)");
    expect(selectRecommendedOption([{ label: "Fine (recommended)" }])?.label).toBe(
      "Fine (recommended)",
    );
  });

  it("falls back to free text when nothing is marked", () => {
    // Guessing an option here can be destructive, so ask for the recommendation
    // rather than picking the first entry.
    const answer = agentAnswerForQuestion([{ label: "Delete" }, { label: "Rewrite" }]);
    expect(answer).toEqual({ kind: "text", text: AGENT_FALLBACK_ANSWER });
  });

  it("returns the marked option when one exists", () => {
    const answer = agentAnswerForQuestion([{ label: "Proceed (Recommended)" }]);
    expect(answer.kind).toBe("option");
  });
});

describe("buildAgentAnswers", () => {
  it("answers with the recommended option when one is marked", () => {
    expect(
      buildAgentAnswers([
        { id: "q1", options: [{ label: "Skip" }, { label: "Apply (Recommended)" }] },
      ]),
    ).toEqual({ q1: "Apply (Recommended)" });
  });

  it("wraps the choice in an array for multi-select questions", () => {
    expect(
      buildAgentAnswers([
        { id: "q1", options: [{ label: "Apply (Recommended)" }], multiSelect: true },
      ]),
    ).toEqual({ q1: ["Apply (Recommended)"] });
  });

  it("falls back to free text rather than guessing an option", () => {
    expect(buildAgentAnswers([{ id: "q1", options: [{ label: "Delete" }] }])).toEqual({
      q1: AGENT_FALLBACK_ANSWER,
    });
  });

  it("answers every question in the request", () => {
    const answers = buildAgentAnswers([
      { id: "q1", options: [{ label: "Yes (Recommended)" }] },
      { id: "q2", options: [{ label: "No marker" }] },
    ]);
    expect(Object.keys(answers)).toEqual(["q1", "q2"]);
  });
});

describe("AGENT_CONTINUE_PROMPT", () => {
  it("names the stop token so the model knows how to end the loop", () => {
    expect(AGENT_CONTINUE_PROMPT).toContain(AGENT_STOP_TOKEN);
    expect(AGENT_CONTINUE_PROMPT).toContain("autonomously");
  });

  it("offers finishing as a legitimate exit, not only being blocked", () => {
    // The earlier wording told the model to stop only if it "absolutely CAN
    // NOT continue", which contradicted the completion exit offered in the
    // same sentence — a diligent model can always find more polish, so it
    // would never sign off at all.
    expect(AGENT_CONTINUE_PROMPT.toLowerCase()).toContain("finish");
    expect(AGENT_CONTINUE_PROMPT).not.toContain("absolutely CAN NOT");
  });

  it("treats the stop token as verified completion rather than a pause between passes", () => {
    expect(AGENT_CONTINUE_PROMPT).toContain("strict completion signal, not a pause button");
    expect(AGENT_CONTINUE_PROMPT).toContain("every requested deliverable and acceptance criterion");
    expect(AGENT_CONTINUE_PROMPT).toContain("sweep, iteration, phase, or milestone");
    expect(AGENT_CONTINUE_PROMPT).toContain("diminishing returns");
    expect(AGENT_CONTINUE_PROMPT).toContain("failed check");
    expect(AGENT_CONTINUE_PROMPT).toContain("unverified claim");
    expect(AGENT_CONTINUE_PROMPT).toContain("planned step remains");
    expect(AGENT_CONTINUE_PROMPT).toContain("exhausted safe alternatives");
    expect(AGENT_CONTINUE_PROMPT).toContain("honors that stop signal immediately");
    expect(AGENT_CONTINUE_PROMPT).not.toContain("final completion audit");
  });
});

describe("shouldAnnounceAgentAutoResume", () => {
  const base = { pending: true, isWorking: false, hasRunningBackgroundTask: false };

  it("announces a genuinely queued resume", () => {
    expect(shouldAnnounceAgentAutoResume(base)).toBe(true);
  });

  // Reported 2026-08-15: a thread sat on "Agent auto-resuming…" for the whole
  // life of a background command. The server had parked the continuation on
  // that very task, but the client could not tell parked from imminent.
  it("stays quiet while a background task is still running", () => {
    expect(shouldAnnounceAgentAutoResume({ ...base, hasRunningBackgroundTask: true })).toBe(false);
  });

  it("stays quiet while a turn is already on screen", () => {
    expect(shouldAnnounceAgentAutoResume({ ...base, isWorking: true })).toBe(false);
  });

  it("stays quiet when nothing is queued", () => {
    expect(shouldAnnounceAgentAutoResume({ ...base, pending: false })).toBe(false);
  });
});
