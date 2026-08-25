import { describe, expect, it } from "vite-plus/test";

import {
  appendAgentStreamText,
  containsAgentStopToken,
  emittedAgentStop,
  extractAgentStopSignoff,
  isProviderAuthenticationFailure,
  isTerminalProviderRefusal,
  sessionNeedsProviderReset,
  shouldAgentContinueAfterReply,
} from "./agentMode.ts";

describe("appendAgentStreamText", () => {
  it("separates prose that resumes after a terminal stop token", () => {
    const text = appendAgentStreamText(
      "Please test the garment.\n\nAGENT_STOP",
      "Pinch is working, so I’ll inspect the doors next.",
    );

    expect(text).toBe(
      "Please test the garment.\n\nAGENT_STOP\n\nPinch is working, so I’ll inspect the doors next.",
    );
    expect(extractAgentStopSignoff(text)).toEqual({
      hasStop: true,
      text: "Please test the garment.\n\nPinch is working, so I’ll inspect the doors next.",
    });
  });

  it("does not add spacing to ordinary chunks or an existing line break", () => {
    expect(appendAgentStreamText("Ordinary ", "prose")).toBe("Ordinary prose");
    expect(appendAgentStreamText("Done. AGENT_STOP", "\nNext line")).toBe(
      "Done. AGENT_STOP\nNext line",
    );
  });

  it("adds the resumed-output boundary only once across later stream chunks", () => {
    const firstChunk = appendAgentStreamText("Done. AGENT_STOP", "Pinch");

    expect(appendAgentStreamText(firstChunk, " is working.")).toBe(
      "Done. AGENT_STOP\n\nPinch is working.",
    );
  });
});

describe("extractAgentStopSignoff", () => {
  it.each([
    "Done. AGENT_STOP",
    "Done. `AGENT_STOP`",
    'Done. "AGENT_STOP"',
    "Done. (AGENT_STOP)",
    "Done. **AGENT_STOP**",
    "Done. ‘AGENT_STOP’.…",
  ])("recognizes wrapped terminal stop tokens: %s", (message) => {
    expect(containsAgentStopToken(message)).toBe(true);
    expect(extractAgentStopSignoff(message)).toEqual({ hasStop: true, text: "Done." });
  });

  it("preserves hidden memory metadata after removing the visible signoff", () => {
    expect(
      extractAgentStopSignoff(
        "Done. `AGENT_STOP`\n<oai-mem-citation><citation_entries /></oai-mem-citation>",
      ),
    ).toEqual({
      hasStop: true,
      text: "Done.\n<oai-mem-citation><citation_entries /></oai-mem-citation>",
    });
  });

  it("does not treat an embedded mention as a terminal stop", () => {
    const message = "Do not use AGENT_STOP because work remains.";
    expect(extractAgentStopSignoff(message)).toEqual({ hasStop: false, text: message });
  });

  it("strips a standalone stop line even when a stray trailing line follows it", () => {
    // Observed live 2026-08-16: the browser bridge read ChatGPT's page footer
    // as the reply's last line, so the token was no longer terminal, the badge
    // never rendered, and the raw control token showed as prose. The Agent loop
    // had already stopped on it — only the display disagreed.
    expect(
      extractAgentStopSignoff(
        "I won't invent tool results.\n\nAGENT_STOP\n\nChatGPT is AI and can make mistakes. Check important info.",
      ),
    ).toEqual({
      hasStop: true,
      text: "I won't invent tool results.\n\nChatGPT is AI and can make mistakes. Check important info.",
    });
  });

  it.each(["**AGENT_STOP**", '"AGENT_STOP"', "`AGENT_STOP`", "AGENT_STOP."])(
    "strips a wrapped standalone stop line: %s",
    (line) => {
      expect(extractAgentStopSignoff(`Done.\n\n${line}\n\nFooter text.`)).toEqual({
        hasStop: true,
        text: "Done.\n\nFooter text.",
      });
    },
  );

  it("leaves a stop token that is part of a sentence alone", () => {
    // The standalone-line rule must not reach prose about the protocol: a
    // token inside a sentence is discussion, and cutting the line would maul
    // the answer.
    const message = "End your message with AGENT_STOP when finished.\n\nMore detail follows.";
    expect(extractAgentStopSignoff(message)).toEqual({ hasStop: false, text: message });
  });

  it("ignores a standalone stop line buried far above the end of a long reply", () => {
    // Scoped to the same trailing window the Agent loop uses, so the display
    // and the loop cannot disagree about whether the agent stopped.
    const message = `Done.\n\nAGENT_STOP\n\n${"x".repeat(400)}`;
    expect(extractAgentStopSignoff(message)).toEqual({ hasStop: false, text: message });
    expect(emittedAgentStop(message)).toBe(false);
  });

  it("agrees with the loop: a stripped display always means the loop stopped", () => {
    const message = "All done.\n\nAGENT_STOP\n\nChatGPT can make mistakes.";
    expect(extractAgentStopSignoff(message).hasStop).toBe(true);
    expect(emittedAgentStop(message)).toBe(true);
    expect(shouldAgentContinueAfterReply(message)).toBe(false);
  });
});

describe("isProviderAuthenticationFailure", () => {
  it.each([
    "Failed to authenticate: OAuth session expired and could not be refreshed",
    "Authentication required. Please run /login.",
    "Not logged in",
    "Unauthorized: request rejected",
    "401 Unauthorized",
    "Invalid API key",
  ])("recognizes provider login failures: %s", (message) => {
    expect(isProviderAuthenticationFailure(message)).toBe(true);
  });

  it("does not confuse transient or quota errors with a logged-out provider", () => {
    expect(isProviderAuthenticationFailure("API Error: Unable to connect (ECONNRESET)")).toBe(
      false,
    );
    expect(isProviderAuthenticationFailure("Usage credits are required for fast mode.")).toBe(
      false,
    );
  });

  // This heuristic also scans assistant prose. An agent *talking about*
  // authorization — ADB device states, HTTP APIs, permissions — must never be
  // classified as a logged-out provider: doing so once killed a healthy
  // session mid-turn and looped auth-resume against a finished thread.
  it("does not treat prose that mentions authorization as a credential failure", () => {
    expect(
      isProviderAuthenticationFailure(
        "The target still does not appear in ADB\u2014there is no connected or unauthorized device entry. I\u2019ll keep watching briefly in case your message meant the headset is now connected and macOS is still enumerating it.",
      ),
    ).toBe(false);
    expect(
      isProviderAuthenticationFailure(
        "If the endpoint returns unauthorized responses, add the bearer token to the request headers.",
      ),
    ).toBe(false);
    expect(
      isProviderAuthenticationFailure(
        `Authentication failed for the staging cluster. ${"The deploy pipeline logs show the rollout halted at step 4 of 9, and the smoke tests were skipped entirely. ".repeat(3)}`,
      ),
    ).toBe(false);
  });

  it("still recognizes auth-context session expiry", () => {
    expect(isProviderAuthenticationFailure("OAuth session expired; run login again")).toBe(true);
    expect(isProviderAuthenticationFailure("Your session has expired. Please log in.")).toBe(true);
    expect(isProviderAuthenticationFailure("The tmux session has expired after the reboot.")).toBe(
      false,
    );
  });
});

describe("emittedAgentStop (continuation stop-gate)", () => {
  it("honors a terminal token exactly like the strict parser", () => {
    expect(emittedAgentStop("All done.\n\nAGENT_STOP")).toBe(true);
    expect(emittedAgentStop('Finished. "AGENT_STOP"')).toBe(true);
  });

  it("honors a token followed by a short closing sentence or footer", () => {
    expect(emittedAgentStop("Everything is verified. AGENT_STOP\n\n(nothing left to verify)")).toBe(
      true,
    );
    expect(emittedAgentStop("Done. AGENT_STOP\n\n---\nSee the summary above.")).toBe(true);
  });

  it("does not stop on a mid-essay mention far from the end", () => {
    const filler =
      "The plan continues with several verification passes over each module in the repository. ".repeat(
        10,
      );
    expect(emittedAgentStop(`I will only emit AGENT_STOP once finished. ${filler}`)).toBe(false);
  });

  it("never matches the token inside a larger identifier", () => {
    expect(emittedAgentStop("Set MY_AGENT_STOPWATCH=1 before running.")).toBe(false);
  });
});

describe("shouldAgentContinueAfterReply", () => {
  it("stops when the token is wrapped or trailed by a short postscript", () => {
    expect(shouldAgentContinueAfterReply("Complete. `AGENT_STOP`")).toBe(false);
    expect(shouldAgentContinueAfterReply("Complete. AGENT_STOP\n\nAll checks passed.")).toBe(false);
  });

  it("continues on an ordinary progress reply", () => {
    expect(
      shouldAgentContinueAfterReply("Implemented the parser; moving on to the integration tests."),
    ).toBe(true);
  });
});

describe("isTerminalProviderRefusal", () => {
  // Reported 2026-08-15: the LANChat bridge tripped its own breaker and the
  // resume retried it every 15s, republishing "Provider turn start failed"
  // under a permanent "Auto-resuming thread…" with nothing to cancel.
  it("recognises a provider that has stopped accepting turns", () => {
    expect(
      isTerminalProviderRefusal(
        "this session has failed 5 turns in a row; refusing to start another until the cause is fixed.",
      ),
    ).toBe(true);
    expect(
      isTerminalProviderRefusal("The LAN Chat bridge is disabled by the operator: runaway loop"),
    ).toBe(true);
    expect(
      isTerminalProviderRefusal(
        "Claude Code isn't installed. Install Claude Code, or set its path in Settings → Providers.",
      ),
    ).toBe(true);
  });

  // A busy provider is a wait, not a refusal — retrying is correct there.
  it("leaves waits and transient failures to the retry path", () => {
    expect(isTerminalProviderRefusal("A browser turn is already active")).toBe(false);
    expect(isTerminalProviderRefusal("API error: 503 service unavailable")).toBe(false);
    expect(isTerminalProviderRefusal("")).toBe(false);
  });

  // Same guard as the authentication check: prose is not a status line.
  it("ignores an agent merely discussing a refusal", () => {
    expect(isTerminalProviderRefusal("x".repeat(401) + " refusing to start")).toBe(false);
  });
});

describe("sessionNeedsProviderReset", () => {
  it("resets an error session and a still-ready session whose breaker has tripped", () => {
    expect(
      sessionNeedsProviderReset({
        status: "error",
        lastError: "spawn failed",
      }),
    ).toBe(true);
    expect(
      sessionNeedsProviderReset({
        status: "ready",
        lastError:
          "this session has failed 5 turns in a row; refusing to start another until the cause is fixed. Stop and restart the session to reset the breaker.",
      }),
    ).toBe(true);
  });

  it("leaves a healthy session alone", () => {
    expect(sessionNeedsProviderReset({ status: "ready", lastError: null })).toBe(false);
    expect(sessionNeedsProviderReset({ status: "stopped", lastError: null })).toBe(false);
    expect(sessionNeedsProviderReset(null)).toBe(false);
  });
});
