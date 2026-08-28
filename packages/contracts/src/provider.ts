import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ApprovalRequestId,
  EventId,
  IsoDateTime,
  MessageId,
  ProviderItemId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
} from "./baseSchemas.ts";
import {
  ChatAttachment,
  ModelSelection,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderApprovalDecision,
  ProviderApprovalPolicy,
  ProviderInteractionMode,
  ProviderRequestKind,
  ProviderSandboxMode,
  ProviderUserInputAnswers,
  RuntimeMode,
} from "./orchestration.ts";
import { ProviderInstanceId, ProviderDriverKind } from "./providerInstance.ts";
import { AutoCompactionThresholdPercentage } from "./settings.ts";

const ProviderSessionStatus = Schema.Literals([
  "connecting",
  "ready",
  "running",
  "error",
  "closed",
]);

export const ProviderPendingContextRecovery = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("native-resume-timeout"),
  sourceMessageId: Schema.NullOr(MessageId),
  providerInstanceId: ProviderInstanceId,
  createdAt: IsoDateTime,
});
export type ProviderPendingContextRecovery = typeof ProviderPendingContextRecovery.Type;

export const ProviderSession = Schema.Struct({
  provider: ProviderDriverKind,
  // Optional during the driver/instance migration. Once every producer
  // populates it (post-slice-4), routing flips to instance-id-only and the
  // legacy `provider` field is removed.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  status: ProviderSessionStatus,
  runtimeMode: RuntimeMode,
  cwd: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  threadId: ThreadId,
  resumeCursor: Schema.optional(Schema.Unknown),
  pendingContextRecovery: Schema.optional(ProviderPendingContextRecovery),
  activeTurnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastError: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderSession = typeof ProviderSession.Type;

export const ProviderSessionStartInput = Schema.Struct({
  threadId: ThreadId,
  provider: Schema.optional(ProviderDriverKind),
  // See ProviderSession for the migration story.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  cwd: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  /** `null` explicitly starts fresh instead of inheriting a persisted cursor. */
  resumeCursor: Schema.optional(Schema.Unknown),
  approvalPolicy: Schema.optional(ProviderApprovalPolicy),
  sandboxMode: Schema.optional(ProviderSandboxMode),
  autoCompactionThresholdPercentage: Schema.optional(AutoCompactionThresholdPercentage),
  tokenOptimizerEnabled: Schema.optional(Schema.Boolean),
  runtimeMode: RuntimeMode,
});
export type ProviderSessionStartInput = typeof ProviderSessionStartInput.Type;

export const ProviderLiveSteerTarget = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  activeTurnId: TurnId,
});
export type ProviderLiveSteerTarget = typeof ProviderLiveSteerTarget.Type;

export const ProviderSendTurnInput = Schema.Struct({
  threadId: ThreadId,
  /**
   * The message this turn was started from, when the caller knows it.
   *
   * Carried purely so the adapter can report back when the provider actually
   * consumes the prompt. Optional because the id is not required to run a turn,
   * and older callers omit it — a missing id costs the delivery indicator, not
   * the turn.
   */
  messageId: Schema.optional(MessageId),
  input: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  ),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
  modelSelection: Schema.optional(ModelSelection),
  interactionMode: Schema.optional(ProviderInteractionMode),
  /**
   * Internal proof that this input must join one exact provider-native turn.
   * ProviderService fails closed instead of recovering or starting a session
   * when the target is no longer live.
   */
  liveSteerTarget: Schema.optional(ProviderLiveSteerTarget),
  /** Internal tag proving this turn is the bounded handoff for a timed-out native resume. */
  contextRecovery: Schema.optional(ProviderPendingContextRecovery),
  /** Internal harness hint: prepend the invisible side-chat sub-agent guard
      before sending this turn to the provider. */
  isSideChat: Schema.optionalKey(Schema.Boolean),
  autoCompactionThresholdPercentage: Schema.optional(AutoCompactionThresholdPercentage),
  tokenOptimizerEnabled: Schema.optional(Schema.Boolean),
});
export type ProviderSendTurnInput = typeof ProviderSendTurnInput.Type;

export const ProviderTurnStartResult = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  resumeCursor: Schema.optional(Schema.Unknown),
});
export type ProviderTurnStartResult = typeof ProviderTurnStartResult.Type;

export const ProviderInterruptTurnInput = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
});
export type ProviderInterruptTurnInput = typeof ProviderInterruptTurnInput.Type;

export const ProviderPromoteQueuedTurnInput = Schema.Struct({
  threadId: ThreadId,
  messageIds: Schema.optional(Schema.Array(MessageId)),
});
export type ProviderPromoteQueuedTurnInput = typeof ProviderPromoteQueuedTurnInput.Type;

export const ProviderStopTaskInput = Schema.Struct({
  threadId: ThreadId,
  taskId: RuntimeTaskId,
});
export type ProviderStopTaskInput = typeof ProviderStopTaskInput.Type;

export const ProviderStopSessionInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderStopSessionInput = typeof ProviderStopSessionInput.Type;

export const ProviderRespondToRequestInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
});
export type ProviderRespondToRequestInput = typeof ProviderRespondToRequestInput.Type;

export const ProviderRespondToUserInputInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
});
export type ProviderRespondToUserInputInput = typeof ProviderRespondToUserInputInput.Type;

const ProviderEventKind = Schema.Literals(["session", "notification", "request", "error"]);

export const ProviderEvent = Schema.Struct({
  id: EventId,
  kind: ProviderEventKind,
  provider: ProviderDriverKind,
  // See ProviderSession for the migration story.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  threadId: ThreadId,
  createdAt: IsoDateTime,
  method: TrimmedNonEmptyString,
  message: Schema.optional(TrimmedNonEmptyString),
  turnId: Schema.optional(TurnId),
  itemId: Schema.optional(ProviderItemId),
  requestId: Schema.optional(ApprovalRequestId),
  requestKind: Schema.optional(ProviderRequestKind),
  textDelta: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
});
export type ProviderEvent = typeof ProviderEvent.Type;
