import { IsoDateTime, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * One flat multi-action input for the `workspace_consult` tool. Flat rather than
 * a discriminated union at the schema root because a raw `Schema.Union` root
 * breaks the whole MCP `tools/list`; the handler validates per-action fields.
 */
export const WorkspaceConsultInput = Schema.Struct({
  action: Schema.Literals(["list_projects", "list_threads", "ask", "read_thread"]).annotate({
    description:
      "What to do. `list_projects` and `list_threads` discover what exists; `ask` puts a question to a project or an existing thread and waits for the reply; `read_thread` reads a conversation's recent messages (use it to collect an answer that was still being written).",
  }),
  projectId: Schema.optional(ProjectId).annotate({
    description:
      "Project to scope to. For `ask`, the question opens a NEW thread in this project so the conversation is self-contained. Required for `ask` unless `threadId` is given.",
  }),
  threadId: Schema.optional(ThreadId).annotate({
    description:
      "An existing conversation. For `ask`, the question continues this thread instead of opening a new one. Required for `read_thread`.",
  }),
  question: Schema.optional(Schema.String.check(Schema.isMaxLength(10_000))).annotate({
    description:
      "What to ask. Include the context the other conversation needs — it cannot see your screen or your chat. Required for `ask`.",
  }),
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(120))).annotate({
    description: "Title for the thread `ask` creates. Defaults to a summary of the question.",
  }),
  waitMs: Schema.optional(Schema.Number).annotate({
    description:
      "How long `ask` waits for an answer before returning early, in milliseconds. Clamped server-side. If it returns still working, poll `read_thread` for the reply.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "How many recent messages `read_thread` returns. Defaults to 10.",
  }),
});
export type WorkspaceConsultInput = typeof WorkspaceConsultInput.Type;

export const ConsultProjectSummary = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  workspaceRoot: Schema.String,
  threadCount: Schema.Int,
});

export const ConsultThreadSummary = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  projectId: ProjectId,
  projectTitle: Schema.optional(Schema.String),
  /** Latest turn state: running, completed, error, … */
  state: Schema.optional(Schema.String),
  isWorking: Schema.Boolean,
  /** True when this thread belongs to another VM agent rather than a person. */
  isAgent: Schema.Boolean,
  lastActivityAt: Schema.optional(IsoDateTime),
});

export const ConsultMessage = Schema.Struct({
  role: Schema.String,
  text: Schema.String,
  createdAt: IsoDateTime,
});

export const WorkspaceConsultResult = Schema.Struct({
  action: Schema.String,
  /** Short human-readable summary of what happened. */
  status: Schema.String,
  projects: Schema.optional(Schema.Array(ConsultProjectSummary)),
  threads: Schema.optional(Schema.Array(ConsultThreadSummary)),
  messages: Schema.optional(Schema.Array(ConsultMessage)),
  /** The conversation `ask` used, so a follow-up can continue or poll it. */
  threadId: Schema.optional(ThreadId),
  /** The reply, when one arrived before the wait elapsed. */
  answer: Schema.optional(Schema.String),
  answered: Schema.optional(Schema.Boolean),
});
export type WorkspaceConsultResult = typeof WorkspaceConsultResult.Type;

// ── Errors ──────────────────────────────────────────────────────────

export class WorkspaceConsultUnavailableError extends Schema.TaggedErrorClass<WorkspaceConsultUnavailableError>()(
  "WorkspaceConsultUnavailableError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "The workspace_consult tool is not available to this chat.";
  }
}

export class WorkspaceConsultNotAnAgentError extends Schema.TaggedErrorClass<WorkspaceConsultNotAnAgentError>()(
  "WorkspaceConsultNotAnAgentError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "This chat is not a VM agent, so it cannot consult the workspace.";
  }
}

export class WorkspaceConsultInvalidInputError extends Schema.TaggedErrorClass<WorkspaceConsultInvalidInputError>()(
  "WorkspaceConsultInvalidInputError",
  { action: Schema.String, missing: Schema.String },
) {
  override get message(): string {
    return `workspace_consult action "${this.action}" requires "${this.missing}".`;
  }
}

export class WorkspaceConsultNotFoundError extends Schema.TaggedErrorClass<WorkspaceConsultNotFoundError>()(
  "WorkspaceConsultNotFoundError",
  { kind: Schema.String, id: Schema.String },
) {
  override get message(): string {
    return `No such ${this.kind}: ${this.id}.`;
  }
}

export class WorkspaceConsultFailedError extends Schema.TaggedErrorClass<WorkspaceConsultFailedError>()(
  "WorkspaceConsultFailedError",
  { operation: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `workspace_consult failed while ${this.operation}: ${this.detail}`;
  }
}

export const WorkspaceConsultError = Schema.Union([
  WorkspaceConsultUnavailableError,
  WorkspaceConsultNotAnAgentError,
  WorkspaceConsultInvalidInputError,
  WorkspaceConsultNotFoundError,
  WorkspaceConsultFailedError,
]);
export type WorkspaceConsultError = typeof WorkspaceConsultError.Type;
