import {
  ThreadId,
  VmAgentCollaborationAgentSummary,
  VmAgentCollaborationError,
  VmAgentCollaborationReceipt,
  VmAgentDelegationDetail,
  VmAgentDelegationId,
  VmAgentDelegationMessageKind,
  VmAgentDelegationSummary,
  VmAgentId,
  VmAgentTaskCompletionCriteria,
  VmAgentCollaborationCapability,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * Flat multi-action input keeps MCP tools/list compatible with clients that do
 * not accept a union at the JSON-schema root. Per-action requirements are
 * enforced by the credential-bound handler.
 */
export const AgentCollaborationInput = Schema.Struct({
  action: Schema.Literals([
    "list_agents",
    "delegate",
    "list_work",
    "read_work",
    "send_message",
    "cancel",
  ]),
  delegationId: Schema.optional(VmAgentDelegationId),
  targetKind: Schema.optional(Schema.Literals(["agent", "ephemeral"])),
  targetVmAgentId: Schema.optional(VmAgentId),
  workerLabel: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  task: Schema.optional(Schema.String.check(Schema.isMaxLength(50_000))),
  completionCriteria: Schema.optional(VmAgentTaskCompletionCriteria),
  requestedCapabilities: Schema.optional(
    Schema.Array(VmAgentCollaborationCapability).check(Schema.isMaxLength(32)),
  ),
  idempotencyKey: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  message: Schema.optional(Schema.String.check(Schema.isMaxLength(20_000))),
  kind: Schema.optional(VmAgentDelegationMessageKind),
  waitForReply: Schema.optional(Schema.Boolean),
});
export type AgentCollaborationInput = typeof AgentCollaborationInput.Type;

export const AgentCollaborationResult = Schema.Struct({
  action: Schema.String,
  status: Schema.String,
  agents: Schema.optional(Schema.Array(VmAgentCollaborationAgentSummary)),
  /** True when the bounded list_agents result omits additional host agents. */
  hasMoreAgents: Schema.optional(Schema.Boolean),
  work: Schema.optional(Schema.Array(VmAgentDelegationSummary)),
  /** True when the bounded list_work result omits older delegated work. */
  hasMoreWork: Schema.optional(Schema.Boolean),
  detail: Schema.optional(VmAgentDelegationDetail),
  receipt: Schema.optional(VmAgentCollaborationReceipt),
});
export type AgentCollaborationResult = typeof AgentCollaborationResult.Type;

export class AgentCollaborationCapabilityUnavailableError extends Schema.TaggedErrorClass<AgentCollaborationCapabilityUnavailableError>()(
  "AgentCollaborationCapabilityUnavailableError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "agent_collaboration is only available to a credential-bound VM agent or delegated worker.";
  }
}

export class AgentCollaborationNoActorError extends Schema.TaggedErrorClass<AgentCollaborationNoActorError>()(
  "AgentCollaborationNoActorError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "This chat is not a VM agent or an active delegated worker.";
  }
}

export class AgentCollaborationInvalidInputError extends Schema.TaggedErrorClass<AgentCollaborationInvalidInputError>()(
  "AgentCollaborationInvalidInputError",
  { action: Schema.String, missing: Schema.String },
) {
  override get message(): string {
    return `agent_collaboration action "${this.action}" requires "${this.missing}".`;
  }
}

export class AgentCollaborationOperationFailedError extends Schema.TaggedErrorClass<AgentCollaborationOperationFailedError>()(
  "AgentCollaborationOperationFailedError",
  { operation: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `agent_collaboration failed while ${this.operation}: ${this.detail}`;
  }
}

export const AgentCollaborationError = Schema.Union([
  AgentCollaborationCapabilityUnavailableError,
  AgentCollaborationNoActorError,
  AgentCollaborationInvalidInputError,
  AgentCollaborationOperationFailedError,
  VmAgentCollaborationError,
]);
export type AgentCollaborationError = typeof AgentCollaborationError.Type;
