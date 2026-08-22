import { describe, expect, it } from "vite-plus/test";

import {
  agentCliCommandFromProcess,
  agentCliResumeShellCommand,
  agentCliResumeShellInput,
  canResumeAgentCli,
  claudeProjectDirectoryName,
  shouldMarkAgentResumeOnRestore,
  historyLooksLikeShellPrompt,
  shouldTypeAgentCliResume,
  selectClaudeSessionId,
  CLAUDE_EMPTY_SESSION_MAX_BYTES,
  encodeAgentCliResumeState,
  isAgentCliCommand,
  shouldClearHistoryOnFailedResume,
  parseAgentCliResumeState,
  parseClaudeActiveSession,
  parseGrokActiveSessions,
  parseLsofNameLines,
  sessionIdFromClaudeActiveSessions,
  claudeActiveSessionFileName,
  resumeStateFilePath,
  sessionIdFromClaudeTranscriptPath,
  sessionIdFromCodexTranscriptPath,
  sessionIdFromGrokActiveSessions,
  sessionIdFromGrokSessionPath,
  sessionIdFromOpenFiles,
  sessionIdFromProcessArgs,
  shellQuote,
} from "./agentCliResume.ts";

describe("agent CLI resume", () => {
  it("recognizes the agent CLIs users run in thread terminals", () => {
    expect(isAgentCliCommand("grok")).toBe(true);
    expect(isAgentCliCommand("Claude")).toBe(true);
    expect(isAgentCliCommand("codex")).toBe(true);
    expect(isAgentCliCommand("vim")).toBe(false);
    expect(isAgentCliCommand(null)).toBe(false);
  });

  it("builds a per-provider resume command only when a session id is known", () => {
    expect(agentCliResumeShellCommand("grok", "01900000-0000-7000-8000-000000000001")).toBe(
      "grok --resume 01900000-0000-7000-8000-000000000001",
    );
    expect(agentCliResumeShellCommand("claude", "550e8400-e29b-41d4-a716-446655440000")).toBe(
      "claude --resume 550e8400-e29b-41d4-a716-446655440000",
    );
    expect(agentCliResumeShellCommand("codex", "019a4afd-2f58-70b2-ae0d-0a9e1cfa3e7d")).toBe(
      "codex resume 019a4afd-2f58-70b2-ae0d-0a9e1cfa3e7d",
    );
    expect(agentCliResumeShellCommand("grok", null)).toBeNull();
    expect(agentCliResumeShellCommand("opencode", "abc")).toBeNull();
    expect(agentCliResumeShellInput("grok", "sess-1")).toBe("\rgrok --resume sess-1\r");
    expect(canResumeAgentCli({ command: "claude", sessionId: null, resumeOnRestore: true })).toBe(
      true,
    );
    expect(shouldMarkAgentResumeOnRestore("claude", null)).toBe(true);
    expect(shouldMarkAgentResumeOnRestore("grok", null)).toBe(false);
    expect(claudeProjectDirectoryName("/Users/me/Documents/t3-fork")).toBe(
      "-Users-me-Documents-t3-fork",
    );
    expect(
      shouldTypeAgentCliResume({ targetCommand: "claude", runningCommand: "gitstatusd" }),
    ).toBe(true);
    expect(shouldTypeAgentCliResume({ targetCommand: "claude", runningCommand: "claude" })).toBe(
      false,
    );
    expect(canResumeAgentCli({ command: "grok", sessionId: "sess-1", resumeOnRestore: true })).toBe(
      true,
    );
    expect(
      shouldClearHistoryOnFailedResume({
        command: "grok",
        sessionId: null,
        resumeOnRestore: true,
      }),
    ).toBe(true);
    expect(
      shouldClearHistoryOnFailedResume({
        command: "grok",
        sessionId: "sess-1",
        resumeOnRestore: true,
      }),
    ).toBe(false);
    expect(shellQuote("id with space")).toBe("'id with space'");
  });

  it("round-trips resume metadata including session id", () => {
    const encoded = encodeAgentCliResumeState(
      { command: "grok", sessionId: "sess-1", resumeOnRestore: true },
      "2026-08-19T00:00:00.000Z",
    );
    expect(parseAgentCliResumeState(encoded)).toEqual({
      command: "grok",
      sessionId: "sess-1",
      resumeOnRestore: true,
    });
    expect(parseAgentCliResumeState(`{"command":"grok","resumeOnRestore":true}`)).toEqual({
      command: "grok",
      sessionId: null,
      resumeOnRestore: true,
    });
    expect(parseAgentCliResumeState(`{"command":"vim","resumeOnRestore":true}`)).toBeNull();
  });

  it("extracts session ids from process args", () => {
    expect(
      sessionIdFromProcessArgs("grok", "grok --resume 01900000-0000-7000-8000-000000000001"),
    ).toBe("01900000-0000-7000-8000-000000000001");
    expect(sessionIdFromProcessArgs("claude", "claude --resume=abc-def")).toBe("abc-def");
    expect(
      sessionIdFromProcessArgs("codex", "codex resume 019a4afd-2f58-70b2-ae0d-0a9e1cfa3e7d"),
    ).toBe("019a4afd-2f58-70b2-ae0d-0a9e1cfa3e7d");
    expect(sessionIdFromProcessArgs("grok", "grok --continue")).toBeNull();
    expect(sessionIdFromProcessArgs("grok", "grok -r")).toBeNull();
  });

  it("matches Claude ~/.claude/sessions/<pid>.json by process id", () => {
    expect(claudeActiveSessionFileName(73361)).toBe("73361.json");
    expect(
      parseClaudeActiveSession(
        JSON.stringify({
          pid: 73361,
          sessionId: "40fd1f7a-209b-4515-ad69-4c058353a19b",
          cwd: "/Users/me/app",
          kind: "interactive",
        }),
      ),
    ).toEqual({
      pid: 73361,
      sessionId: "40fd1f7a-209b-4515-ad69-4c058353a19b",
    });
    expect(parseClaudeActiveSession(`{"pid":12,"sessionId":""}`)).toBeNull();
    expect(
      sessionIdFromClaudeActiveSessions(
        [1, 73361, 3],
        [{ pid: 73361, sessionId: "40fd1f7a-209b-4515-ad69-4c058353a19b" }],
      ),
    ).toBe("40fd1f7a-209b-4515-ad69-4c058353a19b");
    expect(sessionIdFromClaudeActiveSessions([9], [{ pid: 73361, sessionId: "sess" }])).toBeNull();
  });

  it("matches Grok active_sessions.json by process id", () => {
    const entries = parseGrokActiveSessions(
      JSON.stringify([
        { session_id: "sess-a", pid: 11, cwd: "/tmp/a" },
        { session_id: "sess-b", pid: 22, cwd: "/tmp/b" },
      ]),
    );
    expect(sessionIdFromGrokActiveSessions([1, 22, 3], entries)).toBe("sess-b");
    expect(sessionIdFromGrokActiveSessions([9], entries)).toBeNull();
  });

  it("parses session ids from open transcript paths", () => {
    expect(
      sessionIdFromClaudeTranscriptPath(
        "/Users/me/.claude/projects/-Users-me-app/550e8400-e29b-41d4-a716-446655440000.jsonl",
      ),
    ).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(
      sessionIdFromCodexTranscriptPath(
        "/Users/me/.codex/sessions/2025/11/03/rollout-2025-11-03T13-31-38-019a4afd-2f58-70b2-ae0d-0a9e1cfa3e7d.jsonl",
      ),
    ).toBe("019a4afd-2f58-70b2-ae0d-0a9e1cfa3e7d");
    expect(
      sessionIdFromGrokSessionPath(
        "/Users/me/.grok/sessions/%2Ftmp/01900000-0000-7000-8000-000000000001/summary.json",
      ),
    ).toBe("01900000-0000-7000-8000-000000000001");
    expect(
      sessionIdFromOpenFiles("claude", [
        "/Users/me/.claude/projects/-Users-me-app/550e8400-e29b-41d4-a716-446655440000.jsonl",
      ]),
    ).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(parseLsofNameLines("p123\nfmem\nn/tmp/file.jsonl\n")).toEqual(["/tmp/file.jsonl"]);
  });

  it("names the sidecar next to the history log", () => {
    expect(resumeStateFilePath("/tmp/terminal_abc.log")).toBe("/tmp/terminal_abc.resume.json");
  });

  it("recognizes Claude when the process is node running the CLI", () => {
    expect(
      agentCliCommandFromProcess(
        "node",
        "node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js",
      ),
    ).toBe("claude");
    expect(agentCliCommandFromProcess("claude", "claude")).toBe("claude");
    expect(agentCliCommandFromProcess("gitstatusd", "gitstatusd")).toBeNull();
  });

  it("recognizes Windows Codex and Grok npm shims running under node", () => {
    expect(
      agentCliCommandFromProcess(
        "node.exe",
        String.raw`node.exe C:\Users\ada\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js`,
      ),
    ).toBe("codex");
    expect(
      agentCliCommandFromProcess(
        "cmd.exe",
        String.raw`C:\Windows\system32\cmd.exe /d /s /c C:\npm\codex.cmd`,
      ),
    ).toBe("codex");
    expect(
      agentCliCommandFromProcess(
        "node",
        String.raw`node C:\Users\ada\AppData\Roaming\npm\node_modules\@xai\grok\bin\grok.js`,
      ),
    ).toBe("grok");
  });

  it("does not let an empty Claude splash session replace a known id", () => {
    const empty = {
      path: "/Users/me/.claude/projects/-tmp/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl",
      bytes: 1350,
    };
    const full = {
      path: "/Users/me/.claude/projects/-tmp/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl",
      bytes: 200_000,
    };
    expect(
      selectClaudeSessionId({
        preferredSessionId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        transcripts: [empty, full],
      }),
    ).toBe("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    expect(
      selectClaudeSessionId({
        preferredSessionId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        transcripts: [empty],
      }),
    ).toBe("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    expect(selectClaudeSessionId({ transcripts: [empty, full] })).toBe(
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    );
    expect(CLAUDE_EMPTY_SESSION_MAX_BYTES).toBeGreaterThan(empty.bytes);
  });

  it("waits through macOS zsh session restore instead of treating it as a prompt", () => {
    expect(historyLooksLikeShellPrompt("% ")).toBe(true);
    expect(
      historyLooksLikeShellPrompt(
        "developer@host sample-project % Restored session: Wed Aug 19 14:22:48 EDT 2026\n",
      ),
    ).toBe(false);
    expect(
      historyLooksLikeShellPrompt(
        "% Restored session: Wed Aug 19 14:22:48 EDT 2026\nrm: /Users/me/.zsh_sessions/A82E6EC8-77C5-402B-8E26-44CA06B1E0F1.session: No such file or directory\n",
      ),
    ).toBe(false);
    expect(
      historyLooksLikeShellPrompt(
        "% Restored session: Wed Aug 19 14:22:48 EDT 2026\nrm: missing\ndeveloper@host sample-project % ",
      ),
    ).toBe(true);
  });
});
