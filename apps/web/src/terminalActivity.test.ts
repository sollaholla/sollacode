import { EnvironmentId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveWorkingTerminalActivity } from "./terminalActivity";
import type { KnownTerminalSession } from "@t3tools/client-runtime/state/terminal";

const environmentId = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");

function session(
  terminalId: string,
  overrides: {
    readonly hasRunningSubprocess?: boolean;
    readonly working?: boolean;
    readonly workingSince?: string;
    readonly label?: string;
    readonly updatedAt?: string;
  } = {},
): KnownTerminalSession {
  const hasRunningSubprocess = overrides.hasRunningSubprocess ?? false;
  const working = overrides.working ?? hasRunningSubprocess;
  return {
    target: { environmentId, threadId, terminalId },
    state: {
      summary: {
        threadId,
        terminalId,
        cwd: "/tmp",
        worktreePath: null,
        status: "running",
        pid: 1,
        exitCode: null,
        exitSignal: null,
        hasRunningSubprocess,
        working,
        ...(overrides.workingSince !== undefined ? { workingSince: overrides.workingSince } : {}),
        label: overrides.label ?? "Terminal 1",
        updatedAt: overrides.updatedAt ?? "2026-08-19T12:00:00.000Z",
      },
      buffer: "",
      status: "running",
      error: null,
      hasRunningSubprocess,
      working,
      updatedAt: overrides.updatedAt ?? "2026-08-19T12:00:00.000Z",
      version: 1,
    },
  };
}

describe("deriveWorkingTerminalActivity", () => {
  it("returns null when no pane has a running subprocess", () => {
    expect(deriveWorkingTerminalActivity([session("term-1")])).toBeNull();
  });

  it("counts working panes and keeps the earliest start", () => {
    const activity = deriveWorkingTerminalActivity([
      session("term-1", {
        hasRunningSubprocess: true,
        label: "claude",
        updatedAt: "2026-08-19T12:05:00.000Z",
      }),
      session("term-2", {
        hasRunningSubprocess: true,
        label: "claude",
        updatedAt: "2026-08-19T12:01:00.000Z",
      }),
      session("term-3"),
    ]);
    expect(activity).toEqual({
      count: 2,
      terminalIds: ["term-1", "term-2"],
      startedAt: "2026-08-19T12:01:00.000Z",
      driverKind: ProviderDriverKind.make("claudeAgent"),
      displayName: "claude",
    });
  });

  it("drops a unique driver when two different CLIs are running", () => {
    const activity = deriveWorkingTerminalActivity([
      session("term-1", { hasRunningSubprocess: true, label: "claude" }),
      session("term-2", { hasRunningSubprocess: true, label: "grok" }),
    ]);
    expect(activity?.driverKind).toBeNull();
    expect(activity?.count).toBe(2);
  });

  it("prefers workingSince over updatedAt for the start of the turn", () => {
    // updatedAt bumps on every output chunk; using it would restart the
    // "Working" clock forever.
    const activity = deriveWorkingTerminalActivity([
      session("term-1", {
        hasRunningSubprocess: true,
        label: "claude",
        workingSince: "2026-08-19T11:58:00.000Z",
        updatedAt: "2026-08-19T12:05:00.000Z",
      }),
    ]);
    expect(activity?.startedAt).toBe("2026-08-19T11:58:00.000Z");
  });

  it("does not treat an idle agent TUI as working", () => {
    expect(
      deriveWorkingTerminalActivity([
        session("term-1", { hasRunningSubprocess: true, working: false, label: "claude" }),
        session("term-2", { hasRunningSubprocess: true, working: false, label: "grok" }),
      ]),
    ).toBeNull();
  });
});
