import {
  IsoDateTime,
  ModelSelection,
  OrchestrationSessionStatus,
  ProviderInteractionMode,
  ProviderInstanceId,
  RuntimeMode,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { ThreadHistoryQueryInput, ThreadHistoryQueryResult } from "../history/types.ts";

const BoundedTask = TrimmedNonEmptyString.check(Schema.isMaxLength(120_000));
const BoundedTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(240));

const ThreadHistoryQueryOptions = Schema.Struct({
  query: ThreadHistoryQueryInput.fields.query,
  matchMode: ThreadHistoryQueryInput.fields.matchMode,
  regexFlags: ThreadHistoryQueryInput.fields.regexFlags,
  caseSensitive: ThreadHistoryQueryInput.fields.caseSensitive,
  sources: ThreadHistoryQueryInput.fields.sources,
  roles: ThreadHistoryQueryInput.fields.roles,
  activityKinds: ThreadHistoryQueryInput.fields.activityKinds,
  turnIds: ThreadHistoryQueryInput.fields.turnIds,
  since: ThreadHistoryQueryInput.fields.since,
  until: ThreadHistoryQueryInput.fields.until,
  order: ThreadHistoryQueryInput.fields.order,
  pageSize: ThreadHistoryQueryInput.fields.pageSize,
  cursor: ThreadHistoryQueryInput.fields.cursor,
  includeAttachments: ThreadHistoryQueryInput.fields.includeAttachments,
  includePayload: ThreadHistoryQueryInput.fields.includePayload,
  includeStreaming: ThreadHistoryQueryInput.fields.includeStreaming,
  maxTextChars: ThreadHistoryQueryInput.fields.maxTextChars,
  maxPayloadChars: ThreadHistoryQueryInput.fields.maxPayloadChars,
  maxScanRecords: ThreadHistoryQueryInput.fields.maxScanRecords,
});

const SetModelInput = Schema.Struct({
  action: Schema.Literal("set_model"),
  modelSelection: ModelSelection.annotate({
    description:
      "Model and configured provider instance to use for this chat's next turn or Agent continuation.",
  }),
  runtimeMode: Schema.optional(RuntimeMode).annotate({
    description: "Optional access mode to apply to the calling chat.",
  }),
  interactionMode: Schema.optional(ProviderInteractionMode).annotate({
    description:
      "Optional interaction mode to apply to the calling chat. Switching away from agent also suppresses pending Agent continuations.",
  }),
});

const CreateSideChatInput = Schema.Struct({
  action: Schema.Literal("create_side_chat"),
  task: BoundedTask.annotate({
    description: "The isolated task to send to the new side-chat agent immediately.",
  }),
  title: Schema.optional(BoundedTitle).annotate({
    description: "Optional side-chat tab title. Defaults to Side task and may be auto-renamed.",
  }),
  modelSelection: Schema.optional(ModelSelection).annotate({
    description: "Optional model for the side task. Defaults to the calling chat's model.",
  }),
  runtimeMode: Schema.optional(RuntimeMode).annotate({
    description: "Optional access mode. Defaults to the calling chat's access mode.",
  }),
  interactionMode: Schema.optional(ProviderInteractionMode).annotate({
    description: "Defaults to agent so the side task continues autonomously until completion.",
  }),
});

const ListRelatedChatsInput = Schema.Struct({
  action: Schema.Literal("list_related_chats"),
});

const QueryRelatedChatInput = Schema.Struct({
  action: Schema.Literal("query_related_chat"),
  threadId: ThreadId.annotate({
    description:
      "A thread returned by list_related_chats. Only the current chat, its parent, children, or sibling side chats are authorized.",
  }),
  history: Schema.optional(ThreadHistoryQueryOptions).annotate({
    description: "Optional bounded history filters. Defaults to the newest 40 entries.",
  }),
});

const ThreadCollaborationInputVariants = Schema.Union([
  SetModelInput,
  CreateSideChatInput,
  ListRelatedChatsInput,
  QueryRelatedChatInput,
]);

// MCP requires every tool input schema to have an object at its root. A raw
// union of structs serializes as a root-level `anyOf`, which Claude's SDK
// correctly rejects during tools/list validation. Keep the discriminated
// union as the decoded type while exposing one object-shaped wire schema.
const ThreadCollaborationInputWire = Schema.Struct({
  action: Schema.Literals([
    "set_model",
    "create_side_chat",
    "list_related_chats",
    "query_related_chat",
  ]),
  modelSelection: Schema.optional(ModelSelection),
  task: Schema.optional(BoundedTask),
  title: Schema.optional(BoundedTitle),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  threadId: Schema.optional(ThreadId),
  history: Schema.optional(ThreadHistoryQueryOptions),
});

export const ThreadCollaborationInput = ThreadCollaborationInputWire.pipe(
  Schema.decodeTo(
    ThreadCollaborationInputVariants,
    SchemaTransformation.transform<
      typeof ThreadCollaborationInputVariants.Encoded,
      typeof ThreadCollaborationInputWire.Type
    >({
      decode: (input) => input as typeof ThreadCollaborationInputVariants.Encoded,
      encode: (input) => input as typeof ThreadCollaborationInputWire.Type,
    }),
  ),
);
export type ThreadCollaborationInput = typeof ThreadCollaborationInput.Type;

export const ThreadRelationship = Schema.Literals([
  "self",
  "parent",
  "child",
  "sibling",
  "related",
]);
export type ThreadRelationship = typeof ThreadRelationship.Type;

export const RelatedChatSummary = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  relationship: ThreadRelationship,
  isSideChat: Schema.Boolean,
  parentThreadId: Schema.NullOr(ThreadId),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  sessionStatus: Schema.NullOr(OrchestrationSessionStatus),
  activeTurnId: Schema.NullOr(TurnId),
  latestTurnState: Schema.NullOr(
    Schema.Literals(["running", "interrupted", "incomplete", "completed", "error"]),
  ),
  isWorking: Schema.Boolean,
  updatedAt: IsoDateTime,
});
export type RelatedChatSummary = typeof RelatedChatSummary.Type;

const SetModelResult = Schema.Struct({
  action: Schema.Literal("set_model"),
  threadId: ThreadId,
  previousModelSelection: ModelSelection,
  modelSelection: ModelSelection,
  previousRuntimeMode: RuntimeMode,
  runtimeMode: RuntimeMode,
  previousInteractionMode: ProviderInteractionMode,
  interactionMode: ProviderInteractionMode,
  effectiveOn: Schema.Literal("next_turn"),
});

const CreateSideChatResult = Schema.Struct({
  action: Schema.Literal("create_side_chat"),
  sourceThreadId: ThreadId,
  sideChat: RelatedChatSummary,
  taskSubmitted: Schema.Boolean,
});

const ListRelatedChatsResult = Schema.Struct({
  action: Schema.Literal("list_related_chats"),
  callerThreadId: ThreadId,
  relatedChats: Schema.Array(RelatedChatSummary),
});

const QueryRelatedChatResult = Schema.Struct({
  action: Schema.Literal("query_related_chat"),
  callerThreadId: ThreadId,
  target: RelatedChatSummary,
  history: ThreadHistoryQueryResult,
});

export const ThreadCollaborationResult = Schema.Union([
  SetModelResult,
  CreateSideChatResult,
  ListRelatedChatsResult,
  QueryRelatedChatResult,
]);
export type ThreadCollaborationResult = typeof ThreadCollaborationResult.Type;

export class ThreadCollaborationCapabilityUnavailableError extends Schema.TaggedErrorClass<ThreadCollaborationCapabilityUnavailableError>()(
  "ThreadCollaborationCapabilityUnavailableError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "This MCP credential does not grant thread-collaboration access.";
  }
}

export class ThreadCollaborationThreadNotFoundError extends Schema.TaggedErrorClass<ThreadCollaborationThreadNotFoundError>()(
  "ThreadCollaborationThreadNotFoundError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Thread '${this.threadId}' was not found or is no longer active.`;
  }
}

export class ThreadCollaborationScopeError extends Schema.TaggedErrorClass<ThreadCollaborationScopeError>()(
  "ThreadCollaborationScopeError",
  {
    requestedThreadId: ThreadId,
    authorizedThreadId: ThreadId,
  },
) {
  override get message(): string {
    return "The requested thread is not related to this agent's credential-bound chat.";
  }
}

export class ThreadCollaborationModelUnavailableError extends Schema.TaggedErrorClass<ThreadCollaborationModelUnavailableError>()(
  "ThreadCollaborationModelUnavailableError",
  {
    instanceId: ProviderInstanceId,
    model: Schema.String,
    reason: Schema.Literals(["provider_unavailable", "model_unavailable"]),
  },
) {
  override get message(): string {
    return this.reason === "provider_unavailable"
      ? `Provider instance '${this.instanceId}' is unavailable.`
      : `Model '${this.model}' is unavailable on provider instance '${this.instanceId}'.`;
  }
}

export class ThreadCollaborationOperationFailedError extends Schema.TaggedErrorClass<ThreadCollaborationOperationFailedError>()(
  "ThreadCollaborationOperationFailedError",
  {
    operation: Schema.String,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `Thread collaboration failed during ${this.operation}.`;
  }
}

export const ThreadCollaborationError = Schema.Union([
  ThreadCollaborationCapabilityUnavailableError,
  ThreadCollaborationThreadNotFoundError,
  ThreadCollaborationScopeError,
  ThreadCollaborationModelUnavailableError,
  ThreadCollaborationOperationFailedError,
]);
export type ThreadCollaborationError = typeof ThreadCollaborationError.Type;

export type ThreadHistoryOptions = typeof ThreadHistoryQueryOptions.Type;
