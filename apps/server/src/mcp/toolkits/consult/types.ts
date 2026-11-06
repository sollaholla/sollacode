import { EnvironmentId, IsoDateTime, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * A number that also accepts its decimal string form.
 *
 * Models do not always emit JSON numbers for numeric tool arguments: on
 * 2026-09-17 OpenCode's union-alpha passed `waitMs: "5000.0"`, and the strict
 * `Schema.Number` rejected the whole call ("Expected number | undefined, got
 * \"5000.0\""). The string branch decodes through `Number()`, so "5000.0"
 * becomes 5000; non-numeric strings still fail (`FiniteFromString`, so "soon"
 * does not slip through as NaN).
 */
const LenientNumber = Schema.Union([Schema.Number, Schema.FiniteFromString]);

/**
 * One flat multi-action input for the `workspace_consult` tool. Flat rather than
 * a discriminated union at the schema root because a raw `Schema.Union` root
 * breaks the whole MCP `tools/list`; the handler validates per-action fields.
 */
export const WorkspaceConsultInput = Schema.Struct({
  action: Schema.Literals([
    "list_projects",
    "list_threads",
    "ask",
    "read_thread",
    "search_threads",
  ]).annotate({
    description:
      "What to do. `list_projects` and `list_threads` discover what exists; `ask` puts a question to a project or an existing thread and waits for the reply; `read_thread` reads a conversation's messages (use it to collect an answer that was still being written); `search_threads` finds text across every conversation.",
  }),
  projectId: Schema.optional(ProjectId).annotate({
    description:
      "Project to scope to. For `ask`, the question opens a NEW thread in this project so the conversation is self-contained. Required for `ask` unless `threadId` is given.",
  }),
  threadId: Schema.optional(ThreadId).annotate({
    description:
      "An existing conversation. For `ask`, the question continues this thread instead of opening a new one. Required for `read_thread`.",
  }),
  environmentId: Schema.optional(EnvironmentId).annotate({
    description:
      "The connected computer a thread or project is on, from the `environmentId` on its `list_threads` or `list_projects` row. Omit for this computer. On `list_threads` and `list_projects` it limits the list to that computer; without it they cover this computer and every connected one.",
  }),
  question: Schema.optional(Schema.String.check(Schema.isMaxLength(10_000))).annotate({
    description:
      "What to ask. Include the context the other conversation needs — it cannot see your screen or your chat. Required for `ask`.",
  }),
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(120))).annotate({
    description: "Title for the thread `ask` creates. Defaults to a summary of the question.",
  }),
  waitMs: Schema.optional(LenientNumber).annotate({
    description:
      "How long `ask` waits for an answer before returning early, in milliseconds (at most 120000; 0 sends without waiting). If it returns still working, poll `read_thread` for the reply.",
  }),
  limit: Schema.optional(LenientNumber).annotate({
    description: "How many recent messages `read_thread` returns. Defaults to 10.",
  }),
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(500))).annotate({
    description:
      "Text to find. Required for `search_threads`; with `read_thread`, returns only that conversation's matching messages.",
  }),
  paged: Schema.optional(Schema.Boolean).annotate({
    description:
      "With `read_thread`: return messages newest first with a `nextCursor` for older ones. Implied by `query` and `cursor`.",
  }),
  cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))).annotate({
    description: "`nextCursor` from the previous page of `read_thread` or `search_threads`.",
  }),
});
export type WorkspaceConsultInput = typeof WorkspaceConsultInput.Type;

/** Where a row lives when it is not on this computer; pass `environmentId` back to reach it. */
const ConsultRemoteLocation = {
  environmentId: Schema.optional(EnvironmentId),
  /** The connected computer's name. */
  computer: Schema.optional(Schema.String),
};

export const ConsultProjectSummary = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  workspaceRoot: Schema.String,
  threadCount: Schema.Int,
  ...ConsultRemoteLocation,
});

export const ConsultThreadSummary = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  projectId: ProjectId,
  projectTitle: Schema.optional(Schema.String),
  /** Latest turn state: running, completed, error, … */
  state: Schema.optional(Schema.String),
  isWorking: Schema.Boolean,
  /** True for a custom agent's own chat: ask it to reach that agent. */
  isAgent: Schema.Boolean,
  lastActivityAt: Schema.optional(IsoDateTime),
  ...ConsultRemoteLocation,
});

/** One connected computer a list looked at, so an empty row set is not mistaken for no chats. */
export const ConsultComputer = Schema.Struct({
  environmentId: EnvironmentId,
  computer: Schema.String,
  reachable: Schema.Boolean,
  detail: Schema.optional(Schema.String),
});

export const ConsultMessage = Schema.Struct({
  role: Schema.String,
  text: Schema.String,
  createdAt: IsoDateTime,
});

/** One message `search_threads` found, and where. */
export const ConsultSearchMatch = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  role: Schema.String,
  text: Schema.String,
  createdAt: IsoDateTime,
  ...ConsultRemoteLocation,
});

export const WorkspaceConsultResult = Schema.Struct({
  action: Schema.String,
  /** Short human-readable summary of what happened. */
  status: Schema.String,
  projects: Schema.optional(Schema.Array(ConsultProjectSummary)),
  threads: Schema.optional(Schema.Array(ConsultThreadSummary)),
  /** The connected computers a list covered. Absent when there are none. */
  computers: Schema.optional(Schema.Array(ConsultComputer)),
  messages: Schema.optional(Schema.Array(ConsultMessage)),
  matches: Schema.optional(Schema.Array(ConsultSearchMatch)),
  /** Pass back as `cursor` for the next page. Absent on the last one. */
  nextCursor: Schema.optional(Schema.String),
  /** The conversation `ask` used, so a follow-up can continue or poll it. */
  threadId: Schema.optional(ThreadId),
  /** The reply, when one arrived before the wait elapsed. */
  answer: Schema.optional(Schema.String),
  answered: Schema.optional(Schema.Boolean),
  /** Set when `threadId` is on a connected computer: pass it back to continue or poll. */
  environmentId: Schema.optional(EnvironmentId),
  computer: Schema.optional(Schema.String),
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

/** A guard declined the request; `reason` tells the calling chat what to do instead. */
export class WorkspaceConsultRefusedError extends Schema.TaggedErrorClass<WorkspaceConsultRefusedError>()(
  "WorkspaceConsultRefusedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
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
  WorkspaceConsultRefusedError,
  WorkspaceConsultInvalidInputError,
  WorkspaceConsultNotFoundError,
  WorkspaceConsultFailedError,
]);
export type WorkspaceConsultError = typeof WorkspaceConsultError.Type;

// ── Between computers ───────────────────────────────────────────────

/** Where one server sends another a `workspace_consult` call. */
export const REMOTE_CONSULT_PATH = "/api/consult";

/** A chat on another computer calling this one. Its server vouches for these. */
export const RemoteConsultCaller = Schema.Struct({
  environmentId: EnvironmentId,
  /** That computer's name, shown beside the sender on this one. */
  computer: Schema.String,
  threadId: ThreadId,
  /** The name the asked chat shows: the calling chat's title or its agent's name. */
  label: Schema.String,
  /** How many chats were still blocked waiting on this request when it left. */
  upstreamDepth: Schema.Int,
  /** Chats on this computer still waiting on the caller, so asking one back would loop. */
  waitingThreadIds: Schema.Array(ThreadId),
  /** Whether delegated work reached the caller, which may not open new conversations. */
  delegated: Schema.Boolean,
  /**
   * Whether the caller manages agents on its computer: the orchestrator, or a
   * chat holding agent_builder. Only these may reach this computer's
   * orchestrator. Older computers leave it out, which reads as no.
   */
  managesAgents: Schema.optional(Schema.Boolean),
});
export type RemoteConsultCaller = typeof RemoteConsultCaller.Type;

export const RemoteConsultRequest = Schema.Struct({
  input: WorkspaceConsultInput,
  caller: RemoteConsultCaller,
});
export type RemoteConsultRequest = typeof RemoteConsultRequest.Type;

export const RemoteConsultResponse = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), result: WorkspaceConsultResult }),
  Schema.Struct({ ok: Schema.Literal(false), error: WorkspaceConsultError }),
]);
export type RemoteConsultResponse = typeof RemoteConsultResponse.Type;
