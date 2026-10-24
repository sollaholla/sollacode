import {
  IsoDateTime,
  OrchestrationSessionStatus,
  ProjectId,
  TerminalSessionStatus,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const BoundedMessage = TrimmedNonEmptyString.check(Schema.isMaxLength(120_000));

// A single flat struct rather than a per-action discriminated union: MCP
// requires a tool's inputSchema to be a top-level `type: "object"` schema, and
// the @modelcontextprotocol/sdk client rejects the entire tools/list response
// when a union (`anyOf`) is advertised instead. Per-action required fields are
// enforced in the handler.
export const WorkspaceOrchestrationInput = Schema.Struct({
  action: Schema.Literals([
    "list_threads",
    "describe_thread",
    "send_to_thread",
    "interrupt_thread",
    "list_terminals",
    "read_terminal",
    "write_to_terminal",
  ]),
  threadId: Schema.optional(ThreadId).annotate({
    description:
      "A thread id returned by list_threads. Required for describe_thread, send_to_thread, interrupt_thread, read_terminal and write_to_terminal. Optional for list_terminals to restrict to one thread.",
  }),
  terminalId: Schema.optional(TrimmedNonEmptyString).annotate({
    description:
      "A terminal id from list_terminals or list_threads, e.g. term-1. Required for read_terminal and write_to_terminal.",
  }),
  message: Schema.optional(BoundedMessage).annotate({
    description:
      "The message to send as the user, delivered exactly like typing into that thread. Required for send_to_thread.",
  }),
  data: Schema.optional(Schema.String.check(Schema.isMaxLength(65_536))).annotate({
    description:
      "Text to type into the terminal. Required for write_to_terminal. A trailing newline is added unless submit is false or the text already ends with one.",
  }),
  submit: Schema.optional(Schema.Boolean).annotate({
    description:
      "write_to_terminal only: type Enter after the text. Defaults to true. Set false to type without submitting.",
  }),
  includeSettled: Schema.optional(Schema.Boolean).annotate({
    description:
      "list_threads only: include threads the user has already settled. Defaults to false.",
  }),
  includeSideChats: Schema.optional(Schema.Boolean).annotate({
    description:
      "list_threads only: include side chats spawned by other threads. Defaults to false.",
  }),
});
export type WorkspaceOrchestrationInput = typeof WorkspaceOrchestrationInput.Type;

export const WorkspaceTerminalSummary = Schema.Struct({
  terminalId: Schema.String,
  label: Schema.String,
  status: TerminalSessionStatus,
  hasRunningSubprocess: Schema.Boolean,
});
export type WorkspaceTerminalSummary = typeof WorkspaceTerminalSummary.Type;

export const WorkspaceTerminalDetail = Schema.Struct({
  threadId: ThreadId,
  threadTitle: Schema.String,
  terminalId: Schema.String,
  label: Schema.String,
  status: TerminalSessionStatus,
  hasRunningSubprocess: Schema.Boolean,
  cwd: Schema.String,
});
export type WorkspaceTerminalDetail = typeof WorkspaceTerminalDetail.Type;

export const WorkspaceThreadSummary = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  /**
   * The project's name as the sidebar shows it. Thread titles say what a chat
   * is about, not where it runs, so a person asking about "Undead Open World"
   * means this, not a title.
   */
  projectTitle: Schema.optional(Schema.String),
  title: Schema.String,
  status: OrchestrationSessionStatus,
  /**
   * What the thread is blocked on, if anything — the orchestrator's main signal.
   * `proposed-plan` means the thread has settled with its newest plan still
   * open — not implemented (by Implement, or by the person answering in Build
   * or Agent) and not closed. Older plans in history are `nothing`.
   */
  waitingOn: Schema.optional(
    Schema.Literals(["approval", "user-input", "proposed-plan", "nothing"]),
  ),
  /**
   * Doing work now, by the sidebar's Working rule: a session or turn in
   * flight, scheduled work for it (`pendingWork`), or background tasks its
   * finished turn left running (`backgroundTaskCount`). A terminal with a
   * running subprocess is listed under `terminals` and does not count.
   */
  isWorking: Schema.Boolean,
  /** Sub-agents, workflows, and backgrounded commands still reporting after the turn ended. */
  backgroundTaskCount: Schema.optional(Schema.Number),
  /**
   * Work the server holds for the thread: `kind` such as agent-continuation,
   * startup-resume, or provider-retry, and `state` such as pending, sleeping,
   * executing, or blocked-authentication.
   */
  pendingWork: Schema.optional(Schema.Struct({ kind: Schema.String, state: Schema.String })),
  isSideChat: Schema.Boolean,
  /**
   * The conversation a side chat was forked from. Present only for a side
   * chat, and only when that parent is still known — "this is a side chat"
   * without saying of what leaves the user hunting for a thread that is not in
   * the sidebar at all.
   */
  sideChatOf: Schema.optional(Schema.String),
  settled: Schema.Boolean,
  lastActivityAt: Schema.optional(IsoDateTime),
  latestTurnState: Schema.optional(Schema.String),
  terminals: Schema.Array(WorkspaceTerminalSummary),
});
export type WorkspaceThreadSummary = typeof WorkspaceThreadSummary.Type;

export const WorkspaceOrchestrationResult = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("list_threads"),
    threads: Schema.Array(WorkspaceThreadSummary),
    totalCount: Schema.Number,
  }),
  Schema.Struct({
    action: Schema.Literal("describe_thread"),
    thread: WorkspaceThreadSummary,
  }),
  Schema.Struct({
    action: Schema.Literal("send_to_thread"),
    threadId: ThreadId,
    delivered: Schema.Boolean,
  }),
  Schema.Struct({
    action: Schema.Literal("interrupt_thread"),
    threadId: ThreadId,
    interrupted: Schema.Boolean,
  }),
  Schema.Struct({
    action: Schema.Literal("list_terminals"),
    terminals: Schema.Array(WorkspaceTerminalDetail),
    totalCount: Schema.Number,
  }),
  Schema.Struct({
    action: Schema.Literal("read_terminal"),
    terminal: WorkspaceTerminalDetail,
    output: Schema.String,
    truncated: Schema.Boolean,
  }),
  Schema.Struct({
    action: Schema.Literal("write_to_terminal"),
    threadId: ThreadId,
    terminalId: Schema.String,
    written: Schema.Boolean,
    submitted: Schema.Boolean,
  }),
]);
export type WorkspaceOrchestrationResult = typeof WorkspaceOrchestrationResult.Type;

export class WorkspaceOrchestrationScopeError extends Schema.TaggedErrorClass<WorkspaceOrchestrationScopeError>()(
  "WorkspaceOrchestrationScopeError",
  {
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "Workspace orchestration is only available to the orchestrator thread.";
  }
}

export class WorkspaceOrchestrationThreadNotFoundError extends Schema.TaggedErrorClass<WorkspaceOrchestrationThreadNotFoundError>()(
  "WorkspaceOrchestrationThreadNotFoundError",
  {
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `No thread ${this.threadId} is available in this workspace.`;
  }
}

export class WorkspaceOrchestrationOperationFailedError extends Schema.TaggedErrorClass<WorkspaceOrchestrationOperationFailedError>()(
  "WorkspaceOrchestrationOperationFailedError",
  {
    operation: Schema.String,
    threadId: Schema.optional(ThreadId),
  },
) {
  override get message(): string {
    return `Workspace orchestration failed while ${this.operation}.`;
  }
}

export class WorkspaceOrchestrationInvalidInputError extends Schema.TaggedErrorClass<WorkspaceOrchestrationInvalidInputError>()(
  "WorkspaceOrchestrationInvalidInputError",
  {
    action: Schema.String,
    missing: Schema.String,
  },
) {
  override get message(): string {
    return `workspace_orchestration action "${this.action}" requires "${this.missing}".`;
  }
}

export class WorkspaceOrchestrationTerminalNotFoundError extends Schema.TaggedErrorClass<WorkspaceOrchestrationTerminalNotFoundError>()(
  "WorkspaceOrchestrationTerminalNotFoundError",
  {
    threadId: ThreadId,
    terminalId: Schema.String,
  },
) {
  override get message(): string {
    return `No terminal ${this.terminalId} is open on thread ${this.threadId}.`;
  }
}

export const WorkspaceOrchestrationError = Schema.Union([
  WorkspaceOrchestrationScopeError,
  WorkspaceOrchestrationThreadNotFoundError,
  WorkspaceOrchestrationOperationFailedError,
  WorkspaceOrchestrationInvalidInputError,
  WorkspaceOrchestrationTerminalNotFoundError,
]);
export type WorkspaceOrchestrationError = typeof WorkspaceOrchestrationError.Type;
