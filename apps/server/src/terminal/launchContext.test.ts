import { describe, expect, it } from "vite-plus/test";

import {
  encodeTerminalLaunchContext,
  isLaunchContextFileName,
  launchContextFilePath,
  parseTerminalLaunchContext,
  type TerminalLaunchContext,
} from "./launchContext.ts";

const context: TerminalLaunchContext = {
  threadId: "thread-1",
  terminalId: "term-2",
  cwd: "/workspace/project",
  worktreePath: "/workspace/project/.worktrees/fix",
  runtimeEnv: { FOO: "bar" },
  cols: 120,
  rows: 30,
};

describe("launchContextFilePath", () => {
  it("derives the sibling of the history log", () => {
    expect(launchContextFilePath("/logs/terminal_abc.log")).toBe("/logs/terminal_abc.launch.json");
    expect(launchContextFilePath("/logs/terminal_abc")).toBe("/logs/terminal_abc.launch.json");
  });

  it("recognizes launch context file names", () => {
    expect(isLaunchContextFileName("terminal_abc.launch.json")).toBe(true);
    expect(isLaunchContextFileName("terminal_abc.resume.json")).toBe(false);
    expect(isLaunchContextFileName("terminal_abc.log")).toBe(false);
  });
});

describe("encode/parse round trip", () => {
  it("round-trips a full context", () => {
    const encoded = encodeTerminalLaunchContext(context, "2026-08-20T00:00:00.000Z");
    expect(parseTerminalLaunchContext(encoded)).toEqual(context);
  });

  it("round-trips null worktree and runtime env", () => {
    const bare = { ...context, worktreePath: null, runtimeEnv: null };
    expect(
      parseTerminalLaunchContext(encodeTerminalLaunchContext(bare, "2026-08-20T00:00:00.000Z")),
    ).toEqual(bare);
  });

  it("rejects malformed payloads", () => {
    expect(parseTerminalLaunchContext("not json")).toBeNull();
    expect(parseTerminalLaunchContext("null")).toBeNull();
    expect(parseTerminalLaunchContext(JSON.stringify({ v: 2 }))).toBeNull();
    expect(
      parseTerminalLaunchContext(JSON.stringify({ v: 1, threadId: "t", terminalId: "x", cwd: "" })),
    ).toBeNull();
    expect(
      parseTerminalLaunchContext(
        JSON.stringify({ v: 1, threadId: "t", terminalId: "x", cwd: "/w", cols: 0, rows: 10 }),
      ),
    ).toBeNull();
  });
});
