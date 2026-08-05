import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_CONTINUE_PROMPT,
  AGENT_LOOP_MAX_CONSECUTIVE_NUDGES,
  AGENT_LOOP_MIN_NUDGE_INTERVAL_MS,
  AGENT_FALLBACK_ANSWER,
  AGENT_STOP_TOKEN,
  agentAnswerForQuestion,
  buildAgentAnswers,
  classifyAgentLoopReplyFailure,
  containsAgentStopToken,
  hasUserRepliedAfterLastAssistant,
  isAgentContinuePrompt,
  isAgentLoopBlockingReply,
  selectAgentLoopAssistantText,
  selectRecommendedOption,
  shouldShowAgentAutoResumePending,
  shouldContinueAgentLoop,
  stripAgentStopToken,
} from "./agentMode";

describe("isAgentContinuePrompt", () => {
  it("only identifies the app-authored Agent mode continuation", () => {
    expect(isAgentContinuePrompt(AGENT_CONTINUE_PROMPT)).toBe(true);
    expect(isAgentContinuePrompt(`prefix ${AGENT_CONTINUE_PROMPT}`)).toBe(false);
    expect(isAgentContinuePrompt("Agent auto-resuming")).toBe(false);
  });
});

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

  it("only treats the token as a sign-off when it ends the reply", () => {
    expect(containsAgentStopToken("I am not using AGENT_STOP because work remains.")).toBe(false);
    expect(containsAgentStopToken("AGENT_STOP then continue working")).toBe(false);
  });

  it("allows hidden memory metadata after the visible sign-off", () => {
    expect(
      containsAgentStopToken(
        "Finished. AGENT_STOP\n<oai-mem-citation><citation_entries /></oai-mem-citation>",
      ),
    ).toBe(true);
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

  it("stops immediately when the model emits the token", () => {
    expect(shouldContinueAgentLoop({ ...base, assistantText: `done ${AGENT_STOP_TOKEN}` })).toBe(
      false,
    );
    expect(
      shouldContinueAgentLoop({
        ...base,
        assistantText: `verified complete ${AGENT_STOP_TOKEN}`,
        previousAssistantText: `done ${AGENT_STOP_TOKEN}`,
      }),
    ).toBe(false);
  });

  it("honors the stop token even when it arrives inside the rapid-reply window", () => {
    expect(
      shouldContinueAgentLoop({
        ...base,
        assistantText: `finished ${AGENT_STOP_TOKEN}`,
        previousAssistantText: "Finished one sweep.",
        nowMs: 10_000,
        lastNudgeAtMs: 9_999,
      }),
    ).toBe(false);
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

describe("shouldShowAgentAutoResumePending", () => {
  const base = {
    interactionMode: "agent" as const,
    turnId: "turn-1",
    turnState: "completed",
    latestTurnSettled: true,
    hasPendingApproval: false,
    hasPendingUserInput: false,
    sessionStatus: "ready",
    messages: [
      {
        role: "assistant",
        turnId: "turn-1",
        text: "Finished one phase; more work remains.",
        streaming: false,
      },
    ],
  };

  it("covers the gap before the server continuation appears", () => {
    expect(shouldShowAgentAutoResumePending(base)).toBe(true);
  });

  it("stays visible after the app-authored continuation message is projected", () => {
    expect(
      shouldShowAgentAutoResumePending({
        ...base,
        messages: [...base.messages, { role: "user", inputOrigin: "agent-loop" }],
      }),
    ).toBe(true);
  });

  it("does not talk over a real user message or a clean stop", () => {
    expect(
      shouldShowAgentAutoResumePending({
        ...base,
        messages: [...base.messages, { role: "user" }],
      }),
    ).toBe(false);
    expect(
      shouldShowAgentAutoResumePending({
        ...base,
        messages: [
          {
            role: "assistant",
            turnId: "turn-1",
            text: "Everything is verified. AGENT_STOP",
            streaming: false,
          },
        ],
      }),
    ).toBe(false);
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

describe("agent loop runaway guards", () => {
  const base = {
    interactionMode: "agent" as const,
    turnState: "completed",
    assistantText: "made progress",
    isStreaming: false,
    hasPendingUserInput: false,
    isConnected: true,
    armed: true,
  };

  it("does not run merely because agent mode was selected", () => {
    // The previous turn is already "completed", so without arming, choosing
    // "Agent" satisfied every other guard and fired a turn immediately — the
    // mode picker behaved as a send button.
    expect(shouldContinueAgentLoop({ ...base, armed: false })).toBe(false);
  });

  it("runs once the user has actually sent something", () => {
    expect(shouldContinueAgentLoop({ ...base, armed: true })).toBe(true);
  });

  it("stops on a provider failure that retrying cannot fix", () => {
    // These arrive as ordinary assistant text with a completed turn, so every
    // structural guard passes and the loop retries at full speed. This is what
    // filled a thread with hundreds of identical nudges after a logout.
    for (const reply of [
      "Not logged in · Please run /login",
      "Session expired, please sign in again",
      "Unauthorized",
      "Invalid API key",
      "Your credit balance is too low",
      "Usage credits are required for fast mode.",
      "Fast mode disabled · usage credits exhausted",
      "Rate limit exceeded",
    ]) {
      expect(shouldContinueAgentLoop({ ...base, assistantText: reply })).toBe(false);
    }
  });

  it("refuses to nudge faster than a real turn could complete", () => {
    expect(
      shouldContinueAgentLoop({
        ...base,
        nowMs: 10_000,
        lastNudgeAtMs: 10_000 - (AGENT_LOOP_MIN_NUDGE_INTERVAL_MS - 1),
      }),
    ).toBe(false);
  });

  it("allows the next nudge once enough time has passed", () => {
    expect(
      shouldContinueAgentLoop({
        ...base,
        nowMs: 100_000,
        lastNudgeAtMs: 100_000 - AGENT_LOOP_MIN_NUDGE_INTERVAL_MS,
      }),
    ).toBe(true);
  });

  it("stops after the consecutive-nudge budget is spent", () => {
    expect(
      shouldContinueAgentLoop({
        ...base,
        consecutiveNudges: AGENT_LOOP_MAX_CONSECUTIVE_NUDGES,
      }),
    ).toBe(false);
    expect(
      shouldContinueAgentLoop({
        ...base,
        consecutiveNudges: AGENT_LOOP_MAX_CONSECUTIVE_NUDGES - 1,
      }),
    ).toBe(true);
  });

  it("stops when a turn produced byte-identical output to the last one", () => {
    // Real work never repeats itself exactly; this is a wedged provider.
    expect(
      shouldContinueAgentLoop({
        ...base,
        assistantText: "same thing",
        previousAssistantText: "same thing",
      }),
    ).toBe(false);
  });

  it("continues when the reply changed", () => {
    expect(
      shouldContinueAgentLoop({
        ...base,
        assistantText: "next step done",
        previousAssistantText: "first step done",
      }),
    ).toBe(true);
  });

  it("does not nudge a session that is stopped or errored", () => {
    expect(shouldContinueAgentLoop({ ...base, isSessionReady: false })).toBe(false);
  });
});

describe("isAgentLoopBlockingReply", () => {
  it("recognises terse provider failures", () => {
    expect(isAgentLoopBlockingReply("Not logged in · Please run /login")).toBe(true);
    expect(isAgentLoopBlockingReply("Unauthorized")).toBe(true);
  });

  it("does not fire on work that merely mentions authentication", () => {
    // The guard must not end a healthy loop for talking about the wrong
    // subject. "Refactored the rate limiter tests" contains "rate limit".
    expect(isAgentLoopBlockingReply("Refactored the rate limiter tests")).toBe(false);
    expect(isAgentLoopBlockingReply("I added a login form to the settings page")).toBe(false);
  });

  it("ignores a long summary that quotes an error inside it", () => {
    // A real work summary is long; an error message is one terse line. Without
    // the length bound, an agent reporting that it fixed a logout bug would
    // stop its own loop.
    const summary = `Fixed the logout path. Previously the client showed "Not logged in" ${"and kept retrying forever, ".repeat(10)}which is now handled.`;
    expect(summary.length).toBeGreaterThan(200);
    expect(isAgentLoopBlockingReply(summary)).toBe(false);
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

  it("refuses an older matching turn when the newest assistant belongs to a newer turn", () => {
    const text = selectAgentLoopAssistantText(
      [
        {
          role: "assistant",
          turnId: "turn-stale",
          streaming: false,
          text: "Continue working.",
        },
        {
          role: "assistant",
          turnId: "turn-final",
          streaming: false,
          text: `Everything is complete. ${AGENT_STOP_TOKEN}`,
        },
      ],
      "turn-stale",
    );

    expect(text).toBe("");
  });

  it("reads empty when the conversation has no assistant message", () => {
    // Empty text is refused by shouldContinueAgentLoop, so this stays safe.
    expect(selectAgentLoopAssistantText([{ role: "user", text: "hi" }])).toBe("");
    expect(selectAgentLoopAssistantText([])).toBe("");
  });

  it("treats a settled newest assistant message as readable even with missing text", () => {
    expect(selectAgentLoopAssistantText([{ role: "assistant", streaming: false }])).toBe("");
  });

  it("requires the finalized assistant reply to belong to the completed turn", () => {
    expect(
      selectAgentLoopAssistantText(
        [
          { role: "assistant", turnId: "turn-old", streaming: false, text: "old clean reply" },
          { role: "user", turnId: null, streaming: false, text: "settings updated" },
        ],
        "turn-settings",
      ),
    ).toBe("");
    expect(
      selectAgentLoopAssistantText(
        [{ role: "assistant", turnId: "turn-current", streaming: false, text: "done" }],
        "turn-current",
      ),
    ).toBe("done");
  });
});

describe("classifyAgentLoopReplyFailure", () => {
  // Verbatim from a real run — 162 chars, so it sits inside the length bound
  // and used to pass every guard and get nudged.
  const GATEWAY_502 =
    "API Error: 502 terminated. This is a server-side issue, usually temporary — try again in a moment. If it persists, check your inference gateway (127.0.0.1:60934).";

  it("treats a gateway failure as transient", () => {
    expect(classifyAgentLoopReplyFailure(GATEWAY_502)).toBe("transient");
    expect(classifyAgentLoopReplyFailure("API Error: 503 Service Unavailable")).toBe("transient");
    expect(classifyAgentLoopReplyFailure("Upstream is overloaded, try again")).toBe("transient");
  });

  it("treats an auth failure as fatal", () => {
    expect(classifyAgentLoopReplyFailure("Not logged in · Please run /login")).toBe("fatal");
    expect(classifyAgentLoopReplyFailure("Your session has expired")).toBe("fatal");
    expect(classifyAgentLoopReplyFailure("Usage credits are required for fast mode.")).toBe(
      "fatal",
    );
  });

  it("prefers fatal when a failure reads as both", () => {
    // A quota wall is server-side but retrying never clears it.
    expect(classifyAgentLoopReplyFailure("API Error: rate limit exceeded")).toBe("fatal");
  });

  it("does not classify real work as a failure", () => {
    expect(classifyAgentLoopReplyFailure("Fixed the login form and added tests.")).toBeNull();
    expect(classifyAgentLoopReplyFailure("")).toBeNull();
  });

  it("ignores long prose that merely discusses an error", () => {
    const essay = `${GATEWAY_502} `.repeat(4);
    expect(classifyAgentLoopReplyFailure(essay)).toBeNull();
  });

  it("blocks the loop for both kinds", () => {
    expect(isAgentLoopBlockingReply(GATEWAY_502)).toBe(true);
    expect(isAgentLoopBlockingReply("Not logged in · Please run /login")).toBe(true);
    expect(isAgentLoopBlockingReply("Fixed the login form and added tests.")).toBe(false);
  });
});

describe("hasUserRepliedAfterLastAssistant", () => {
  it("is true when the user has spoken since the last reply", () => {
    expect(
      hasUserRepliedAfterLastAssistant([
        { role: "assistant", text: "done" },
        { role: "user", text: "actually, do this instead" },
      ]),
    ).toBe(true);
  });

  it("is false when the assistant spoke last", () => {
    expect(
      hasUserRepliedAfterLastAssistant([
        { role: "user", text: "go" },
        { role: "assistant", text: "done" },
      ]),
    ).toBe(false);
  });

  it("is false for an empty thread", () => {
    expect(hasUserRepliedAfterLastAssistant([])).toBe(false);
  });
});
