import {
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  VmAgent,
  VmAgentArtifact,
  VmAgentArtifactDefinition,
  VmAgentTask,
  VmAgentTaskNotificationPolicy,
  VmAgentTaskSchedule,
  VmAgentWorkspaceSnapshot,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

// Flat multi-action input on purpose: a Schema.Union at the root compiles to a
// top-level anyOf, which some MCP clients reject during tools/list validation —
// taking every tool down with it. The handler validates per-action fields.
export const AgentBuilderInput = Schema.Struct({
  action: Schema.Literals([
    "list_agents",
    "get_agent",
    "create_agent",
    "configure_agent_chat",
    "start_agent",
    "stop_agent",
    "create_task",
    "update_task",
    "delete_task",
    "run_task_now",
    "set_notification_preferences",
    "define_artifact",
    "delete_agent",
  ]).annotate({
    description:
      "Builder operation. create_agent first; every other action targets an existing agent by agentName (or agentId).",
  }),
  agentName: Schema.optional(Schema.String).annotate({
    description: "Target agent's exact name, for every action except list_agents/create_agent.",
  }),
  agentId: Schema.optional(Schema.String).annotate({
    description: "Target agent's id, as an alternative to agentName.",
  }),
  name: Schema.optional(VmAgent.fields.name).annotate({
    description: "create_agent: the agent's name. Doubles as its @mention handle; must be unique.",
  }),
  purpose: Schema.optional(VmAgent.fields.purpose).annotate({
    description: "create_agent: what this agent is for, in a sentence or two.",
  }),
  modelSelection: Schema.optional(ModelSelection).annotate({
    description: "create_agent/configure_agent_chat: the model the agent's own chat runs on.",
  }),
  runtimeMode: Schema.optional(RuntimeMode).annotate({
    description: "configure_agent_chat: the agent chat's access mode.",
  }),
  interactionMode: Schema.optional(ProviderInteractionMode).annotate({
    description: "configure_agent_chat: the agent chat's interaction mode.",
  }),
  taskId: Schema.optional(Schema.String).annotate({
    description: "Task id for update_task, delete_task, and run_task_now.",
  }),
  title: Schema.optional(VmAgentTask.fields.title).annotate({
    description: "Task title, or the artifact title for define_artifact.",
  }),
  prompt: Schema.optional(VmAgentTask.fields.prompt).annotate({
    description:
      "Task prompt — the complete instructions the agent receives when the task runs. Write it to run unattended.",
  }),
  completionCriteria: Schema.optional(VmAgentTask.fields.completionCriteria),
  schedule: Schema.optional(Schema.NullOr(VmAgentTaskSchedule)).annotate({
    description:
      "Task schedule: {kind:'once',runAt} or {kind:'interval',everyMinutes}; null runs only by hand.",
  }),
  notificationPolicy: Schema.optional(VmAgentTaskNotificationPolicy),
  taskStatus: Schema.optional(Schema.Literals(["active", "paused", "completed"])).annotate({
    description: "update_task: pause, resume, or retire the task.",
  }),
  notificationsEnabled: Schema.optional(Schema.Boolean),
  notifyTaskCompletions: Schema.optional(Schema.Boolean),
  notifyTaskFailures: Schema.optional(Schema.Boolean),
  notifyAgentMessages: Schema.optional(Schema.Boolean),
  artifactDefinition: Schema.optional(VmAgentArtifactDefinition).annotate({
    description: "define_artifact: the agent's single structured surface.",
  }),
  confirmName: Schema.optional(Schema.String).annotate({
    description:
      "delete_agent: must equal the agent's name exactly. Deleting destroys its computer, tasks, and chat history.",
  }),
});
export type AgentBuilderInput = typeof AgentBuilderInput.Type;

export const AgentBuilderResult = Schema.Struct({
  action: Schema.String,
  status: Schema.String,
  agent: Schema.optional(VmAgent),
  agents: Schema.optional(Schema.Array(VmAgent)),
  workspace: Schema.optional(VmAgentWorkspaceSnapshot),
  task: Schema.optional(VmAgentTask),
  artifact: Schema.optional(VmAgentArtifact),
});

export class AgentBuilderCapabilityUnavailableError extends Schema.TaggedErrorClass<AgentBuilderCapabilityUnavailableError>()(
  "AgentBuilderCapabilityUnavailableError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "The agent_builder tool is only available inside an Agent Builder chat.";
  }
}

export class AgentBuilderUnknownAgentError extends Schema.TaggedErrorClass<AgentBuilderUnknownAgentError>()(
  "AgentBuilderUnknownAgentError",
  { reference: Schema.String },
) {
  override get message(): string {
    return `No agent matches "${this.reference}". Use list_agents to see what exists.`;
  }
}

export class AgentBuilderInvalidInputError extends Schema.TaggedErrorClass<AgentBuilderInvalidInputError>()(
  "AgentBuilderInvalidInputError",
  { action: Schema.String, missing: Schema.String },
) {
  override get message(): string {
    return `agent_builder action "${this.action}" requires "${this.missing}".`;
  }
}

export class AgentBuilderFailedError extends Schema.TaggedErrorClass<AgentBuilderFailedError>()(
  "AgentBuilderFailedError",
  { operation: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `agent_builder failed while ${this.operation}: ${this.detail}`;
  }
}

export const AgentBuilderError = Schema.Union([
  AgentBuilderCapabilityUnavailableError,
  AgentBuilderUnknownAgentError,
  AgentBuilderInvalidInputError,
  AgentBuilderFailedError,
]);
