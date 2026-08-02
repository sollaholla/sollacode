import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_CONTINUE_PROMPT,
  AGENT_FALLBACK_ANSWER,
  AGENT_STOP_TOKEN,
  agentAnswerForQuestion,
  buildAgentAnswers,
  containsAgentStopToken,
  selectAgentLoopAssistantText,
  selectRecommendedOption,
  shouldContinueAgentLoop,
  stripAgentStopToken,
} from "./agentMode";

describe("containsAgentStopToken", () => {
  it("detects the token in the sign-offs a model actually writes", () => {
    expect(containsAgentStopToken("All done. AGENT_STOP")).toBe(true);
    expect(containsAgentStopToken("Finished.\n\n`AGENT_STOP`")).toBe(true);
    expect(containsAgentStopToken("**AGENT_STOP**")).toBe(true);
    expect(containsAgentStopToken("AGENT_STOP.")).toBe(true);
    expect(containsAgentStopToken("AGENT_STOP")).toBe(true);
  });

  it("ignores the token embedded in a longer identifier", () => {
    // Otherwise the loop ends the moment the model discusses its own tooling.
    expect(containsAgentStopToken("see AGENT_STOPPING for details")).toBe(false);
    expect(containsAgentStopToken("MY_AGENT_STOP_TOKEN")).toBe(false);
  });

  it("does not fire on unrelated text", () => {
    expect(containsAgentStopToken("still working on it")).toBe(false);
  });
});

describe("stripAgentStopToken", () => {
  it("removes the token so it never leaks into the next prompt", () => {
    expect(stripAgentStopToken("All done. AGENT_STOP")).toBe("All done.");
  });

  it("leaves text without the token untouched", () => {
    expect(stripAgentStopToken("nothing here")).toBe("nothing here");
  });
});

describe("shouldContinueAgentLoop", () => {
  const base = {
    interactionMode: "agent" as const,
    turnState: "completed",
    assistantText: "made progress",
    isStreaming: false,
    hasPendingUserInput: false,
    isConnected: true,
  };

  it("continues after a clean turn that did not sign off", () => {
    expect(shouldContinueAgentLoop(base)).toBe(true);
  });

  it("stops when the model emits the token", () => {
    expect(shouldContinueAgentLoop({ ...base, assistantText: `done ${AGENT_STOP_TOKEN}` })).toBe(
      false,
    );
  });

  it("never runs outside agent mode", () => {
    expect(shouldContinueAgentLoop({ ...base, interactionMode: "default" })).toBe(false);
    expect(shouldContinueAgentLoop({ ...base, interactionMode: "plan" })).toBe(false);
    expect(shouldContinueAgentLoop({ ...base, interactionMode: undefined })).toBe(false);
  });

  it("waits for the turn to finish streaming", () => {
    expect(shouldContinueAgentLoop({ ...base, isStreaming: true })).toBe(false);
  });

  it("does not continue past a turn that needs a human", () => {
    // Failed, interrupted, and incomplete turns all mean something went wrong;
    // nudging would bury the problem under more automated work.
    for (const turnState of ["failed", "interrupted", "incomplete", "running", null]) {
      expect(shouldContinueAgentLoop({ ...base, turnState })).toBe(false);
    }
  });

  it("yields to an outstanding question instead of nudging", () => {
    expect(shouldContinueAgentLoop({ ...base, hasPendingUserInput: true })).toBe(false);
  });

  it("stops on an empty reply rather than spinning", () => {
    expect(shouldContinueAgentLoop({ ...base, assistantText: "   " })).toBe(false);
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
});

describe("shouldContinueAgentLoop offline handling", () => {
  const connected = {
    interactionMode: "agent" as const,
    turnState: "completed",
    assistantText: "made progress",
    isStreaming: false,
    hasPendingUserInput: false,
    isConnected: true,
  };

  it("does not nudge while the connection is down", () => {
    // Retrying into a dead socket would spin the loop against the network
    // rather than waiting for the supervisor to reconnect.
    expect(shouldContinueAgentLoop({ ...connected, isConnected: false })).toBe(false);
  });

  it("resumes once the connection is back", () => {
    expect(shouldContinueAgentLoop(connected)).toBe(true);
  });

  it("still refuses a turn that did not complete cleanly, even when connected", () => {
    // A dropped link leaves the turn incomplete or interrupted; only a genuine
    // completion earns another nudge.
    for (const turnState of ["incomplete", "interrupted", "failed", "running", null]) {
      expect(shouldContinueAgentLoop({ ...connected, turnState })).toBe(false);
    }
  });
});

describe("buildAgentAnswers", () => {
  it("answers with the recommended option when one is marked", () => {
    const answers = buildAgentAnswers([
      {
        id: "q1",
        options: [{ label: "Rewrite everything" }, { label: "Patch it (Recommended)" }],
      },
    ]);
    expect(answers).toEqual({ q1: "Patch it (Recommended)" });
  });

  it("wraps the choice in an array for multi-select questions", () => {
    const answers = buildAgentAnswers([
      { id: "q1", options: [{ label: "A (Recommended)" }, { label: "B" }], multiSelect: true },
    ]);
    expect(answers).toEqual({ q1: ["A (Recommended)"] });
  });

  it("falls back to free text rather than guessing an option", () => {
    // Picking the first option blindly could select the destructive one.
    const answers = buildAgentAnswers([
      { id: "q1", options: [{ label: "Delete" }, { label: "Keep" }] },
    ]);
    expect(answers).toEqual({ q1: AGENT_FALLBACK_ANSWER });
  });

  it("answers every question in the request", () => {
    const answers = buildAgentAnswers([
      { id: "q1", options: [{ label: "Yes (Recommended)" }] },
      { id: "q2", options: [{ label: "No marker here" }] },
    ]);
    expect(Object.keys(answers).toSorted()).toEqual(["q1", "q2"]);
  });
});

describe("selectAgentLoopAssistantText", () => {
  it("returns null while the newest assistant message is still flagged streaming", () => {
    // The finalize race: turn state settles a tick before the message flag.
    // Reading anything here would inspect the previous turn's text.
    const text = selectAgentLoopAssistantText([
      { role: "assistant", streaming: false, text: `done ${AGENT_STOP_TOKEN}` },
      { role: "user", text: "continue" },
      { role: "assistant", streaming: true, text: "partial" },
    ]);
    expect(text).toBeNull();
  });

  it("never falls back past the newest assistant message to an older one", () => {
    // Older message has no stop token; newest one does. Falling back would
    // continue a loop the model explicitly ended.
    const text = selectAgentLoopAssistantText([
      { role: "assistant", streaming: false, text: "keep going" },
      { role: "assistant", streaming: false, text: `all done ${AGENT_STOP_TOKEN}` },
    ]);
    expect(text).toBe(`all done ${AGENT_STOP_TOKEN}`);
    expect(containsAgentStopToken(text ?? "")).toBe(true);
  });

  it("reads empty when the conversation has no assistant message", () => {
    // Empty text is refused by shouldContinueAgentLoop, so this stays safe.
    expect(selectAgentLoopAssistantText([{ role: "user", text: "hi" }])).toBe("");
    expect(selectAgentLoopAssistantText([])).toBe("");
  });

  it("treats a settled newest assistant message as readable even with missing text", () => {
    expect(selectAgentLoopAssistantText([{ role: "assistant", streaming: false }])).toBe("");
  });
});
