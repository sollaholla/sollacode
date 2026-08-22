import { ThreadId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const ActionApprovalKind = Schema.Literals([
  "send_email",
  "send_message",
  "publish_content",
  "make_purchase",
  "change_account",
  "external_action",
]);
export type ActionApprovalKind = typeof ActionApprovalKind.Type;

const ActionApprovalSummary = TrimmedNonEmptyString.check(Schema.isMaxLength(240));
const ActionApprovalPreview = TrimmedNonEmptyString.check(Schema.isMaxLength(60_000));
const ActionApprovalFeedback = TrimmedNonEmptyString.check(Schema.isMaxLength(20_000));

export const ActionApprovalInput = Schema.Struct({
  actionKind: ActionApprovalKind.annotate({
    description: "The consequential external action the agent intends to perform.",
  }),
  summary: ActionApprovalSummary.annotate({
    description: "A short destination-aware summary, for example Send email to pat@example.com.",
  }),
  preview: ActionApprovalPreview.annotate({
    description:
      "The exact user-visible content and relevant destination/details that will be acted on if approved.",
  }),
});
export type ActionApprovalInput = typeof ActionApprovalInput.Type;

export const ActionApprovalResult = Schema.Struct({
  status: Schema.Literals(["approved", "changes_requested", "cancelled", "approval_unavailable"]),
  approvalMode: Schema.Literals(["user", "agent", "none"]),
  feedback: Schema.optional(ActionApprovalFeedback),
});
export type ActionApprovalResult = typeof ActionApprovalResult.Type;

export class ActionApprovalCapabilityUnavailableError extends Schema.TaggedErrorClass<ActionApprovalCapabilityUnavailableError>()(
  "ActionApprovalCapabilityUnavailableError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "This MCP credential does not grant action-approval access.";
  }
}

export class ActionApprovalThreadNotFoundError extends Schema.TaggedErrorClass<ActionApprovalThreadNotFoundError>()(
  "ActionApprovalThreadNotFoundError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Thread '${this.threadId}' was not found or is no longer active.`;
  }
}

export class ActionApprovalOperationFailedError extends Schema.TaggedErrorClass<ActionApprovalOperationFailedError>()(
  "ActionApprovalOperationFailedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "The thread state needed for action approval could not be read.";
  }
}

export const ActionApprovalError = Schema.Union([
  ActionApprovalCapabilityUnavailableError,
  ActionApprovalThreadNotFoundError,
  ActionApprovalOperationFailedError,
]);
export type ActionApprovalError = typeof ActionApprovalError.Type;
