import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_CLI_OUTPUT_STALE_MS,
  AGENT_CLI_WORKING_IDLE_MS,
  agentCliLooksBusy,
  nextAgentCliWorkingState,
  terminalCommandProviderDriver,
  terminalSubprocessIsWorking,
} from "./terminalProvider.ts";

describe("terminalCommandProviderDriver", () => {
  it("maps known agent CLIs to their driver", () => {
    expect(terminalCommandProviderDriver("claude")).toEqual(ProviderDriverKind.make("claudeAgent"));
    expect(terminalCommandProviderDriver("GROK")).toEqual(ProviderDriverKind.make("grok"));
    expect(terminalCommandProviderDriver("codex")).toEqual(ProviderDriverKind.make("codex"));
    expect(terminalCommandProviderDriver("cursor-agent")).toEqual(
      ProviderDriverKind.make("cursor"),
    );
    expect(terminalCommandProviderDriver("opencode")).toEqual(ProviderDriverKind.make("opencode"));
  });

  it("returns null for an idle shell label", () => {
    expect(terminalCommandProviderDriver("Terminal 1")).toBeNull();
    expect(terminalCommandProviderDriver(null)).toBeNull();
    expect(terminalCommandProviderDriver("")).toBeNull();
  });
});

describe("agentCliLooksBusy", () => {
  it("treats Claude and Grok home screens as idle", () => {
    expect(
      agentCliLooksBusy("Claude Code v2.1.2\nSonnet 4.6\nWhat's new\nFixed a bug\nTry update"),
    ).toBe(false);
    expect(agentCliLooksBusy("Grok\nWhat do you want to get done?\n/commands for more")).toBe(
      false,
    );
  });

  it("treats an interrupt hint on the current frame as busy", () => {
    expect(agentCliLooksBusy("Reading src/foo.ts\nesc to interrupt")).toBe(true);
    expect(agentCliLooksBusy("ctrl+c to stop\nThinking…")).toBe(true);
    expect(agentCliLooksBusy("⠋ Working on the patch")).toBe(true);
  });

  it("does not let a version string override an in-flight Claude turn", () => {
    expect(
      agentCliLooksBusy("Claude Code v2.1.2\nSonnet 4.6\nReading src/foo.ts\nesc to interrupt"),
    ).toBe(true);
  });

  it("ignores an older interrupt hint that has scrolled out of the tail", () => {
    expect(agentCliLooksBusy(`${"esc to interrupt\n"}${"settled output\n".repeat(200)}`)).toBe(
      false,
    );
  });

  it("treats a spinner status line as busy", () => {
    expect(agentCliLooksBusy("✻ Cogitating… (2m 4s · esc to interrupt)")).toBe(true);
    expect(agentCliLooksBusy("✶ Deliberating…")).toBe(true);
  });

  it("goes idle when the turn-complete row is painted after stale busy frames", () => {
    // Partial repaints rewrite only the status row, so the previous frame's
    // interrupt hint stays in the stripped tail forever. The completion row
    // painted after it must win.
    expect(
      agentCliLooksBusy(
        "✻ Cogitating… (esc to interrupt)\n✻ Cogitating… (esc to interrupt)\n✳ Worked for 13m 30s\n> \nauto mode on (shift+tab to cycle)",
      ),
    ).toBe(false);
  });

  it("does not read transcript prose as a busy marker", () => {
    expect(
      agentCliLooksBusy(
        "The chat now renders the model picker and the agent's thinking.\n✳ Worked for 13m 30s\n> ",
      ),
    ).toBe(false);
    expect(agentCliLooksBusy("✳ Worked for 13m 30s\n> ")).toBe(false);
  });
});

describe("terminalSubprocessIsWorking", () => {
  it("uses the server working flag when present", () => {
    expect(
      terminalSubprocessIsWorking({
        hasRunningSubprocess: true,
        command: "claude",
        working: false,
      }),
    ).toBe(false);
    expect(
      terminalSubprocessIsWorking({
        hasRunningSubprocess: true,
        command: "claude",
        working: true,
      }),
    ).toBe(true);
  });

  it("counts a non-agent child as working", () => {
    expect(
      terminalSubprocessIsWorking({
        hasRunningSubprocess: true,
        command: "vim",
      }),
    ).toBe(true);
  });

  it("does not count an idle agent TUI as working", () => {
    expect(
      terminalSubprocessIsWorking({
        hasRunningSubprocess: true,
        command: "claude",
        history: "Claude Code v2.1.2\nWhat's new\n",
      }),
    ).toBe(false);
    expect(
      terminalSubprocessIsWorking({
        hasRunningSubprocess: true,
        command: "grok",
      }),
    ).toBe(false);
  });
});

describe("nextAgentCliWorkingState", () => {
  it("turns on immediately and holds through a brief idle-looking frame", () => {
    const started = nextAgentCliWorkingState({
      currentlyWorking: false,
      looksBusy: true,
      lastBusyAtMs: null,
      nowMs: 1_000,
    });
    expect(started).toEqual({ working: true, lastBusyAtMs: 1_000 });
    expect(
      nextAgentCliWorkingState({
        currentlyWorking: true,
        looksBusy: false,
        lastBusyAtMs: 1_000,
        nowMs: 1_000 + AGENT_CLI_WORKING_IDLE_MS - 1,
      }),
    ).toEqual({ working: true, lastBusyAtMs: 1_000 });
  });

  it("drops working after the idle hold", () => {
    expect(
      nextAgentCliWorkingState({
        currentlyWorking: true,
        looksBusy: false,
        lastBusyAtMs: 1_000,
        nowMs: 1_000 + AGENT_CLI_WORKING_IDLE_MS,
      }),
    ).toEqual({ working: false, lastBusyAtMs: null });
  });

  it("ignores busy-looking frames once the pane has been silent too long", () => {
    // A mid-turn TUI animates its status line, so real turns keep output
    // flowing; markers frozen into history must not hold working forever.
    const nowMs = 100_000;
    expect(
      nextAgentCliWorkingState({
        currentlyWorking: true,
        looksBusy: true,
        lastBusyAtMs: nowMs - AGENT_CLI_WORKING_IDLE_MS,
        nowMs,
        lastOutputAtMs: nowMs - AGENT_CLI_OUTPUT_STALE_MS,
      }),
    ).toEqual({ working: false, lastBusyAtMs: null });
    expect(
      nextAgentCliWorkingState({
        currentlyWorking: false,
        looksBusy: true,
        lastBusyAtMs: null,
        nowMs,
        lastOutputAtMs: nowMs - 1_000,
      }),
    ).toEqual({ working: true, lastBusyAtMs: nowMs });
  });
});
