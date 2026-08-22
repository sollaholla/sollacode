import { TerminalSessionStatus, ThreadId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const BoundedTerminalData = Schema.String.check(Schema.isMaxLength(65_536));

export const ThreadTerminalsInput = Schema.Struct({
  action: Schema.Literals(["list_terminals", "read_terminal", "write_to_terminal"]),
  threadId: Schema.optional(ThreadId).annotate({
    description:
      "Thread that owns the terminal. Omit on list_terminals to see every live pane, already titled. Omit on read/write to use this chat's thread.",
  }),
  terminalId: Schema.optional(TrimmedNonEmptyString).annotate({
    description:
      "A terminal id from list_terminals, e.g. term-1. Required for read_terminal and write_to_terminal unless the thread has exactly one terminal.",
  }),
  data: Schema.optional(BoundedTerminalData).annotate({
    description:
      "Text to type into the terminal. Required for write_to_terminal. A trailing Enter is added unless submit is false or the text already ends with a newline.",
  }),
  submit: Schema.optional(Schema.Boolean).annotate({
    description:
      "write_to_terminal only: type Enter after the text. Defaults to true. Set false to type without submitting.",
  }),
});
export type ThreadTerminalsInput = typeof ThreadTerminalsInput.Type;

export const ThreadTerminalDetail = Schema.Struct({
  threadId: ThreadId,
  threadTitle: Schema.String,
  /**
   * True when this pane is attached to the calling chat's thread. A Grok or
   * Claude CLI running in that pane is still a separate process — not this
   * chat agent.
   */
  belongsToThisChat: Schema.Boolean,
  terminalId: Schema.String,
  label: Schema.String,
  status: TerminalSessionStatus,
  hasRunningSubprocess: Schema.Boolean,
  cwd: Schema.String,
  /** Tail of visible output so list_terminals is enough to recognize the pane. */
  preview: Schema.String,
  previewTruncated: Schema.Boolean,
});
export type ThreadTerminalDetail = typeof ThreadTerminalDetail.Type;

export const ThreadTerminalsResult = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("list_terminals"),
    callerThreadId: ThreadId,
    terminals: Schema.Array(ThreadTerminalDetail),
    totalCount: Schema.Number,
  }),
  Schema.Struct({
    action: Schema.Literal("read_terminal"),
    callerThreadId: ThreadId,
    terminal: ThreadTerminalDetail,
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
export type ThreadTerminalsResult = typeof ThreadTerminalsResult.Type;

export class ThreadTerminalsCapabilityUnavailableError extends Schema.TaggedErrorClass<ThreadTerminalsCapabilityUnavailableError>()(
  "ThreadTerminalsCapabilityUnavailableError",
  {
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "Terminal tools are not available to this chat.";
  }
}

export class ThreadTerminalsInvalidInputError extends Schema.TaggedErrorClass<ThreadTerminalsInvalidInputError>()(
  "ThreadTerminalsInvalidInputError",
  {
    action: Schema.String,
    missing: Schema.String,
  },
) {
  override get message(): string {
    return `thread_terminals action "${this.action}" requires "${this.missing}".`;
  }
}

export class ThreadTerminalsNotFoundError extends Schema.TaggedErrorClass<ThreadTerminalsNotFoundError>()(
  "ThreadTerminalsNotFoundError",
  {
    threadId: ThreadId,
    terminalId: Schema.String,
  },
) {
  override get message(): string {
    return `No terminal ${this.terminalId} is open on thread ${this.threadId}.`;
  }
}

export class ThreadTerminalsOperationFailedError extends Schema.TaggedErrorClass<ThreadTerminalsOperationFailedError>()(
  "ThreadTerminalsOperationFailedError",
  {
    operation: Schema.String,
    threadId: Schema.optional(ThreadId),
  },
) {
  override get message(): string {
    return `thread_terminals failed while ${this.operation}.`;
  }
}

export const ThreadTerminalsError = Schema.Union([
  ThreadTerminalsCapabilityUnavailableError,
  ThreadTerminalsInvalidInputError,
  ThreadTerminalsNotFoundError,
  ThreadTerminalsOperationFailedError,
]);
export type ThreadTerminalsError = typeof ThreadTerminalsError.Type;
