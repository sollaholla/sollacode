import { describe, expect, it, vi } from "vite-plus/test";

import type { ThreadSnapshot } from "./events";
import type { OrchestratorToolLogEntry } from "./toolRegistry";
import {
  describeAge,
  executeOrchestratorTool,
  isToolAllowed,
  OrchestratorToolError,
  type OrchestratorToolContext,
} from "./tools";

const snapshot = (overrides: Partial<ThreadSnapshot> = {}): ThreadSnapshot => ({
  threadKey: "env-1:thread-a",
  threadId: "thread-a",
  environmentId: "env-1",
  title: "Rover",
  isWorking: true,
  waitingOn: "nothing",
  isSideChat: false,
  sideChatParentThreadId: null,
  hasError: false,
  environmentUnreachable: false,
  lastError: null,
  failureKind: null,
  errorAt: null,
  settled: false,
  model: "gpt-5.6-sol",
  provider: "codex",
  accessMode: "full-access",
  interactionMode: "default",
  effort: "high",
  latestTurnState: "running",
  projectId: "project-1",
  projectName: "Rover Project",
  workspaceName: "rover",
  ...overrides,
});

const makeContext = (
  overrides: Partial<OrchestratorToolContext> = {},
): OrchestratorToolContext & {
  sendToThread: ReturnType<typeof vi.fn>;
  interruptThread: ReturnType<typeof vi.fn>;
  listTerminals: ReturnType<typeof vi.fn>;
  readTerminal: ReturnType<typeof vi.fn>;
  writeTerminal: ReturnType<typeof vi.fn>;
} => {
  const sendToThread = vi.fn(async () => {});
  const interruptThread = vi.fn(async () => {});
  const applyThreadSettings = vi.fn(async () => {});
  const renameThread = vi.fn(async () => {});
  const createThread = vi.fn(async () => {});
  const inspectProject = vi.fn(async () => ({ files: ["main.tsx"], directories: ["src"] }));
  const createSideChat = vi.fn(async () => {});
  const setThreadSettled = vi.fn(async () => ({ deferred: false }));
  const readThread = vi.fn(async () => ({ messages: [], activities: [] }));
  const listTerminals = vi.fn(async () => []);
  const readTerminal = vi.fn(async () => ({ history: "", status: "running", label: "Terminal 1" }));
  const writeTerminal = vi.fn(async () => {});
  const endVoiceSession = vi.fn();
  const setOrchestratorVoice = vi.fn(async () => {});
  return {
    world: new Map([["env-1:thread-a", snapshot()]]),
    authority: "full",
    confirmDestructiveActions: true,
    sendToThread,
    interruptThread,
    applyThreadSettings,
    renameThread,
    createThread,
    createSideChat,
    setThreadSettled,
    readThread,
    inspectProject,
    endVoiceSession,
    setOrchestratorVoice,
    listProjects: () => [
      {
        projectId: "project-1",
        environmentId: "env-1",
        name: "Rover Project",
        workspaceName: "rover",
      },
      {
        projectId: "project-2",
        environmentId: "env-1",
        name: "Vera Medical",
        workspaceName: "vera",
      },
    ],
    describeSelf: () => ({
      activeModel: "gpt-realtime-2.1",
      configuredModel: "gpt-realtime-2.1",
      activeVoice: "cedar",
      configuredVoice: "cedar",
      language: "en",
      authority: "full",
      confirmDestructiveActions: true,
      restartRequiredToApply: false,
    }),
    describeRuntime: () => ({
      appVersion: "0.1.119",
      environments: [{ name: "local", reachable: true, threadCount: 1 }],
      threadCounts: { total: 1, working: 1, idle: 0, error: 0, unreachable: 0 },
    }),
    openWebsite: vi.fn(async () => undefined),
    runCommand: vi.fn(async () => ({
      refused: false as const,
      stdout: "total 0\n",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      truncated: false,
    })),
    listTerminals,
    readTerminal,
    writeTerminal,
    createProject: vi.fn(async (input: { path: string; name?: string }) => ({
      projectId: "project-new",
      title: input.name ?? "SampleApp",
    })),
    readProposedPlans: vi.fn(async () => [
      {
        planId: "plan-1",
        planMarkdown: "# Migrate auth\n\n- Add the table\n- Backfill it\n",
        implementedAt: null,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ]),
    describeUsage: () => ({
      providers: [
        {
          name: "Claude",
          state: "available",
          reportedAt: "2026-01-01T00:00:00Z",
          windows: [
            { label: "weekly limit", usedPercent: 81, resetsAt: null, detail: null },
            { label: "current session", usedPercent: 12, resetsAt: null, detail: null },
          ],
        },
      ],
      voice: {
        today: { spokenMinutes: 4.2, estimatedCostUsd: 0.31, models: ["gpt-realtime-2.1"] },
        month: { spokenMinutes: 91.5, estimatedCostUsd: 7.4, models: ["gpt-realtime-2.1"] },
        allTime: { spokenMinutes: 240, estimatedCostUsd: 19.2, models: ["gpt-realtime-2.1"] },
      },
    }),
    planThreadSettings: () => ({
      changes: [
        { field: "model", from: "gpt-5.6-sol", to: "claude-opus-5", effectiveOn: "next-turn" },
      ],
      rejections: [],
      warnings: [],
      raisesPermissions: false,
    }),
    ...overrides,
  } as never;
};

describe("isToolAllowed", () => {
  it("ranks authority levels cumulatively", () => {
    expect(isToolAllowed("list_threads", "read-only")).toBe(true);
    expect(isToolAllowed("send_to_thread", "read-only")).toBe(false);
    expect(isToolAllowed("send_to_thread", "send")).toBe(true);
    expect(isToolAllowed("list_terminals", "read-only")).toBe(true);
    expect(isToolAllowed("write_to_terminal", "read-only")).toBe(false);
    expect(isToolAllowed("write_to_terminal", "send")).toBe(true);
    expect(isToolAllowed("interrupt_thread", "send")).toBe(false);
    expect(isToolAllowed("interrupt_thread", "full")).toBe(true);
  });

  it("rejects unknown tools at every level", () => {
    expect(isToolAllowed("rm_rf", "full")).toBe(false);
  });
});

describe("executeOrchestratorTool", () => {
  it("lists threads with a spoken-friendly status", async () => {
    const context = makeContext();
    const result = (await executeOrchestratorTool(context, {
      name: "list_threads",
      args: {},
    })) as { threads: ReadonlyArray<{ title: string; status: string }> };
    expect(result.threads).toEqual([
      {
        threadId: "thread-a",
        title: "Rover",
        status: "working",
        waitingOn: "nothing",
        isWorking: true,
        model: "gpt-5.6-sol",
        provider: "codex",
        accessMode: "full-access",
        interactionMode: "default",
        effort: "high",
        settled: false,
        project: "Rover Project",
        // Always present, including when false: an absent key reads as
        // "unknown" and the model guessed from the title instead.
        isSideChat: false,
        terminals: [],
      },
    ]);
  });

  it("tells the model which model each thread runs on", async () => {
    // Asked "what model is it using?", the orchestrator had no such field and
    // invented an explanation about the model appearing later on.
    const context = makeContext({
      world: new Map([
        ["env-1:thread-a", snapshot({ model: "claude-opus-5", provider: "claudeAgent" })],
      ]),
    });
    const result = (await executeOrchestratorTool(context, {
      name: "describe_thread",
      args: { threadId: "thread-a" },
    })) as { thread: { model: string; provider: string } };
    expect(result.thread.model).toBe("claude-opus-5");
    expect(result.thread.provider).toBe("claudeAgent");
  });

  it("says a side chat is one, and names the conversation it hangs off", async () => {
    // The orchestrator could see the thread but had no field for this, so it
    // described a side chat as an ordinary thread — and the user went looking
    // for it in the sidebar, where side chats never appear.
    const context = makeContext({
      world: new Map([
        [
          "env-1:thread-a",
          snapshot({
            threadId: "thread-a",
            title: "Sample App backlog",
            isSideChat: true,
            sideChatParentThreadId: "thread-parent",
          }),
        ],
        [
          "env-1:thread-parent",
          snapshot({
            threadKey: "env-1:thread-parent",
            threadId: "thread-parent",
            title: "Sample App",
          }),
        ],
      ]),
    });
    const result = (await executeOrchestratorTool(context, {
      name: "describe_thread",
      args: { threadId: "thread-a" },
    })) as { thread: { isSideChat: boolean; sideChatOf?: string } };
    expect(result.thread.isSideChat).toBe(true);
    expect(result.thread.sideChatOf).toBe("Sample App");
  });

  it("marks an ordinary thread as not a side chat rather than leaving it unknown", async () => {
    const context = makeContext();
    const result = (await executeOrchestratorTool(context, {
      name: "describe_thread",
      args: { threadId: "thread-a" },
    })) as { thread: { isSideChat: boolean; sideChatOf?: string } };
    expect(result.thread.isSideChat).toBe(false);
    expect(result.thread.sideChatOf).toBeUndefined();
  });

  it("omits the parent name when that conversation is no longer in the world", async () => {
    const context = makeContext({
      world: new Map([
        ["env-1:thread-a", snapshot({ isSideChat: true, sideChatParentThreadId: "gone" })],
      ]),
    });
    const result = (await executeOrchestratorTool(context, {
      name: "describe_thread",
      args: { threadId: "thread-a" },
    })) as { thread: { isSideChat: boolean; sideChatOf?: string } };
    expect(result.thread.isSideChat).toBe(true);
    expect(result.thread.sideChatOf).toBeUndefined();
  });

  it("carries the thread's last words with its status", async () => {
    // A status without them made every real answer need a second read_thread
    // call — and usually got given without one, from nothing.
    const context = makeContext({
      readThread: vi.fn(async () => ({
        messages: [
          {
            role: "user",
            text: "run the tests",
            turnId: null,
            streaming: false,
            createdAt: "2026-08-18T12:00:00.000Z",
          },
          {
            role: "assistant",
            text: "Done — all passing.",
            turnId: null,
            streaming: false,
            createdAt: "2026-08-18T12:01:00.000Z",
          },
        ],
        activities: [],
      })),
    });
    const result = (await executeOrchestratorTool(context, {
      name: "describe_thread",
      args: { threadId: "thread-a" },
    })) as { thread: { recentMessages?: ReadonlyArray<{ role: string; text: string }> } };
    expect(result.thread.recentMessages).toEqual([
      expect.objectContaining({ role: "user", text: "run the tests" }),
      expect.objectContaining({ role: "assistant", text: "Done — all passing." }),
    ]);
  });

  it("still answers the status when the history fetch fails", async () => {
    // Best-effort: an unreachable environment must cost the tail, not the tool.
    const context = makeContext({
      readThread: vi.fn(async () => {
        throw new Error("environment unreachable");
      }),
    });
    const result = (await executeOrchestratorTool(context, {
      name: "describe_thread",
      args: { threadId: "thread-a" },
    })) as { thread: { status: string; recentMessages?: unknown } };
    expect(result.thread.status).toBe("working");
    expect(result.thread.recentMessages).toBeUndefined();
  });

  it("reports an unreachable host rather than claiming idle", async () => {
    const context = makeContext({
      world: new Map([["env-1:thread-a", snapshot({ environmentUnreachable: true })]]),
    });
    const result = (await executeOrchestratorTool(context, {
      name: "describe_thread",
      args: { threadId: "thread-a" },
    })) as { thread: { status: string } };
    expect(result.thread.status).toBe("unreachable");
  });

  it("delivers straight away when the target is unambiguous", async () => {
    // Confirming every single message made the orchestrator exhausting to talk
    // to, and sending is not destructive. Ambiguity is the only thing worth
    // stopping for.
    const context = makeContext();
    const result = (await executeOrchestratorTool(context, {
      name: "send_to_thread",
      args: { thread: "Rover", message: "status?" },
    })) as { delivered: boolean };

    expect(result.delivered).toBe(true);
    expect(context.sendToThread).toHaveBeenCalledWith({
      environmentId: "env-1",
      threadId: "thread-a",
      message: "status?",
    });
  });

  it("asks which thread only when the name fits more than one", async () => {
    const context = makeContext({
      world: new Map([
        ["env-1:a", snapshot({ threadId: "a", threadKey: "env-1:a", title: "Vera Medical" })],
        ["env-1:b", snapshot({ threadId: "b", threadKey: "env-1:b", title: "Vera Medical" })],
      ]),
    });
    const result = (await executeOrchestratorTool(context, {
      name: "send_to_thread",
      args: { thread: "Vera Medical", message: "status?" },
    })) as { ambiguous: boolean; candidates: ReadonlyArray<unknown> };

    expect(result.ambiguous).toBe(true);
    expect(result.candidates).toHaveLength(2);
    expect(context.sendToThread).not.toHaveBeenCalled();
  });

  it("still accepts a raw thread id", async () => {
    const context = makeContext();
    await executeOrchestratorTool(context, {
      name: "send_to_thread",
      args: { threadId: "thread-a", message: "status?" },
    });
    expect(context.sendToThread).toHaveBeenCalled();
  });

  it("confirms what would stop before interrupting in-flight work", async () => {
    const context = makeContext();
    const result = (await executeOrchestratorTool(context, {
      name: "interrupt_thread",
      args: { threadId: "thread-a" },
    })) as {
      interrupted: boolean;
      confirmationRequired: boolean;
      willInterrupt: { title: string };
    };

    expect(result.interrupted).toBe(false);
    expect(result.confirmationRequired).toBe(true);
    // Naming the thread and its model is the whole point of the gate.
    expect(result.willInterrupt.title).toBe("Rover");
    expect(context.interruptThread).not.toHaveBeenCalled();

    await executeOrchestratorTool(context, {
      name: "interrupt_thread",
      args: { threadId: "thread-a", confirm: true },
    });
    expect(context.interruptThread).toHaveBeenCalledWith({
      environmentId: "env-1",
      threadId: "thread-a",
    });
  });

  it("refuses to interrupt a thread that is not running anything", async () => {
    // A no-op interrupt used to report success, leaving the user believing
    // something had been stopped.
    const context = makeContext({
      world: new Map([["env-1:thread-a", snapshot({ isWorking: false })]]),
    });
    const result = (await executeOrchestratorTool(context, {
      name: "interrupt_thread",
      args: { threadId: "thread-a", confirm: true },
    })) as { interrupted: boolean; reason: string };

    expect(result.interrupted).toBe(false);
    expect(result.reason).toBe("nothing-in-flight");
    expect(context.interruptThread).not.toHaveBeenCalled();
  });

  it("interrupts without a second round when confirmation is disabled", async () => {
    const context = makeContext({ confirmDestructiveActions: false });
    await executeOrchestratorTool(context, {
      name: "interrupt_thread",
      args: { threadId: "thread-a" },
    });
    expect(context.interruptThread).toHaveBeenCalled();
  });

  it("refuses a write above the configured authority, without dispatching", async () => {
    const context = makeContext({ authority: "read-only" });
    await expect(
      executeOrchestratorTool(context, {
        name: "send_to_thread",
        args: { threadId: "thread-a", message: "go", confirm: true },
      }),
    ).rejects.toBeInstanceOf(OrchestratorToolError);
    expect(context.sendToThread).not.toHaveBeenCalled();
  });

  it("refuses a control tool at send authority", async () => {
    // Guards against a model reusing a tool name after the setting changed
    // mid-session.
    const context = makeContext({ authority: "send" });
    await expect(
      executeOrchestratorTool(context, {
        name: "interrupt_thread",
        args: { threadId: "thread-a", confirm: true },
      }),
    ).rejects.toBeInstanceOf(OrchestratorToolError);
    expect(context.interruptThread).not.toHaveBeenCalled();
  });

  it("reports an unknown thread with the closest alternatives, without dispatching", async () => {
    // Throwing gave the model nothing to say back; naming what is open lets it
    // offer the right thread instead of a dead end.
    const context = makeContext();
    const result = (await executeOrchestratorTool(context, {
      name: "send_to_thread",
      args: { thread: "Atlantis", message: "hi", confirm: true },
    })) as { notFound: boolean; say: string };
    expect(result.notFound).toBe(true);
    expect(result.say).toContain("Atlantis");
    expect(context.sendToThread).not.toHaveBeenCalled();
  });

  it("rejects an empty message", async () => {
    const context = makeContext();
    await expect(
      executeOrchestratorTool(context, {
        name: "send_to_thread",
        args: { threadId: "thread-a", message: "   ", confirm: true },
      }),
    ).rejects.toBeInstanceOf(OrchestratorToolError);
    expect(context.sendToThread).not.toHaveBeenCalled();
  });

  it("rejects an unknown tool name", async () => {
    const context = makeContext();
    await expect(
      executeOrchestratorTool(context, { name: "drop_database", args: {} }),
    ).rejects.toBeInstanceOf(OrchestratorToolError);
  });
});

describe("create_project", () => {
  it("links an existing folder", async () => {
    const context = makeContext();
    const result = (await executeOrchestratorTool(context, {
      name: "create_project",
      args: { path: "/Users/example/code/SampleApp" },
    })) as { created: boolean; project: string };

    expect(context.createProject).toHaveBeenCalledWith({ path: "/Users/example/code/SampleApp" });
    expect(result.created).toBe(true);
    expect(result.project).toBe("SampleApp");
  });

  it("passes a name through when the user gave one", async () => {
    const context = makeContext();
    await executeOrchestratorTool(context, {
      name: "create_project",
      args: { path: "/Users/example/code/sample-app", name: "Sample App" },
    });
    expect(context.createProject).toHaveBeenCalledWith({
      path: "/Users/example/code/sample-app",
      name: "Sample App",
    });
  });

  it("refuses a relative path rather than guessing where it is", async () => {
    // A bare folder name from speech has no location; resolving it against
    // some default is how a project gets pointed at the wrong directory.
    const context = makeContext();
    await expect(
      executeOrchestratorTool(context, { name: "create_project", args: { path: "SampleApp" } }),
    ).rejects.toThrow(OrchestratorToolError);
    expect(context.createProject).not.toHaveBeenCalled();
  });

  it("asks for a path rather than creating something unnamed", async () => {
    const context = makeContext();
    await expect(
      executeOrchestratorTool(context, { name: "create_project", args: { path: "  " } }),
    ).rejects.toThrow(OrchestratorToolError);
  });
});

describe("approve_proposed_plan", () => {
  it("sends the implementation prompt out of plan mode", async () => {
    // The thread is in plan mode *because* it just proposed a plan; sending the
    // approval under its own mode would produce a second plan, not the work.
    const context = makeContext();
    const result = (await executeOrchestratorTool(context, {
      name: "approve_proposed_plan",
      args: { thread: "Rover" },
    })) as { approved: boolean };

    expect(result.approved).toBe(true);
    expect(context.sendToThread).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-a",
        interactionMode: "default",
        message: expect.stringContaining("PLEASE IMPLEMENT THIS PLAN"),
      }),
    );
  });

  it("refuses rather than approving something that is not waiting", async () => {
    const context = makeContext({ readProposedPlans: vi.fn(async () => []) });
    const result = (await executeOrchestratorTool(context, {
      name: "approve_proposed_plan",
      args: { thread: "Rover" },
    })) as { approved: boolean; say: string };

    expect(result.approved).toBe(false);
    expect(context.sendToThread).not.toHaveBeenCalled();
    expect(result.say).toContain("no plan waiting");
  });

  it("does not approve a plan that was already implemented", async () => {
    const context = makeContext({
      readProposedPlans: vi.fn(async () => [
        {
          planId: "plan-1",
          planMarkdown: "# Done already",
          implementedAt: "2026-01-01T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    });
    const result = (await executeOrchestratorTool(context, {
      name: "approve_proposed_plan",
      args: { thread: "Rover" },
    })) as { approved: boolean };
    expect(result.approved).toBe(false);
  });
});

describe("run_command", () => {
  it("runs what it was given and hands the output back for summarising", async () => {
    const context = makeContext();
    const result = (await executeOrchestratorTool(context, {
      name: "run_command",
      args: { command: "ls -la ~/Documents" },
    })) as { ran: boolean; stdout: string; say: string };

    expect(context.runCommand).toHaveBeenCalledWith({ command: "ls -la ~/Documents" });
    expect(result.ran).toBe(true);
    expect(result.stdout).toBe("total 0\n");
    // Reading a directory listing out loud is the obvious failure here.
    expect(result.say).toContain("Do not read it out line by line");
  });

  it("passes a working directory through when one is given", async () => {
    const context = makeContext();
    await executeOrchestratorTool(context, {
      name: "run_command",
      args: { command: "git status", cwd: "/Users/x/code" },
    });
    expect(context.runCommand).toHaveBeenCalledWith({
      command: "git status",
      cwd: "/Users/x/code",
    });
  });

  it("relays a refusal instead of pretending the command ran", async () => {
    const context = makeContext({
      runCommand: vi.fn(async () => ({
        refused: true as const,
        reason: "That would recursively delete a filesystem root.",
      })),
    });
    const result = (await executeOrchestratorTool(context, {
      name: "run_command",
      args: { command: "rm -rf /" },
    })) as { ran: boolean; reason: string };

    expect(result.ran).toBe(false);
    expect(result.reason).toContain("delete a filesystem root");
  });

  it("asks for the command rather than running an empty one", async () => {
    const context = makeContext();
    await expect(
      executeOrchestratorTool(context, { name: "run_command", args: { command: "   " } }),
    ).rejects.toThrow(OrchestratorToolError);
  });
});

describe("terminals", () => {
  const claude = {
    environmentId: "env-1",
    threadId: "thread-a",
    threadTitle: "Rover",
    terminalId: "term-1",
    label: "claude",
    status: "running",
    hasRunningSubprocess: true,
    cwd: "/tmp/rover",
  };

  it("lists terminals and attaches them to list_threads", async () => {
    const context = makeContext({
      listTerminals: vi.fn(async () => [claude]),
    });
    const listed = (await executeOrchestratorTool(context, {
      name: "list_terminals",
      args: {},
    })) as { terminals: ReadonlyArray<{ label: string; thread: string }> };
    expect(listed.terminals).toEqual([
      {
        thread: "Rover",
        terminalId: "term-1",
        label: "claude",
        status: "running",
        hasRunningSubprocess: true,
      },
    ]);

    const threads = (await executeOrchestratorTool(context, {
      name: "list_threads",
      args: {},
    })) as { threads: ReadonlyArray<{ terminals: ReadonlyArray<{ label: string }> }> };
    expect(threads.threads[0]?.terminals).toEqual([
      { terminalId: "term-1", label: "claude", status: "running", hasRunningSubprocess: true },
    ]);
  });

  it("reads a terminal by the name the user used", async () => {
    const context = makeContext({
      listTerminals: vi.fn(async () => [claude]),
      readTerminal: vi.fn(async () => ({
        history: "\u001b[32mready\u001b[0m\n",
        status: "running",
        label: "claude",
      })),
    });
    const result = (await executeOrchestratorTool(context, {
      name: "read_terminal",
      args: { terminal: "claude" },
    })) as { output: string; terminal: string };
    expect(result.output).toBe("ready\n");
    expect(result.terminal).toBe("claude");
    expect(context.readTerminal).toHaveBeenCalledWith({
      environmentId: "env-1",
      threadId: "thread-a",
      terminalId: "term-1",
    });
  });

  it("asks before typing into a terminal reached through an unconfident thread match", async () => {
    // "Type yes into Rovler" — nothing is titled Rovler, so the thread
    // resolves through the fuzzy tier, which is deliberately not confident.
    // The terminal inside that guessed thread resolves cleanly, and its
    // confidence used to be the only one the gate ever saw: the keystrokes
    // went into whichever thread fuzzy-matched first, and on a live shell a
    // submitted line executes.
    const context = makeContext({
      listTerminals: vi.fn(async () => [claude]),
    });
    const result = (await executeOrchestratorTool(context, {
      name: "write_to_terminal",
      args: { thread: "Rovler", terminal: "claude", text: "yes" },
    })) as { written: boolean; confirmationRequired?: boolean };
    expect(result.written).toBe(false);
    expect(result.confirmationRequired).toBe(true);
    expect(context.writeTerminal).not.toHaveBeenCalled();
  });

  it("rejects a write with no text instead of pressing Enter in a live shell", async () => {
    // The old "" default plus submit-by-default encoded a bare newline — which
    // runs whatever command is sitting at the prompt.
    const context = makeContext({
      listTerminals: vi.fn(async () => [claude]),
    });
    await expect(
      executeOrchestratorTool(context, {
        name: "write_to_terminal",
        args: { terminal: "claude" },
      }),
    ).rejects.toThrow(/text/i);
    expect(context.writeTerminal).not.toHaveBeenCalled();
  });

  it("types into a terminal and submits by default", async () => {
    const context = makeContext({
      listTerminals: vi.fn(async () => [claude]),
    });
    const result = (await executeOrchestratorTool(context, {
      name: "write_to_terminal",
      args: { terminal: "claude", text: "continue" },
    })) as { written: boolean; submitted: boolean };
    expect(result.written).toBe(true);
    expect(result.submitted).toBe(true);
    expect(context.writeTerminal).toHaveBeenCalledWith({
      environmentId: "env-1",
      threadId: "thread-a",
      terminalId: "term-1",
      data: "continue\r",
    });
  });

  it("is unavailable below send authority", async () => {
    await expect(
      executeOrchestratorTool(makeContext({ authority: "read-only" } as never), {
        name: "write_to_terminal",
        args: { text: "ls" },
      }),
    ).rejects.toThrow(/not permitted/i);
  });
});

describe("describe_thread while a plan is waiting", () => {
  const waiting = () =>
    makeContext({
      world: new Map([
        ["env-1:thread-a", snapshot({ waitingOn: "proposed-plan", isWorking: false })],
      ]),
    });

  it("says what the plan proposes and who has to approve it", async () => {
    const context = waiting();
    const result = (await executeOrchestratorTool(context, {
      name: "describe_thread",
      args: { thread: "Rover", reason: "user asked what Rover is doing" },
    })) as { proposedPlan: { title: string; stepCount: number; awaiting: string }; say: string };

    expect(result.proposedPlan.title).toBe("Migrate auth");
    expect(result.proposedPlan.stepCount).toBe(2);
    expect(result.proposedPlan.awaiting).toBe("user");
    expect(result.say).toContain("waiting for the user to approve");
  });

  it("does not fetch a plan for a thread that is not stopped on one", async () => {
    // The common path stays a single synchronous read of the world.
    const context = makeContext();
    await executeOrchestratorTool(context, {
      name: "describe_thread",
      args: { thread: "Rover", reason: "status" },
    });
    expect(context.readProposedPlans).not.toHaveBeenCalled();
  });

  it("says the plan could not be read rather than inventing one", async () => {
    const context = makeContext({
      world: new Map([["env-1:thread-a", snapshot({ waitingOn: "proposed-plan" })]]),
      readProposedPlans: vi.fn(async () => {
        throw new Error("offline");
      }),
    } as never);
    const result = (await executeOrchestratorTool(context, {
      name: "describe_thread",
      args: { thread: "Rover", reason: "status" },
    })) as { say: string; proposedPlan?: unknown };

    expect(result.proposedPlan).toBeUndefined();
    expect(result.say).toContain("could not be read");
  });

  it("treats an already-implemented plan as nothing to approve", async () => {
    const context = makeContext({
      world: new Map([["env-1:thread-a", snapshot({ waitingOn: "proposed-plan" })]]),
      readProposedPlans: vi.fn(async () => [
        {
          planId: "plan-1",
          planMarkdown: "# Done already",
          implementedAt: "2026-01-01T01:00:00Z",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ]),
    } as never);
    const result = (await executeOrchestratorTool(context, {
      name: "describe_thread",
      args: { thread: "Rover", reason: "status" },
    })) as { say: string };
    expect(result.say).toContain("could not be read");
  });
});

describe("open_website", () => {
  it("opens a named site", async () => {
    const context = makeContext();
    const result = (await executeOrchestratorTool(context, {
      name: "open_website",
      args: { site: "YouTube", reason: "user asked to put YouTube on" },
    })) as { opened: boolean; site: string; say: string };

    expect(result.opened).toBe(true);
    expect(result.site).toBe("YouTube");
    expect(context.openWebsite).toHaveBeenCalledWith("https://www.youtube.com/");
    // Nobody wants a URL read out loud.
    expect(result.say).toContain("Do not read the address out");
  });

  it("searches the site when given something to look for", async () => {
    const context = makeContext();
    await executeOrchestratorTool(context, {
      name: "open_website",
      args: { site: "you tube", query: "lofi beats", reason: "user asked for music" },
    });
    expect(context.openWebsite).toHaveBeenCalledWith(
      "https://www.youtube.com/results?search_query=lofi%20beats",
    );
  });

  it("opens nothing for a site it does not know", async () => {
    const context = makeContext();
    const result = (await executeOrchestratorTool(context, {
      name: "open_website",
      args: { site: "https://evil.example.com", reason: "user said so" },
    })) as { opened: boolean; say: string };

    // The catalog is the safety property: a URL the model produced must never
    // become a page that opens.
    expect(result.opened).toBe(false);
    expect(context.openWebsite).not.toHaveBeenCalled();
    expect(result.say).toContain("YouTube");
  });

  it("says the query was dropped when the site cannot search", async () => {
    const context = makeContext();
    const result = (await executeOrchestratorTool(context, {
      name: "open_website",
      args: { site: "Gmail", query: "invoices", reason: "user asked for mail" },
    })) as { opened: boolean; say: string };

    expect(result.opened).toBe(true);
    expect(context.openWebsite).toHaveBeenCalledWith("https://mail.google.com/");
    expect(result.say).toContain("does not support searching");
  });

  it("is available without any write authority", async () => {
    const context = makeContext({ authority: "read-only" } as never);
    const result = (await executeOrchestratorTool(context, {
      name: "open_website",
      args: { site: "Google", reason: "user asked" },
    })) as { opened: boolean };
    expect(result.opened).toBe(true);
  });
});

describe("get_usage", () => {
  const call = (args: Record<string, unknown>) =>
    executeOrchestratorTool(makeContext(), { name: "get_usage", args }) as Promise<{
      providers?: unknown;
      voice?: unknown;
      say: string;
    }>;

  it("leads with the window closest to its limit", async () => {
    const result = await call({ reason: "user asked how much is left" });
    // Not the first window, the busiest one — that is the only number someone
    // asking "how much have I used" actually wants.
    expect(result.say).toContain("81% of its weekly limit");
    expect(result.say).not.toContain("12%");
  });

  it("reports voice minutes and flags the money as an estimate", async () => {
    const result = await call({ reason: "user asked what this costs" });
    expect(result.say).toContain("about 4 minutes today");
    expect(result.say).toContain("estimate");
  });

  it("returns only the half that was asked for", async () => {
    const providersOnly = await call({ scope: "providers", reason: "quota" });
    expect(providersOnly.providers).toBeDefined();
    expect(providersOnly.voice).toBeUndefined();

    const voiceOnly = await call({ scope: "voice", reason: "cost" });
    expect(voiceOnly.voice).toBeDefined();
    expect(voiceOnly.providers).toBeUndefined();
    expect(voiceOnly.say).not.toContain("weekly limit");
  });

  it("says nothing was reported rather than implying nothing was used", async () => {
    const context = makeContext({
      describeUsage: () => ({
        providers: [
          { name: "Codex", state: "unavailable", reportedAt: null, windows: [] as never },
        ],
        voice: {
          today: { spokenMinutes: 0, estimatedCostUsd: 0, models: [] },
          month: { spokenMinutes: 0, estimatedCostUsd: 0, models: [] },
          allTime: { spokenMinutes: 0, estimatedCostUsd: 0, models: [] },
        },
      }),
    } as never);
    const result = (await executeOrchestratorTool(context, {
      name: "get_usage",
      args: { scope: "providers", reason: "quota" },
    })) as { say: string };
    expect(result.say).toContain("No provider has reported");
  });

  it("does not turn an unknown cost into zero dollars", async () => {
    // A model with no published rate makes the bucket's total unknown; saying
    // "$0.00" would be a wrong answer rather than a missing one.
    const context = makeContext({
      describeUsage: () => ({
        providers: [],
        voice: {
          today: { spokenMinutes: 9, estimatedCostUsd: null, models: ["unpriced-model"] },
          month: { spokenMinutes: 9, estimatedCostUsd: null, models: ["unpriced-model"] },
          allTime: { spokenMinutes: 9, estimatedCostUsd: null, models: ["unpriced-model"] },
        },
      }),
    } as never);
    const result = (await executeOrchestratorTool(context, {
      name: "get_usage",
      args: { scope: "voice", reason: "cost" },
    })) as { say: string };
    expect(result.say).toContain("about 9 minutes");
    expect(result.say).not.toContain("$");
  });

  it("says under a minute rather than zero on a quiet day", async () => {
    const context = makeContext({
      describeUsage: () => ({
        providers: [],
        voice: {
          today: { spokenMinutes: 0.4, estimatedCostUsd: 0, models: [] },
          month: { spokenMinutes: 0.4, estimatedCostUsd: 0, models: [] },
          allTime: { spokenMinutes: 0.4, estimatedCostUsd: 0, models: [] },
        },
      }),
    } as never);
    const result = (await executeOrchestratorTool(context, {
      name: "get_usage",
      args: { scope: "voice", reason: "cost" },
    })) as { say: string };
    expect(result.say).toContain("under a minute");
  });
});

describe("get_orchestrator_settings", () => {
  it("reports the running model, not just the configured one", async () => {
    const context = makeContext();
    const result = (await executeOrchestratorTool(context, {
      name: "get_orchestrator_settings",
      args: { reason: "user asked what model I use" },
    })) as { activeModel: string; restartRequiredToApply: boolean };
    expect(result.activeModel).toBe("gpt-realtime-2.1");
    expect(result.restartRequiredToApply).toBe(false);
  });

  it("says a settings edit needs the voice session restarted, not the app", async () => {
    const context = makeContext({
      describeSelf: () => ({
        activeModel: "gpt-realtime",
        configuredModel: "gpt-realtime-2.1",
        activeVoice: "cedar",
        configuredVoice: "cedar",
        language: "en",
        authority: "full",
        confirmDestructiveActions: true,
        restartRequiredToApply: true,
      }),
    } as never);
    const result = (await executeOrchestratorTool(context, {
      name: "get_orchestrator_settings",
      args: {},
    })) as { say: string };
    expect(result.say).toContain("stop and start voice");
    expect(result.say).toContain("no app restart");
  });
});

describe("update_thread_settings", () => {
  const settingsContext = (overrides: Record<string, unknown> = {}) =>
    makeContext(overrides as never);

  it("reports the before/after and when each field lands before a confirmed change", async () => {
    // The default snapshot is mid-turn, so applyNow makes this destructive and
    // the plan has to be read back first.
    const context = settingsContext();
    const result = (await executeOrchestratorTool(context, {
      name: "update_thread_settings",
      args: { thread: "Rover", model: "claude-opus-5" },
    })) as { applied: boolean; confirmationRequired: boolean; takesEffectNextTurn: string[] };
    expect(result.applied).toBe(false);
    expect(result.confirmationRequired).toBe(true);
    expect(result.takesEffectNextTurn).toEqual(["model"]);
    expect(context.applyThreadSettings).not.toHaveBeenCalled();
  });

  it("applies once confirmed", async () => {
    const context = settingsContext();
    const result = (await executeOrchestratorTool(context, {
      name: "update_thread_settings",
      args: { threadId: "thread-a", model: "claude-opus-5", confirm: true },
    })) as { applied: boolean };
    expect(result.applied).toBe(true);
    expect(context.applyThreadSettings).toHaveBeenCalledTimes(1);
  });

  it("confirms a permission raise even when the user turned confirmations off", async () => {
    // Handing an agent broader filesystem and command access is not something
    // a misheard sentence should be able to do, whatever the general setting.
    const context = settingsContext({
      confirmDestructiveActions: false,
      planThreadSettings: () => ({
        changes: [
          {
            field: "accessMode",
            from: "approval-required",
            to: "full-access",
            effectiveOn: "immediately",
          },
        ],
        rejections: [],
        warnings: [],
        raisesPermissions: true,
      }),
    });
    const result = (await executeOrchestratorTool(context, {
      name: "update_thread_settings",
      args: { threadId: "thread-a", accessMode: "full-access" },
    })) as { confirmationRequired: boolean; say: string };
    expect(result.confirmationRequired).toBe(true);
    expect(result.say).toContain("broader access");
    expect(context.applyThreadSettings).not.toHaveBeenCalled();
  });

  it("passes a narrowing straight through when confirmations are off", async () => {
    const context = settingsContext({
      confirmDestructiveActions: false,
      planThreadSettings: () => ({
        changes: [
          {
            field: "accessMode",
            from: "full-access",
            to: "approval-required",
            effectiveOn: "immediately",
          },
        ],
        rejections: [],
        warnings: [],
        raisesPermissions: false,
      }),
    });
    const result = (await executeOrchestratorTool(context, {
      name: "update_thread_settings",
      args: { threadId: "thread-a", accessMode: "approval-required" },
    })) as { applied: boolean };
    expect(result.applied).toBe(true);
  });

  it("warns before stopping a turn to apply a change now", async () => {
    const context = settingsContext({ confirmDestructiveActions: false });
    const result = (await executeOrchestratorTool(context, {
      name: "update_thread_settings",
      args: { threadId: "thread-a", model: "claude-opus-5", applyNow: true },
    })) as { willStopCurrentTurn: boolean; say: string };
    expect(result.willStopCurrentTurn).toBe(true);
    expect(result.say).toContain("stops the turn");
  });

  it("surfaces validation problems instead of applying a guess", async () => {
    const context = settingsContext({
      planThreadSettings: () => ({
        changes: [],
        rejections: ['"turbo" is not a valid effort. Valid values: low, high.'],
        warnings: [],
        raisesPermissions: false,
      }),
    });
    const result = (await executeOrchestratorTool(context, {
      name: "update_thread_settings",
      args: { threadId: "thread-a", effort: "turbo", confirm: true },
    })) as { applied: boolean; problems: string[] };
    expect(result.applied).toBe(false);
    expect(result.problems[0]).toContain("low, high");
    expect(context.applyThreadSettings).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range mode without reaching the planner", async () => {
    await expect(
      executeOrchestratorTool(makeContext(), {
        name: "update_thread_settings",
        args: { threadId: "thread-a", accessMode: "yolo" },
      }),
    ).rejects.toThrow(/approval-required/);
  });

  it("refuses a call that changes nothing", async () => {
    await expect(
      executeOrchestratorTool(makeContext(), {
        name: "update_thread_settings",
        args: { threadId: "thread-a" },
      }),
    ).rejects.toThrow(OrchestratorToolError);
  });

  it("is unavailable below full authority", async () => {
    await expect(
      executeOrchestratorTool(makeContext({ authority: "send" } as never), {
        name: "update_thread_settings",
        args: { threadId: "thread-a", accessMode: "full-access" },
      }),
    ).rejects.toThrow(/not permitted/i);
  });
});

describe("tool logging", () => {
  it("records the name, the model's stated reason, and the outcome", async () => {
    const entries: Array<{ name: string; reason: string | null; outcome: string }> = [];
    const context = makeContext({
      onToolCall: (entry: OrchestratorToolLogEntry) => entries.push(entry),
    } as never);
    await executeOrchestratorTool(context, {
      name: "list_threads",
      args: { reason: "user asked what is running" },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: "list_threads",
      reason: "user asked what is running",
      outcome: "ok",
    });
  });

  it("records failures too, so a silent tool error is still visible", async () => {
    const entries: Array<{ outcome: string; detail: string }> = [];
    const context = makeContext({
      onToolCall: (entry: OrchestratorToolLogEntry) => entries.push(entry),
    } as never);
    await executeOrchestratorTool(context, { name: "describe_thread", args: { thread: "ghost" } });
    expect(entries[0]?.outcome).toBe("error");
    expect(entries[0]?.detail).toContain("ghost");
  });

  it("marks a held-back action as needing confirmation rather than done", async () => {
    const entries: Array<{ outcome: string }> = [];
    const context = makeContext({
      onToolCall: (entry: OrchestratorToolLogEntry) => entries.push(entry),
    } as never);
    await executeOrchestratorTool(context, {
      name: "interrupt_thread",
      args: { threadId: "thread-a" },
    });
    expect(entries[0]?.outcome).toBe("needs-confirmation");
  });

  it("reports null when the model called a tool without saying why", async () => {
    const entries: Array<{ reason: string | null }> = [];
    const context = makeContext({
      onToolCall: (entry: OrchestratorToolLogEntry) => entries.push(entry),
    } as never);
    await executeOrchestratorTool(context, { name: "list_threads", args: {} });
    expect(entries[0]?.reason).toBeNull();
  });
});

describe("rename_thread", () => {
  const renameContext = (overrides: Record<string, unknown> = {}) =>
    makeContext(overrides as never) as never as {
      renameThread: ReturnType<typeof vi.fn>;
    } & OrchestratorToolContext;

  it("renames without asking, because renaming is reversible", async () => {
    const context = renameContext();
    const result = (await executeOrchestratorTool(context, {
      name: "rename_thread",
      args: { thread: "Rover", title: "Rover — auth retry", reason: "user asked" },
    })) as { renamed: boolean; to: string };

    expect(result.renamed).toBe(true);
    expect(context.renameThread).toHaveBeenCalledWith({
      environmentId: "env-1",
      threadId: "thread-a",
      title: "Rover — auth retry",
    });
  });

  it("collapses dictated whitespace into a usable title", async () => {
    const context = renameContext();
    await executeOrchestratorTool(context, {
      name: "rename_thread",
      args: { thread: "Rover", title: "  Vera   Medical\n intake  " },
    });
    expect(context.renameThread).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Vera Medical intake" }),
    );
  });

  it("refuses an empty title", async () => {
    await expect(
      executeOrchestratorTool(makeContext(), {
        name: "rename_thread",
        args: { thread: "Rover", title: "   " },
      }),
    ).rejects.toThrow(OrchestratorToolError);
  });

  it("refuses a dictated paragraph as a title", async () => {
    // Speech can hand over a whole sentence; the sidebar has to stay readable.
    await expect(
      executeOrchestratorTool(makeContext(), {
        name: "rename_thread",
        args: { thread: "Rover", title: "a".repeat(200) },
      }),
    ).rejects.toThrow(/under 80/);
  });

  it("does nothing when the name already matches", async () => {
    const context = renameContext();
    const result = (await executeOrchestratorTool(context, {
      name: "rename_thread",
      args: { thread: "Rover", title: "Rover" },
    })) as { renamed: boolean; reason: string };
    expect(result.renamed).toBe(false);
    expect(result.reason).toBe("already-named");
    expect(context.renameThread).not.toHaveBeenCalled();
  });

  it("asks which thread when the name fits several, before renaming any", async () => {
    const context = renameContext({
      world: new Map([
        ["env-1:a", snapshot({ threadId: "a", threadKey: "env-1:a", title: "Vera Medical" })],
        ["env-1:b", snapshot({ threadId: "b", threadKey: "env-1:b", title: "Vera Medical" })],
      ]),
    });
    const result = (await executeOrchestratorTool(context, {
      name: "rename_thread",
      args: { thread: "Vera Medical", title: "Vera Medical intake" },
    })) as { ambiguous: boolean };
    expect(result.ambiguous).toBe(true);
    expect(context.renameThread).not.toHaveBeenCalled();
  });

  it("is unavailable at read-only authority", async () => {
    await expect(
      executeOrchestratorTool(makeContext({ authority: "read-only" } as never), {
        name: "rename_thread",
        args: { thread: "Rover", title: "Anything" },
      }),
    ).rejects.toThrow(/not permitted/i);
  });
});

describe("read_thread action chaining", () => {
  it("tells the model to finish an action instead of stopping at a suggestion", async () => {
    const context = makeContext({
      readThread: vi.fn(async () => ({
        messages: [
          {
            messageId: "message-1",
            turnId: "turn-1",
            role: "assistant",
            text: "The runtime scene and vehicle controller are the current work.",
            createdAt: "2026-08-21T19:36:00.000Z",
            streaming: false,
          },
        ],
        activities: [],
      })),
    });

    const result = (await executeOrchestratorTool(context, {
      name: "read_thread",
      args: { thread: "Rover", reason: "choose a better title" },
    })) as { say: string };

    expect(result.say).toContain("call the action tool now");
    expect(result.say).toContain("do not stop at a suggestion");
  });
});

describe("confirmation is reserved for genuinely destructive changes", () => {
  it("changes a model on an idle thread without asking, and applies it for real", async () => {
    // Swapping a model is reversible and disturbs nothing; asking every time
    // was pure friction. And it must actually apply — dispatching the command
    // alone leaves the thread talking to the old model.
    const context = makeContext({
      world: new Map([["env-1:thread-a", snapshot({ isWorking: false })]]),
    });
    const result = (await executeOrchestratorTool(context, {
      name: "update_thread_settings",
      args: { thread: "Rover", model: "claude-opus-5" },
    })) as { applied: boolean; activeNow: boolean };
    expect(result.applied).toBe(true);
    expect(result.activeNow).toBe(true);
    expect(context.applyThreadSettings).toHaveBeenCalledWith(
      expect.objectContaining({ applyNow: true }),
    );
  });

  it("does not ask permission to carry out the change that was just requested", async () => {
    // "It should do so without re-asking the user if it's OK, since they
    // literally just asked for that."
    const context = makeContext({
      world: new Map([["env-1:thread-a", snapshot({ isWorking: false })]]),
    });
    const result = (await executeOrchestratorTool(context, {
      name: "update_thread_settings",
      args: { thread: "Rover", model: "claude-opus-5", effort: "high" },
    })) as { confirmationRequired?: boolean };
    expect(result.confirmationRequired).toBeUndefined();
  });

  it("queues instead of applying only when explicitly asked to", async () => {
    const context = makeContext({
      world: new Map([["env-1:thread-a", snapshot({ isWorking: false })]]),
    });
    const result = (await executeOrchestratorTool(context, {
      name: "update_thread_settings",
      args: { thread: "Rover", model: "claude-opus-5", applyNow: false },
    })) as { activeNow: boolean };
    expect(result.activeNow).toBe(false);
  });

  it("still asks before widening access", async () => {
    const context = makeContext({
      confirmDestructiveActions: false,
      planThreadSettings: () => ({
        changes: [
          {
            field: "accessMode",
            from: "approval-required",
            to: "full-access",
            effectiveOn: "immediately",
          },
        ],
        rejections: [],
        warnings: [],
        raisesPermissions: true,
      }),
    } as never);
    const result = (await executeOrchestratorTool(context, {
      name: "update_thread_settings",
      args: { thread: "Rover", accessMode: "full-access" },
    })) as { confirmationRequired: boolean };
    expect(result.confirmationRequired).toBe(true);
  });

  it("still asks before stopping a turn in progress", async () => {
    const context = makeContext({ confirmDestructiveActions: false });
    const result = (await executeOrchestratorTool(context, {
      name: "update_thread_settings",
      args: { thread: "Rover", model: "claude-opus-5" },
    })) as { confirmationRequired: boolean };
    expect(result.confirmationRequired).toBe(true);
  });
});

describe("create_thread", () => {
  const createContext = (overrides: Record<string, unknown> = {}) =>
    makeContext(overrides as never) as never as {
      createThread: ReturnType<typeof vi.fn>;
    } & OrchestratorToolContext;

  it("starts a thread in the named project and sends the first message", async () => {
    const context = createContext();
    const result = (await executeOrchestratorTool(context, {
      name: "create_thread",
      args: {
        project: "Vera Medical",
        title: "Intake form validation",
        message: "Add validation to the intake form.",
        reason: "unrelated to any open thread",
      },
    })) as { created: boolean; project: string };

    expect(result.created).toBe(true);
    expect(result.project).toBe("Vera Medical");
    expect(context.createThread).toHaveBeenCalledWith({
      environmentId: "env-1",
      projectId: "project-2",
      title: "Intake form validation",
      message: "Add validation to the intake form.",
    });
  });

  it("matches a project said the way people say it", async () => {
    const context = createContext();
    await executeOrchestratorTool(context, {
      name: "create_thread",
      args: { project: "the vera medical project", title: "Billing", message: "Start billing." },
    });
    expect(context.createThread).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-2" }),
    );
  });

  it("does not ask which project when there is only one", async () => {
    // Asking a question with exactly one possible answer is the friction the
    // user complained about.
    const context = createContext({
      listProjects: () => [
        {
          projectId: "only",
          environmentId: "env-1",
          name: "Rover Project",
          workspaceName: "rover",
        },
      ],
    });
    const result = (await executeOrchestratorTool(context, {
      name: "create_thread",
      args: { title: "Something new", message: "Go." },
    })) as { created: boolean };
    expect(result.created).toBe(true);
  });

  it("asks which project only when several exist and none was named", async () => {
    const context = createContext();
    const result = (await executeOrchestratorTool(context, {
      name: "create_thread",
      args: { title: "Something new", message: "Go." },
    })) as { created: boolean; needsProject: boolean };
    expect(result.created).toBe(false);
    expect(result.needsProject).toBe(true);
    expect(context.createThread).not.toHaveBeenCalled();
  });

  it("reports an unknown project instead of inventing one", async () => {
    const context = createContext();
    const result = (await executeOrchestratorTool(context, {
      name: "create_thread",
      args: { project: "Atlantis", title: "X", message: "Go." },
    })) as { notFound: boolean };
    expect(result.notFound).toBe(true);
    expect(context.createThread).not.toHaveBeenCalled();
  });

  it("validates the title like a rename does", async () => {
    await expect(
      executeOrchestratorTool(makeContext(), {
        name: "create_thread",
        args: { project: "Rover Project", title: "  ", message: "Go." },
      }),
    ).rejects.toThrow(OrchestratorToolError);
  });

  it("is unavailable at read-only authority", async () => {
    await expect(
      executeOrchestratorTool(makeContext({ authority: "read-only" } as never), {
        name: "create_thread",
        args: { project: "Rover Project", title: "X", message: "Go." },
      }),
    ).rejects.toThrow(/not permitted/i);
  });
});

describe("read-only project inspection", () => {
  const fileContext = (overrides: Record<string, unknown> = {}) =>
    makeContext(overrides as never) as never as {
      inspectProject: ReturnType<typeof vi.fn>;
    } & OrchestratorToolContext;

  it("reads a file in the named project", async () => {
    const context = fileContext();
    await executeOrchestratorTool(context, {
      name: "read_project_file",
      args: {
        project: "Vera Medical",
        path: "src/main.tsx",
        reason: "user asked what the entry point does",
      },
    });
    expect(context.inspectProject).toHaveBeenCalledWith({
      environmentId: "env-1",
      projectId: "project-2",
      action: "read",
      path: "src/main.tsx",
    });
  });

  it("lists a project's layout without a path", async () => {
    const context = fileContext();
    await executeOrchestratorTool(context, {
      name: "list_project_files",
      args: { project: "Rover Project" },
    });
    expect(context.inspectProject).toHaveBeenCalledWith(
      expect.objectContaining({ action: "list", projectId: "project-1" }),
    );
  });

  it("searches file contents", async () => {
    const context = fileContext();
    await executeOrchestratorTool(context, {
      name: "search_project",
      args: { project: "Rover Project", query: "buildSessionUpdate" },
    });
    expect(context.inspectProject).toHaveBeenCalledWith(
      expect.objectContaining({ action: "search", query: "buildSessionUpdate" }),
    );
  });

  it("finds files by partial name", async () => {
    const context = fileContext();
    await executeOrchestratorTool(context, {
      name: "find_project_files",
      args: { project: "Rover Project", query: "realtimeSession" },
    });
    expect(context.inspectProject).toHaveBeenCalledWith(
      expect.objectContaining({ action: "find", query: "realtimeSession" }),
    );
  });

  it("requires a path to read a file", async () => {
    await expect(
      executeOrchestratorTool(makeContext(), {
        name: "read_project_file",
        args: { project: "Rover Project" },
      }),
    ).rejects.toThrow(OrchestratorToolError);
  });

  it("is available at read-only authority, since it changes nothing", async () => {
    const context = fileContext({ authority: "read-only" });
    await executeOrchestratorTool(context, {
      name: "read_project_file",
      args: { project: "Rover Project", path: "README.md" },
    });
    expect(context.inspectProject).toHaveBeenCalled();
  });

  it("asks which project only when several exist and none was named", async () => {
    const context = fileContext();
    const result = (await executeOrchestratorTool(context, {
      name: "list_project_files",
      args: {},
    })) as { needsProject: boolean };
    expect(result.needsProject).toBe(true);
    expect(context.inspectProject).not.toHaveBeenCalled();
  });

  it("does not ask when there is only one project", async () => {
    const context = fileContext({
      listProjects: () => [
        {
          projectId: "only",
          environmentId: "env-1",
          name: "Rover Project",
          workspaceName: "rover",
        },
      ],
    });
    await executeOrchestratorTool(context, { name: "list_project_files", args: {} });
    expect(context.inspectProject).toHaveBeenCalled();
  });
});

describe("create_side_chat", () => {
  const sideContext = (overrides: Record<string, unknown> = {}) =>
    makeContext(overrides as never) as never as {
      createSideChat: ReturnType<typeof vi.fn>;
      createThread: ReturnType<typeof vi.fn>;
    } & OrchestratorToolContext;

  it("forks off the named thread without disturbing it", async () => {
    const context = sideContext();
    const result = (await executeOrchestratorTool(context, {
      name: "create_side_chat",
      args: {
        thread: "Rover",
        title: "Why the retry loop?",
        message: "Why did you add a retry there?",
        reason: "question about work in progress",
      },
    })) as { created: boolean; parent: string };

    expect(result.created).toBe(true);
    expect(result.parent).toBe("Rover");
    expect(context.createSideChat).toHaveBeenCalledWith({
      environmentId: "env-1",
      threadId: "thread-a",
      title: "Why the retry loop?",
      message: "Why did you add a retry there?",
    });
    // A side chat is not a new thread; confusing the two loses the context.
    expect(context.createThread).not.toHaveBeenCalled();
  });

  it("asks which thread when the name fits several, before forking any", async () => {
    const context = sideContext({
      world: new Map([
        ["env-1:a", snapshot({ threadId: "a", threadKey: "env-1:a", title: "Vera Medical" })],
        ["env-1:b", snapshot({ threadId: "b", threadKey: "env-1:b", title: "Vera Medical" })],
      ]),
    });
    const result = (await executeOrchestratorTool(context, {
      name: "create_side_chat",
      args: { thread: "Vera Medical", title: "Q", message: "status?" },
    })) as { ambiguous: boolean };
    expect(result.ambiguous).toBe(true);
    expect(context.createSideChat).not.toHaveBeenCalled();
  });

  it("validates the title", async () => {
    await expect(
      executeOrchestratorTool(makeContext(), {
        name: "create_side_chat",
        args: { thread: "Rover", title: "  ", message: "hi" },
      }),
    ).rejects.toThrow(OrchestratorToolError);
  });

  it("requires a first message", async () => {
    await expect(
      executeOrchestratorTool(makeContext(), {
        name: "create_side_chat",
        args: { thread: "Rover", title: "Q", message: "" },
      }),
    ).rejects.toThrow(OrchestratorToolError);
  });

  it("is unavailable at read-only authority", async () => {
    await expect(
      executeOrchestratorTool(makeContext({ authority: "read-only" } as never), {
        name: "create_side_chat",
        args: { thread: "Rover", title: "Q", message: "hi" },
      }),
    ).rejects.toThrow(/not permitted/i);
  });
});

describe("settle_thread", () => {
  const settleContext = (overrides: Record<string, unknown> = {}) =>
    makeContext(overrides as never) as never as {
      setThreadSettled: ReturnType<typeof vi.fn>;
    } & OrchestratorToolContext;

  it("marks an idle thread settled without asking", async () => {
    // Cleanup is the whole point; a confirmation round trip defeats it.
    const context = settleContext({
      world: new Map([["env-1:thread-a", snapshot({ isWorking: false })]]),
    });
    const result = (await executeOrchestratorTool(context, {
      name: "settle_thread",
      args: { thread: "Rover", reason: "user said they are done with it" },
    })) as { settled: boolean; stillVisible: boolean };

    expect(result.settled).toBe(true);
    expect(context.setThreadSettled).toHaveBeenCalledWith({
      environmentId: "env-1",
      threadId: "thread-a",
      settled: true,
    });
  });

  it("records state only and leaves the thread visible", async () => {
    // Settling must never hide or archive anything.
    const context = settleContext({
      world: new Map([["env-1:thread-a", snapshot({ isWorking: false })]]),
    });
    const result = (await executeOrchestratorTool(context, {
      name: "settle_thread",
      args: { thread: "Rover" },
    })) as { stillVisible: boolean; say: string };
    expect(result.stillVisible).toBe(true);
    expect(result.say).toContain("still in the sidebar");
  });

  it("reports offline settlement as queued until the environment reconnects", async () => {
    const context = settleContext({
      world: new Map([["env-1:thread-a", snapshot({ isWorking: false })]]),
      setThreadSettled: vi.fn(async () => ({ deferred: true })),
    });
    const result = (await executeOrchestratorTool(context, {
      name: "settle_thread",
      args: { thread: "Rover" },
    })) as { queued: boolean; say: string };

    expect(result.queued).toBe(true);
    expect(result.say).toContain("when its computer reconnects");
  });

  it("checks before calling running work finished", async () => {
    // The default fixture is mid-turn.
    const context = settleContext();
    const result = (await executeOrchestratorTool(context, {
      name: "settle_thread",
      args: { thread: "Rover" },
    })) as { confirmationRequired: boolean };
    expect(result.confirmationRequired).toBe(true);
    expect(context.setThreadSettled).not.toHaveBeenCalled();
  });

  it("settles running work once confirmed", async () => {
    const context = settleContext();
    await executeOrchestratorTool(context, {
      name: "settle_thread",
      args: { thread: "Rover", confirm: true },
    });
    expect(context.setThreadSettled).toHaveBeenCalled();
  });

  it("un-settles on undo, with no confirmation needed", async () => {
    const context = settleContext();
    const result = (await executeOrchestratorTool(context, {
      name: "settle_thread",
      args: { thread: "Rover", undo: true },
    })) as { settled: boolean };
    expect(result.settled).toBe(false);
    expect(context.setThreadSettled).toHaveBeenCalledWith(
      expect.objectContaining({ settled: false }),
    );
  });

  it("asks which thread when the name fits several", async () => {
    const context = settleContext({
      world: new Map([
        [
          "env-1:a",
          snapshot({ threadId: "a", threadKey: "env-1:a", title: "Vera", isWorking: false }),
        ],
        [
          "env-1:b",
          snapshot({ threadId: "b", threadKey: "env-1:b", title: "Vera", isWorking: false }),
        ],
      ]),
    });
    const result = (await executeOrchestratorTool(context, {
      name: "settle_thread",
      args: { thread: "Vera" },
    })) as { ambiguous: boolean };
    expect(result.ambiguous).toBe(true);
    expect(context.setThreadSettled).not.toHaveBeenCalled();
  });

  it("is unavailable at read-only authority", async () => {
    await expect(
      executeOrchestratorTool(makeContext({ authority: "read-only" } as never), {
        name: "settle_thread",
        args: { thread: "Rover" },
      }),
    ).rejects.toThrow(/not permitted/i);
  });
});

describe("confirmation is asked once, not once per reason", () => {
  const raiseAndSwitchPlan = () => ({
    changes: [
      {
        field: "accessMode" as const,
        from: "approval-required",
        to: "full-access",
        effectiveOn: "immediately" as const,
      },
      // A deferred change is what makes this need a turn, and therefore what
      // puts the running turn at risk.
      {
        field: "model" as const,
        from: "gpt-5.6-sol",
        to: "claude-opus-5",
        effectiveOn: "next-turn" as const,
      },
    ],
    rejections: [],
    warnings: [],
    raisesPermissions: true,
  });

  it("collects every reason into a single question", async () => {
    // Reported: the apply-now path asked repeatedly before the interrupt. A
    // change that both stops a turn and widens access must be one question —
    // asking twice reads as the first yes not having registered.
    const context = makeContext({ planThreadSettings: raiseAndSwitchPlan } as never);
    const result = (await executeOrchestratorTool(context, {
      name: "update_thread_settings",
      args: { thread: "Rover", accessMode: "full-access", model: "claude-opus-5" },
    })) as { confirmationReasons: ReadonlyArray<string>; say: string };

    expect(result.confirmationReasons).toHaveLength(2);
    expect(result.confirmationReasons.join(" ")).toContain("broader access");
    expect(result.confirmationReasons.join(" ")).toContain("stops the turn");
    expect(result.say).toContain("single question");
    expect(result.say).toContain("do not ask again");
  });

  it("applies on the first confirmed call, however many reasons there were", async () => {
    const context = makeContext({ planThreadSettings: raiseAndSwitchPlan } as never);
    const result = (await executeOrchestratorTool(context, {
      name: "update_thread_settings",
      args: {
        thread: "Rover",
        accessMode: "full-access",
        model: "claude-opus-5",
        confirm: true,
      },
    })) as { applied: boolean };
    expect(result.applied).toBe(true);
    expect(context.applyThreadSettings).toHaveBeenCalledTimes(1);
  });
});

describe("an immediate-only change never stops a turn", () => {
  it("applies an access-mode change to a working thread without a turn", async () => {
    // Access mode reaches the live session through its own command. Forcing a
    // turn for it would stop work in progress to deliver something that had
    // already arrived.
    const context = makeContext({
      confirmDestructiveActions: false,
      planThreadSettings: () => ({
        changes: [
          {
            field: "accessMode",
            from: "full-access",
            to: "approval-required",
            effectiveOn: "immediately",
          },
        ],
        rejections: [],
        warnings: [],
        raisesPermissions: false,
      }),
    } as never);
    const result = (await executeOrchestratorTool(context, {
      name: "update_thread_settings",
      args: { thread: "Rover", accessMode: "approval-required" },
    })) as { applied: boolean; activeNow: boolean; say: string };
    expect(result.applied).toBe(true);
    // No turn is forced — but the change is still live, because access mode
    // dispatches straight to the session. Reporting activeNow: false here made
    // the orchestrator tell the user their lockdown had not landed when it had.
    expect(result.activeNow).toBe(true);
    expect(result.say).toContain("applied");
    expect(context.applyThreadSettings).toHaveBeenCalledWith(
      expect.objectContaining({ applyNow: false }),
    );
  });
});

describe("reading and searching thread contents", () => {
  const conversation = [
    {
      role: "user",
      text: "why did the native quest render break?",
      turnId: "turn-1",
      streaming: false,
      createdAt: "2026-08-17T09:00:00.000Z",
    },
    {
      role: "assistant",
      text: "The draw call batching regressed in the last commit.",
      turnId: "turn-1",
      streaming: false,
      createdAt: "2026-08-17T09:01:00.000Z",
    },
  ];

  it("reads what a thread actually said instead of only its status", async () => {
    const readThread = vi.fn(async () => ({ messages: conversation, activities: [] }));
    const context = makeContext({ readThread });

    const result = (await executeOrchestratorTool(context, {
      name: "read_thread",
      args: { thread: "Rover", reason: "user asked what it found" },
    })) as { thread: string; messages: ReadonlyArray<{ role: string; text: string }> };

    expect(readThread).toHaveBeenCalledWith({ environmentId: "env-1", threadId: "thread-a" });
    expect(result.thread).toBe("Rover");
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]?.text).toContain("draw call batching");
  });

  it("says a thread is empty rather than guessing what it is doing", async () => {
    const context = makeContext({
      readThread: vi.fn(async () => ({ messages: [], activities: [] })),
    });
    const result = (await executeOrchestratorTool(context, {
      name: "read_thread",
      args: { thread: "Rover" },
    })) as { say: string };
    expect(result.say).toContain("nothing said in it yet");
  });

  it("finds a recorded error even though no message mentions it", async () => {
    const context = makeContext({
      readThread: vi.fn(async () => ({
        messages: conversation,
        activities: [
          {
            kind: "provider-error",
            summary: "ECONNREFUSED talking to the provider bridge",
            tone: "error",
            turnId: "turn-1",
            createdAt: "2026-08-17T09:00:30.000Z",
          },
        ],
      })),
    });

    const result = (await executeOrchestratorTool(context, {
      name: "search_threads",
      args: { query: "ECONNREFUSED", reason: "user asked what failed" },
    })) as {
      matches: ReadonlyArray<{ isError: boolean; source: string; at: string }>;
      say: string;
    };

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.isError).toBe(true);
    expect(result.matches[0]?.source).toBe("activity");
    expect(result.matches[0]?.at).toBe("2026-08-17T09:00:30.000Z");
    expect(result.say).toContain("recorded failure");
  });

  it("keeps searching when one environment is unreachable", async () => {
    const context = makeContext({
      world: new Map([
        ["env-1:thread-a", snapshot()],
        [
          "env-2:thread-b",
          snapshot({
            threadKey: "env-2:thread-b",
            threadId: "thread-b",
            environmentId: "env-2",
            title: "Vera Medical intake",
          }),
        ],
      ]),
      readThread: vi.fn(async (input: { environmentId: string }) => {
        if (input.environmentId === "env-1") throw new Error("not connected");
        return { messages: conversation, activities: [] };
      }),
    });

    const result = (await executeOrchestratorTool(context, {
      name: "search_threads",
      args: { query: "batching" },
    })) as {
      matches: ReadonlyArray<{ thread: string }>;
      threadsUnreadable?: ReadonlyArray<string>;
    };

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.thread).toBe("Vera Medical intake");
    // Silently dropping the unreachable one would read as "it is not in there".
    expect(result.threadsUnreadable).toEqual(["Rover"]);
  });

  it("refuses an empty query rather than matching everything", async () => {
    const context = makeContext();
    await expect(
      executeOrchestratorTool(context, { name: "search_threads", args: { query: "   " } }),
    ).rejects.toBeInstanceOf(OrchestratorToolError);
  });

  it("is available at read-only authority", () => {
    expect(isToolAllowed("read_thread", "read-only")).toBe(true);
    expect(isToolAllowed("search_threads", "read-only")).toBe(true);
  });
});

describe("thread status fields", () => {
  it("reports the thinking effort a thread is configured with", async () => {
    // update_thread_settings could set effort from the start, but nothing
    // reported it — so the orchestrator could change it and then be unable to
    // say what it was, including for a change it had just made itself.
    const context = makeContext({
      world: new Map([["env-1:thread-a", snapshot({ effort: "high" })]]),
    });
    const result = (await executeOrchestratorTool(context, {
      name: "describe_thread",
      args: { thread: "Rover" },
    })) as { thread: { effort: string } };

    expect(result.thread.effort).toBe("high");
  });

  it("says effort is default when the provider was left alone", async () => {
    const context = makeContext({
      world: new Map([["env-1:thread-a", snapshot({ effort: "default" })]]),
    });
    const result = (await executeOrchestratorTool(context, {
      name: "list_threads",
      args: {},
    })) as { threads: ReadonlyArray<{ effort: string }> };

    expect(result.threads[0]?.effort).toBe("default");
  });

  it("reports how old a failure is, in words rather than a timestamp", async () => {
    const errorAt = new Date(Date.now() - 3 * 60 * 60 * 1_000).toISOString();
    const context = makeContext({
      world: new Map([
        [
          "env-1:thread-a",
          snapshot({
            hasError: true,
            lastError: "429 usage limit reached",
            failureKind: "usage-limit",
            errorAt,
          }),
        ],
      ]),
    });
    const result = (await executeOrchestratorTool(context, {
      name: "describe_thread",
      args: { thread: "Rover" },
    })) as { thread: { error: string; failureKind: string; errorAt: string; errorAge: string } };

    expect(result.thread.error).toBe("429 usage limit reached");
    expect(result.thread.failureKind).toBe("usage-limit");
    expect(result.thread.errorAt).toBe(errorAt);
    expect(result.thread.errorAge).toBe("about 3 hours ago");
  });

  it("omits the failure fields entirely on a healthy thread", async () => {
    const context = makeContext();
    const result = (await executeOrchestratorTool(context, {
      name: "describe_thread",
      args: { thread: "Rover" },
    })) as { thread: Record<string, unknown> };

    // Absent reads as "no failure"; an explicit null invites narration of one.
    expect("error" in result.thread).toBe(false);
    expect("errorAt" in result.thread).toBe(false);
    expect("errorAge" in result.thread).toBe(false);
  });

  it("omits the age rather than voicing a malformed timestamp", async () => {
    const context = makeContext({
      world: new Map([["env-1:thread-a", snapshot({ lastError: "boom", errorAt: "not-a-date" })]]),
    });
    const result = (await executeOrchestratorTool(context, {
      name: "describe_thread",
      args: { thread: "Rover" },
    })) as { thread: Record<string, unknown> };

    expect(result.thread.error).toBe("boom");
    expect("errorAge" in result.thread).toBe(false);
    expect("errorAt" in result.thread).toBe(false);
  });
});

describe("describeAge", () => {
  const now = Date.parse("2026-08-17T12:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("rounds to units a voice can actually say", () => {
    expect(describeAge(ago(20_000), now)).toBe("just now");
    expect(describeAge(ago(90_000), now)).toBe("2 minutes ago");
    expect(describeAge(ago(60_000), now)).toBe("1 minute ago");
    expect(describeAge(ago(3 * 60 * 60 * 1_000), now)).toBe("about 3 hours ago");
    expect(describeAge(ago(50 * 60 * 60 * 1_000), now)).toBe("about 2 days ago");
  });

  it("reads clock skew as just now rather than a negative age", () => {
    expect(describeAge(new Date(now + 5_000).toISOString(), now)).toBe("just now");
  });

  it("returns nothing for an unparseable timestamp", () => {
    expect(describeAge("whenever", now)).toBeUndefined();
  });
});

describe("ending the session by voice", () => {
  it("closes the session when the user says they are done", async () => {
    const endVoiceSession = vi.fn();
    const context = makeContext({ endVoiceSession });

    const result = (await executeOrchestratorTool(context, {
      name: "end_voice_session",
      args: { reason: "user said that's all" },
    })) as { ended: boolean; say: string };

    expect(endVoiceSession).toHaveBeenCalledWith("stop");
    expect(result.ended).toBe(true);
    // The goodbye is spoken before the microphone closes, so it must be short
    // and must not invite a reply nobody will be listening for.
    expect(result.say).toContain("short goodbye");
    expect(result.say).toContain("do not ask a follow-up question");
  });

  it("only stops talking when the user asks for quiet", async () => {
    const endVoiceSession = vi.fn();
    const context = makeContext({ endVoiceSession });

    const result = (await executeOrchestratorTool(context, {
      name: "end_voice_session",
      args: { mode: "hush", reason: "user said be quiet" },
    })) as { ended: boolean; say: string };

    expect(endVoiceSession).toHaveBeenCalledWith("hush");
    expect(result.ended).toBe(false);
    expect(result.say).toContain("Stop talking now");
  });

  it("treats an unrecognized mode as a full stop rather than guessing", async () => {
    const endVoiceSession = vi.fn();
    const context = makeContext({ endVoiceSession });
    await executeOrchestratorTool(context, {
      name: "end_voice_session",
      args: { mode: "pause" },
    });
    expect(endVoiceSession).toHaveBeenCalledWith("stop");
  });

  it("is reachable at every authority, since it only ever does less", () => {
    expect(isToolAllowed("end_voice_session", "read-only")).toBe(true);
    expect(isToolAllowed("end_voice_session", "send")).toBe(true);
    expect(isToolAllowed("end_voice_session", "full")).toBe(true);
  });
});

describe("settled state", () => {
  it("reports a settled thread as settled, not as its stale error", async () => {
    // The reported mismatch: the sidebar showed these threads settled while the
    // spoken status still read "error" from a provider failure the user had
    // already dealt with and marked finished.
    const context = makeContext({
      world: new Map([
        [
          "env-1:thread-a",
          snapshot({
            title: "Investigate Robot Obstacle Avoidance Failure",
            isWorking: false,
            hasError: true,
            lastError: "provider exited unexpectedly",
            settled: true,
          }),
        ],
      ]),
    });

    const result = (await executeOrchestratorTool(context, {
      name: "describe_thread",
      args: { thread: "Investigate Robot Obstacle Avoidance Failure" },
    })) as { thread: { status: string; settled: boolean; error: string } };

    expect(result.thread.status).toBe("settled");
    expect(result.thread.settled).toBe(true);
    // Nothing is hidden by the label: it errored, and that is still reported.
    expect(result.thread.error).toBe("provider exited unexpectedly");
  });

  it("does not let settled mask work that is actually running", async () => {
    // "Settled" is a note the user left; running is a fact about right now.
    const context = makeContext({
      world: new Map([["env-1:thread-a", snapshot({ isWorking: true, settled: true })]]),
    });
    const result = (await executeOrchestratorTool(context, {
      name: "describe_thread",
      args: { thread: "Rover" },
    })) as { thread: { status: string; settled: boolean } };

    expect(result.thread.status).toBe("working");
    expect(result.thread.settled).toBe(true);
  });

  it("does not let settled mask an unreachable host", async () => {
    const context = makeContext({
      world: new Map([
        ["env-1:thread-a", snapshot({ environmentUnreachable: true, settled: true })],
      ]),
    });
    const result = (await executeOrchestratorTool(context, {
      name: "describe_thread",
      args: { thread: "Rover" },
    })) as { thread: { status: string } };

    expect(result.thread.status).toBe("unreachable");
  });

  it("still reports an unsettled failure as an error", async () => {
    const context = makeContext({
      world: new Map([
        ["env-1:thread-a", snapshot({ isWorking: false, hasError: true, settled: false })],
      ]),
    });
    const result = (await executeOrchestratorTool(context, {
      name: "describe_thread",
      args: { thread: "Rover" },
    })) as { thread: { status: string } };

    expect(result.thread.status).toBe("error");
  });
});

describe("changing the voice", () => {
  it("persists a new voice and says it lands next session", async () => {
    const setOrchestratorVoice = vi.fn(async () => {});
    const context = makeContext({ setOrchestratorVoice });

    const result = (await executeOrchestratorTool(context, {
      name: "set_orchestrator_voice",
      args: { voice: "  marin  ", reason: "user asked for a different voice" },
    })) as { changed: boolean; voice: string; activeNow: boolean; say: string };

    expect(setOrchestratorVoice).toHaveBeenCalledWith("marin");
    expect(result.changed).toBe(true);
    // The voice is still minted with the session token and cannot change within
    // a session — a live one is restarted instead, so the user hears the new
    // voice at once rather than "next time", which could be hours away.
    expect(result.activeNow).toBe(true);
    expect(result.say).toContain("reconnecting");
  });

  it("does not claim to have changed a voice that is already set", async () => {
    const setOrchestratorVoice = vi.fn(async () => {});
    const context = makeContext({ setOrchestratorVoice });

    const result = (await executeOrchestratorTool(context, {
      name: "set_orchestrator_voice",
      args: { voice: "cedar" },
    })) as { changed: boolean; say: string };

    expect(setOrchestratorVoice).not.toHaveBeenCalled();
    expect(result.changed).toBe(false);
    expect(result.say).toContain("already");
  });

  it("refuses an empty voice rather than clearing the setting", async () => {
    const context = makeContext();
    await expect(
      executeOrchestratorTool(context, { name: "set_orchestrator_voice", args: { voice: "  " } }),
    ).rejects.toBeInstanceOf(OrchestratorToolError);
  });

  it("is not reachable at read-only authority", () => {
    expect(isToolAllowed("set_orchestrator_voice", "read-only")).toBe(false);
    expect(isToolAllowed("set_orchestrator_voice", "send")).toBe(true);
  });
});
