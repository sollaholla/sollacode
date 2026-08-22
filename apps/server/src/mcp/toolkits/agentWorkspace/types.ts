import {
  ThreadId,
  VmAgentArtifact,
  VmAgentArtifactDefinition,
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
    "define_artifact",
    "update_artifact",
  ]).annotate({
    description:
      "Workspace operation. Recurring tasks created by an agent remain drafts until the user approves them.",
  }),
  taskId: Schema.optional(Schema.String).annotate({
    description: "Task id for update_task or complete_task.",
  }),
  title: Schema.optional(VmAgentTask.fields.title),
  prompt: Schema.optional(VmAgentTask.fields.prompt),
  completionCriteria: Schema.optional(VmAgentTask.fields.completionCriteria),
  schedule: Schema.optional(Schema.NullOr(VmAgentTaskSchedule)),
  notificationPolicy: Schema.optional(VmAgentTaskNotificationPolicy),
  notificationBody: Schema.optional(Schema.String.check(Schema.isMaxLength(4_000))),
  artifactDefinition: Schema.optional(VmAgentArtifactDefinition),
});
export type AgentWorkspaceInput = typeof AgentWorkspaceInput.Type;

export const AgentWorkspaceResult = Schema.Struct({
  action: Schema.String,
  status: Schema.String,
  workspace: Schema.optional(VmAgentWorkspaceSnapshot),
  task: Schema.optional(VmAgentTask),
  artifact: Schema.optional(VmAgentArtifact),
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
