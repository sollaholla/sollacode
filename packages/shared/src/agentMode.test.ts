import { describe, expect, it } from "vite-plus/test";

import {
  containsAgentStopToken,
  extractAgentStopSignoff,
  isProviderAuthenticationFailure,
} from "./agentMode.ts";

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
