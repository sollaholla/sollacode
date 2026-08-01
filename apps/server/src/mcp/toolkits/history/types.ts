import {
  ChatAttachment,
  IsoDateTime,
  NonNegativeInt,
  OrchestrationMessageRole,
  OrchestrationSessionStatus,
  OrchestrationThreadActivityTone,
  ProviderInstanceId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const BoundedString = (maxLength: number) => Schema.String.check(Schema.isMaxLength(maxLength));
const BoundedStringArray = (maxItems: number, maxItemLength: number) =>
  Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(maxItemLength))).check(
    Schema.isMaxLength(maxItems),
  );

export const ThreadHistorySource = Schema.Literals(["messages", "activities"]);
export type ThreadHistorySource = typeof ThreadHistorySource.Type;

export const ThreadHistoryQueryInput = Schema.Struct({
  threadId: Schema.optional(
    ThreadId.annotate({
      description:
        "Thread to query. Omit to use the thread bound to this agent's MCP credential. An explicit value must match that bound thread.",
    }),
  ),
  query: Schema.optional(
    BoundedString(2_000).annotate({
      description:
        "Optional literal text or JavaScript-compatible regular expression to match against message text and activity summaries.",
    }),
  ),
  matchMode: Schema.optional(Schema.Literals(["literal", "regex"])).annotate({
    description: "Match query literally (default) or as a bounded regular expression.",
  }),
  regexFlags: Schema.optional(BoundedString(4).check(Schema.isPattern(/^[imsu]*$/))).annotate({
    description:
      "Optional regex flags from i, m, s, and u. Defaults to i. Stateful g, y, and d flags are intentionally unsupported.",
  }),
  caseSensitive: Schema.optional(Schema.Boolean).annotate({
    description: "Use case-sensitive literal matching. Defaults to false; ignored for regex mode.",
  }),
  sources: Schema.optional(Schema.Array(ThreadHistorySource).check(Schema.isMaxLength(2))).annotate(
    {
      description: "History sources to include. Defaults to both messages and activities.",
    },
  ),
  roles: Schema.optional(
    Schema.Array(OrchestrationMessageRole).check(Schema.isMaxLength(8)),
  ).annotate({
    description: "Optional message-role filter such as user or assistant.",
  }),
  activityKinds: Schema.optional(BoundedStringArray(64, 128)).annotate({
    description: "Optional exact activity-kind filter.",
  }),
  turnIds: Schema.optional(Schema.Array(TurnId).check(Schema.isMaxLength(64))).annotate({
    description: "Optional exact turn-id filter shared by messages and activities.",
  }),
  since: Schema.optional(IsoDateTime).annotate({
    description: "Include records created at or after this ISO timestamp.",
  }),
  until: Schema.optional(IsoDateTime).annotate({
    description: "Include records created at or before this ISO timestamp.",
  }),
  order: Schema.optional(Schema.Literals(["asc", "desc"])).annotate({
    description: "Chronological order. Defaults to desc so the newest history is returned first.",
  }),
  pageSize: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(100)),
  ).annotate({ description: "Maximum results per page. Defaults to 40; maximum 100." }),
  cursor: Schema.optional(BoundedString(4_096)).annotate({
    description: "Opaque nextCursor returned by a previous call with identical filters.",
  }),
  includeAttachments: Schema.optional(Schema.Boolean).annotate({
    description: "Include attachment metadata for message entries. Defaults to true.",
  }),
  includePayload: Schema.optional(Schema.Boolean).annotate({
    description: "Include bounded activity payloads. Defaults to false.",
  }),
  includeStreaming: Schema.optional(Schema.Boolean).annotate({
    description: "Include currently streaming assistant messages. Defaults to false.",
  }),
  maxTextChars: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(200)).check(Schema.isLessThanOrEqualTo(120_000)),
  ).annotate({
    description: "Maximum text characters returned per entry. Defaults to 12000.",
  }),
  maxPayloadChars: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(200)).check(Schema.isLessThanOrEqualTo(64_000)),
  ).annotate({
    description: "Maximum serialized activity-payload characters returned. Defaults to 8000.",
  }),
  maxScanRecords: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(100)).check(Schema.isLessThanOrEqualTo(10_000)),
  ).annotate({
    description:
      "Maximum candidate records scanned by regex lookup. Defaults to 2500; maximum 10000.",
  }),
});
export type ThreadHistoryQueryInput = typeof ThreadHistoryQueryInput.Type;

const ThreadHistoryEntryBase = {
  id: TrimmedNonEmptyString,
  turnId: Schema.NullOr(TurnId),
  text: Schema.String,
  textChars: NonNegativeInt,
  textTruncated: Schema.Boolean,
  createdAt: IsoDateTime,
};

export const ThreadHistoryMessageEntry = Schema.Struct({
  entryType: Schema.Literal("message"),
  ...ThreadHistoryEntryBase,
  role: OrchestrationMessageRole,
  isStreaming: Schema.Boolean,
  updatedAt: IsoDateTime,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
});
export type ThreadHistoryMessageEntry = typeof ThreadHistoryMessageEntry.Type;

export const ThreadHistoryActivityEntry = Schema.Struct({
  entryType: Schema.Literal("activity"),
  ...ThreadHistoryEntryBase,
  activityKind: Schema.String,
  tone: OrchestrationThreadActivityTone,
  sequence: Schema.NullOr(NonNegativeInt),
  payload: Schema.optional(Schema.Unknown),
  payloadExcerpt: Schema.optional(Schema.String),
  payloadTruncated: Schema.optional(Schema.Boolean),
});
export type ThreadHistoryActivityEntry = typeof ThreadHistoryActivityEntry.Type;

export const ThreadHistoryEntry = Schema.Union([
  ThreadHistoryMessageEntry,
  ThreadHistoryActivityEntry,
]);
export type ThreadHistoryEntry = typeof ThreadHistoryEntry.Type;

export const ThreadHistoryLatestMessage = Schema.Struct({
  id: TrimmedNonEmptyString,
  turnId: Schema.NullOr(TurnId),
  role: OrchestrationMessageRole,
  text: Schema.String,
  textChars: NonNegativeInt,
  textTruncated: Schema.Boolean,
  createdAt: IsoDateTime,
});
export type ThreadHistoryLatestMessage = typeof ThreadHistoryLatestMessage.Type;

export const ThreadHistoryLatestActivity = Schema.Struct({
  id: TrimmedNonEmptyString,
  turnId: Schema.NullOr(TurnId),
  activityKind: Schema.String,
  text: Schema.String,
  textChars: NonNegativeInt,
  textTruncated: Schema.Boolean,
  createdAt: IsoDateTime,
});
export type ThreadHistoryLatestActivity = typeof ThreadHistoryLatestActivity.Type;

export const ThreadHistoryActiveTurn = Schema.Struct({
  turnId: Schema.NullOr(TurnId),
  state: Schema.Literals(["pending", "running"]),
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
});

export const ThreadHistoryResumeContext = Schema.Struct({
  latestUserMessage: Schema.NullOr(ThreadHistoryLatestMessage),
  latestAssistantMessage: Schema.NullOr(ThreadHistoryLatestMessage),
  latestActivity: Schema.NullOr(ThreadHistoryLatestActivity),
  activeTurn: Schema.NullOr(ThreadHistoryActiveTurn),
});

export const ThreadHistoryThreadState = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  modelSelection: Schema.Unknown,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  updatedAt: IsoDateTime,
  session: Schema.NullOr(
    Schema.Struct({
      status: OrchestrationSessionStatus,
      providerName: Schema.NullOr(Schema.String),
      providerInstanceId: Schema.NullOr(ProviderInstanceId),
      activeTurnId: Schema.NullOr(TurnId),
      lastError: Schema.NullOr(Schema.String),
      updatedAt: IsoDateTime,
    }),
  ),
});

export const ThreadHistoryQueryResult = Schema.Struct({
  thread: ThreadHistoryThreadState,
  resolvedThreadIdFromInvocation: Schema.Boolean,
  entries: Schema.Array(ThreadHistoryEntry),
  resumeContext: ThreadHistoryResumeContext,
  pagination: Schema.Struct({
    pageSize: NonNegativeInt,
    returned: NonNegativeInt,
    scanned: NonNegativeInt,
    hasMore: Schema.Boolean,
    nextCursor: Schema.NullOr(Schema.String),
    scanLimitReached: Schema.Boolean,
  }),
  query: Schema.Struct({
    text: Schema.NullOr(Schema.String),
    matchMode: Schema.Literals(["literal", "regex"]),
    regexFlags: Schema.NullOr(Schema.String),
    sources: Schema.Array(ThreadHistorySource),
    roles: Schema.Array(OrchestrationMessageRole),
    activityKinds: Schema.Array(Schema.String),
    turnIds: Schema.Array(TurnId),
    since: Schema.NullOr(IsoDateTime),
    until: Schema.NullOr(IsoDateTime),
    order: Schema.Literals(["asc", "desc"]),
  }),
});
export type ThreadHistoryQueryResult = typeof ThreadHistoryQueryResult.Type;

export class ThreadHistoryCapabilityUnavailableError extends Schema.TaggedErrorClass<ThreadHistoryCapabilityUnavailableError>()(
  "ThreadHistoryCapabilityUnavailableError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "This MCP credential does not grant thread-history access.";
  }
}

export class ThreadHistoryScopeError extends Schema.TaggedErrorClass<ThreadHistoryScopeError>()(
  "ThreadHistoryScopeError",
  {
    requestedThreadId: ThreadId,
    authorizedThreadId: ThreadId,
  },
) {
  override get message(): string {
    return "The requested thread is outside this agent's MCP credential scope.";
  }
}

export class ThreadHistoryThreadNotFoundError extends Schema.TaggedErrorClass<ThreadHistoryThreadNotFoundError>()(
  "ThreadHistoryThreadNotFoundError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Thread '${this.threadId}' was not found.`;
  }
}

export class ThreadHistoryInvalidRegexError extends Schema.TaggedErrorClass<ThreadHistoryInvalidRegexError>()(
  "ThreadHistoryInvalidRegexError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `Invalid thread-history regular expression: ${this.detail}`;
  }
}

export class ThreadHistoryRegexTimeoutError extends Schema.TaggedErrorClass<ThreadHistoryRegexTimeoutError>()(
  "ThreadHistoryRegexTimeoutError",
  { timeoutMs: NonNegativeInt },
) {
  override get message(): string {
    return `Thread-history regular expression exceeded ${this.timeoutMs}ms.`;
  }
}

export class ThreadHistoryInvalidCursorError extends Schema.TaggedErrorClass<ThreadHistoryInvalidCursorError>()(
  "ThreadHistoryInvalidCursorError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `Invalid thread-history cursor: ${this.detail}`;
  }
}

export class ThreadHistoryQueryFailedError extends Schema.TaggedErrorClass<ThreadHistoryQueryFailedError>()(
  "ThreadHistoryQueryFailedError",
  { operation: Schema.String },
) {
  override get message(): string {
    return `Thread-history query failed during ${this.operation}.`;
  }
}

export const ThreadHistoryError = Schema.Union([
  ThreadHistoryCapabilityUnavailableError,
  ThreadHistoryScopeError,
  ThreadHistoryThreadNotFoundError,
  ThreadHistoryInvalidRegexError,
  ThreadHistoryRegexTimeoutError,
  ThreadHistoryInvalidCursorError,
  ThreadHistoryQueryFailedError,
]);
export type ThreadHistoryError = typeof ThreadHistoryError.Type;
