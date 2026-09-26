import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, TerminalSessionSnapshot, ThreadId } from "@t3tools/contracts";

import {
  applyTerminalAttachStreamEvent,
  applyTerminalMetadataStreamEvent,
  combineTerminalSessionState,
  EMPTY_TERMINAL_BUFFER_STATE,
  selectRunningSubprocessTerminalIds,
} from "./terminalSession.ts";

const TARGET = {
  environmentId: EnvironmentId.make("env-local"),
  threadId: ThreadId.make("thread-1"),
  terminalId: "term-1",
} as const;

const BASE_SNAPSHOT: TerminalSessionSnapshot = {
  threadId: TARGET.threadId,
  terminalId: TARGET.terminalId,
  cwd: "/repo",
  worktreePath: null,
  status: "running",
  pid: 123,
  history: "hello",
  exitCode: null,
  exitSignal: null,
  label: "Terminal 1",
  updatedAt: "2026-04-01T00:00:00.000Z",
};

describe("terminal session reducers", () => {
  it("replays the complete parsed screen instead of a truncated diagnostic log", () => {
    const data = "\x1b[?1049h\x1b[31mready\x1b[12;4H";
    const state = applyTerminalAttachStreamEvent(
      EMPTY_TERMINAL_BUFFER_STATE,
      {
        type: "snapshot",
        snapshot: { ...BASE_SNAPSHOT, history: "1;91;91m", screen: { data, cols: 80, rows: 24 } },
      },
      8,
    );
    expect(state.buffer).toBe(data);
    expect(state.replayComplete).toBe(true);
    expect(state.replayGeometry).toEqual({ cols: 80, rows: 24 });
    const output = applyTerminalAttachStreamEvent(
      state,
      {
        type: "output",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
        data: "next",
      },
      8,
    );
    expect(output.replayComplete).toBe(false);
    expect(output.streamCursor?.offset).toBe(data.length + 4);
    expect(output.streamCursor?.generation).toBe(state.streamCursor?.generation);
  });
  it("prefers live attach status over stale metadata after the attach stream starts", () => {
    const summary = applyTerminalMetadataStreamEvent([], {
      type: "snapshot",
      terminals: [
        {
          threadId: BASE_SNAPSHOT.threadId,
          terminalId: BASE_SNAPSHOT.terminalId,
          cwd: BASE_SNAPSHOT.cwd,
          worktreePath: BASE_SNAPSHOT.worktreePath,
          status: "running",
          pid: BASE_SNAPSHOT.pid,
          exitCode: BASE_SNAPSHOT.exitCode,
          exitSignal: BASE_SNAPSHOT.exitSignal,
          updatedAt: BASE_SNAPSHOT.updatedAt,
          hasRunningSubprocess: false,
          label: BASE_SNAPSHOT.label,
        },
      ],
    })[0]!;
    const attached = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "error",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      message: "Terminal disconnected.",
    });

    expect(combineTerminalSessionState(summary, attached)).toMatchObject({
      status: "error",
      error: "Terminal disconnected.",
      version: 1,
    });
  });

  it("uses metadata status before an attach stream has emitted", () => {
    const summary = applyTerminalMetadataStreamEvent([], {
      type: "snapshot",
      terminals: [
        {
          threadId: BASE_SNAPSHOT.threadId,
          terminalId: BASE_SNAPSHOT.terminalId,
          cwd: BASE_SNAPSHOT.cwd,
          worktreePath: BASE_SNAPSHOT.worktreePath,
          status: "running",
          pid: BASE_SNAPSHOT.pid,
          exitCode: BASE_SNAPSHOT.exitCode,
          exitSignal: BASE_SNAPSHOT.exitSignal,
          updatedAt: BASE_SNAPSHOT.updatedAt,
          hasRunningSubprocess: false,
          label: BASE_SNAPSHOT.label,
        },
      ],
    })[0]!;

    expect(combineTerminalSessionState(summary, EMPTY_TERMINAL_BUFFER_STATE).status).toBe(
      "running",
    );
  });

  it("does not treat an idle running shell as a running subprocess", () => {
    const idleSession = {
      target: TARGET,
      state: {
        ...combineTerminalSessionState(null, EMPTY_TERMINAL_BUFFER_STATE),
        status: "running" as const,
        hasRunningSubprocess: false,
      },
    };
    const activeSession = {
      target: { ...TARGET, terminalId: "term-2" },
      state: {
        ...idleSession.state,
        hasRunningSubprocess: true,
      },
    };

    expect(selectRunningSubprocessTerminalIds([idleSession, activeSession])).toEqual(["term-2"]);
  });

  it("does not treat an idle agent CLI summary as working", () => {
    const summary = applyTerminalMetadataStreamEvent([], {
      type: "snapshot",
      terminals: [
        {
          threadId: BASE_SNAPSHOT.threadId,
          terminalId: BASE_SNAPSHOT.terminalId,
          cwd: BASE_SNAPSHOT.cwd,
          worktreePath: BASE_SNAPSHOT.worktreePath,
          status: "running",
          pid: BASE_SNAPSHOT.pid,
          exitCode: BASE_SNAPSHOT.exitCode,
          exitSignal: BASE_SNAPSHOT.exitSignal,
          updatedAt: BASE_SNAPSHOT.updatedAt,
          hasRunningSubprocess: true,
          working: false,
          label: "claude",
        },
      ],
    })[0]!;

    expect(combineTerminalSessionState(summary, EMPTY_TERMINAL_BUFFER_STATE).working).toBe(false);
  });

  it("reduces attach snapshots and output without an imperative session manager", () => {
    const snapshot = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "snapshot",
      snapshot: BASE_SNAPSHOT,
    });
    const output = applyTerminalAttachStreamEvent(
      snapshot,
      {
        type: "output",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
        data: " world",
      },
      8,
    );

    expect(output).toMatchObject({
      buffer: "lo world",
      status: "running",
      error: null,
      version: 2,
    });
  });

  it("reduces terminal metadata snapshots, upserts, and removals", () => {
    const initial = applyTerminalMetadataStreamEvent([], {
      type: "snapshot",
      terminals: [
        {
          threadId: BASE_SNAPSHOT.threadId,
          terminalId: BASE_SNAPSHOT.terminalId,
          cwd: BASE_SNAPSHOT.cwd,
          worktreePath: BASE_SNAPSHOT.worktreePath,
          status: BASE_SNAPSHOT.status,
          pid: BASE_SNAPSHOT.pid,
          exitCode: BASE_SNAPSHOT.exitCode,
          exitSignal: BASE_SNAPSHOT.exitSignal,
          updatedAt: BASE_SNAPSHOT.updatedAt,
          hasRunningSubprocess: false,
          label: BASE_SNAPSHOT.label,
        },
      ],
    });
    const updated = applyTerminalMetadataStreamEvent(initial, {
      type: "upsert",
      terminal: {
        ...initial[0]!,
        hasRunningSubprocess: true,
      },
    });
    const removed = applyTerminalMetadataStreamEvent(updated, {
      type: "remove",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
    });

    expect(updated).toHaveLength(1);
    expect(updated[0]?.hasRunningSubprocess).toBe(true);
    expect(removed).toEqual([]);
  });

  it("caps retained output by UTF-8 byte length", () => {
    const state = applyTerminalAttachStreamEvent(
      EMPTY_TERMINAL_BUFFER_STATE,
      {
        type: "output",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
        data: "🙂🙂",
      },
      4,
    );

    expect(state.buffer).toBe("🙂");
  });
});

describe("terminal stream positions", () => {
  it("keeps an absolute character offset across bounded UTF-8 history trims", () => {
    const initial = applyTerminalAttachStreamEvent(
      EMPTY_TERMINAL_BUFFER_STATE,
      {
        type: "snapshot",
        snapshot: { ...BASE_SNAPSHOT, history: "😀abcd" },
      },
      8,
    );
    const next = applyTerminalAttachStreamEvent(
      initial,
      {
        type: "output",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
        data: "123456",
      },
      8,
    );
    expect(next.buffer).toBe("cd123456");
    expect(next.streamCursor).toEqual({ generation: initial.streamCursor?.generation, offset: 12 });
  });
  it("advances revision and generation on replacement snapshots", () => {
    const event = { type: "snapshot", snapshot: BASE_SNAPSHOT } as const;
    const first = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, event);
    const second = applyTerminalAttachStreamEvent(first, event);
    expect(second.version).toBe(first.version + 1);
    expect(second.streamCursor?.generation).not.toBe(first.streamCursor!.generation);
  });
});

describe("bounded terminal append accounting", () => {
  it("matches UTF-8 byte limits over many small multilingual chunks", () => {
    let state = EMPTY_TERMINAL_BUFFER_STATE;
    const encode = new TextEncoder();
    const chunks = ["hello", "😀", "\x1b[2J", "界", "\r\n"];
    let expected = "";
    for (let i = 0; i < 300; i++) {
      const data = chunks[i % chunks.length]!;
      expected += data;
      while (encode.encode(expected).length > 31)
        expected = expected.slice(expected.codePointAt(0)! > 0xffff ? 2 : 1);
      state = applyTerminalAttachStreamEvent(
        state,
        { type: "output", threadId: TARGET.threadId, terminalId: TARGET.terminalId, data },
        31,
      );
      expect(state.buffer).toBe(expected);
      expect(state.bufferBytes).toBe(encode.encode(expected).length);
    }
  });
  it("accounts for a surrogate pair split across reads", () => {
    let state = applyTerminalAttachStreamEvent(
      EMPTY_TERMINAL_BUFFER_STATE,
      { type: "output", threadId: TARGET.threadId, terminalId: TARGET.terminalId, data: "a\ud83d" },
      8,
    );
    state = applyTerminalAttachStreamEvent(
      state,
      { type: "output", threadId: TARGET.threadId, terminalId: TARGET.terminalId, data: "\ude00" },
      8,
    );
    expect(state.buffer).toBe("a😀");
    expect(state.bufferBytes).toBe(5);
  });
});
