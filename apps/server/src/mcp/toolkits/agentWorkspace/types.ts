import {
  ThreadId,
  VmAgentArtifact,
  VmAgentArtifactDefinition,
  VmAgentBlocker,
  VmAgentIcon,
  VmAgentTask,
  VmAgentTaskNotificationPolicy,
  VmAgentTaskSchedule,
  VmAgentWorkspaceSnapshot,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const AgentWorkspaceInput = Schema.Struct({
  action: Schema.Literals([
    "list_tasks",
    "propose_task",
    "create_task",
    "update_task",
    "complete_task",
    "notify_user",
    "report_blocker",
    "resolve_blocker",
    "define_artifact",
    "update_artifact",
    "set_icon",
  ]).annotate({
    description:
      "Workspace operation. Recurring tasks created by an agent remain drafts until the user approves them, unless the user enabled task auto-approval and this chat runs in Agent mode — then they activate immediately. report_blocker keeps a standing, visible request in front of the user when work is blocked on something only they can do (a login, a CAPTCHA, a permission, a purchase) — it persists across turns and runs until resolved, unlike prose in the chat. A blocker is already user-visible attention: NEVER also call notify_user for that request. notify_user is only for independent informational updates that require no user action. resolve_blocker clears one you raised once it no longer blocks you.",
  }),
  taskId: Schema.optional(Schema.String).annotate({
    description: "Task id for update_task or complete_task.",
  }),
  icon: Schema.optional(VmAgentIcon).annotate({
    description:
      "set_icon: your outlined glyph — the uncoloured, emoji-like icon that identifies you in the sidebar and header. Pick the one that best fits your purpose. Do this once, as the first step of your first run, when the workspace snapshot says you have no icon yet.",
  }),
  title: Schema.optional(VmAgentTask.fields.title),
  prompt: Schema.optional(VmAgentTask.fields.prompt),
  completionCriteria: Schema.optional(VmAgentTask.fields.completionCriteria),
  schedule: Schema.optional(Schema.NullOr(VmAgentTaskSchedule)),
  notificationPolicy: Schema.optional(VmAgentTaskNotificationPolicy),
  notificationBody: Schema.optional(Schema.String.check(Schema.isMaxLength(4_000))).annotate({
    description:
      "notify_user only: an independent informational update that requires no user action. Never use this to repeat or announce a report_blocker request; the waiting-on-you card is already the alert.",
  }),
  artifactDefinition: Schema.optional(VmAgentArtifactDefinition),
  blockerId: Schema.optional(Schema.String).annotate({
    description:
      "Blocker id for resolve_blocker (from report_blocker's result or the workspace snapshot).",
  }),
  blockerDetail: Schema.optional(Schema.String.check(Schema.isMaxLength(4_000))).annotate({
    description:
      "report_blocker: what is blocked and the one thing the user must do to unblock it, in a sentence or two. Shown on the standing request card — put the page in blockerUrl (the card's Open button), not in this text, and raise separate blockers for separate actions instead of a numbered list here.",
  }),
  blockerUrl: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(500)))).annotate(
    {
      description: "report_blocker: where the user should go to unblock, when there is one place.",
    },
  ),
});
export type AgentWorkspaceInput = typeof AgentWorkspaceInput.Type;

export const AgentWorkspaceResult = Schema.Struct({
  action: Schema.String,
  status: Schema.String,
  workspace: Schema.optional(VmAgentWorkspaceSnapshot),
  task: Schema.optional(VmAgentTask),
  artifact: Schema.optional(VmAgentArtifact),
  blocker: Schema.optional(VmAgentBlocker),
});

export class AgentWorkspaceCapabilityUnavailableError extends Schema.TaggedErrorClass<AgentWorkspaceCapabilityUnavailableError>()(
  "AgentWorkspaceCapabilityUnavailableError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "The agent_workspace tool is only available inside a custom agent's dedicated chat.";
  }
}

export class AgentWorkspaceNoAgentError extends Schema.TaggedErrorClass<AgentWorkspaceNoAgentError>()(
  "AgentWorkspaceNoAgentError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "This chat does not belong to a custom VM agent.";
  }
}

export class AgentWorkspaceInvalidInputError extends Schema.TaggedErrorClass<AgentWorkspaceInvalidInputError>()(
  "AgentWorkspaceInvalidInputError",
  { action: Schema.String, missing: Schema.String },
) {
  override get message(): string {
    return `agent_workspace action "${this.action}" requires "${this.missing}".`;
  }
}

export class AgentWorkspaceFailedError extends Schema.TaggedErrorClass<AgentWorkspaceFailedError>()(
  "AgentWorkspaceFailedError",
  { operation: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `agent_workspace failed while ${this.operation}: ${this.detail}`;
  }
}

export const AgentWorkspaceError = Schema.Union([
  AgentWorkspaceCapabilityUnavailableError,
  AgentWorkspaceNoAgentError,
  AgentWorkspaceInvalidInputError,
  AgentWorkspaceFailedError,
]);
