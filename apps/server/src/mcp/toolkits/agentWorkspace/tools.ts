import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { VmAgentStore } from "../../../persistence/Services/VmAgents.ts";
import { VmAgentWorkspace } from "../../../vm/VmAgentWorkspace.ts";
import { VmAgentTaskScheduler } from "../../../vm/VmAgentTaskScheduler.ts";
import { AgentWorkspaceError, AgentWorkspaceInput, AgentWorkspaceResult } from "./types.ts";

export const AgentWorkspaceTool = Tool.make("agent_workspace", {
  description:
    "Manage your durable custom-agent workspace. You can list tasks, propose or create one-off work, update or complete tasks, notify the user, and define your single safe structured artifact. Recurring tasks you create require user approval before they run. The server derives your agent identity from this chat; you cannot target another agent.",
  parameters: AgentWorkspaceInput,
  success: AgentWorkspaceResult,
  failure: AgentWorkspaceError,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    VmAgentStore,
    VmAgentWorkspace,
    VmAgentTaskScheduler,
  ],
})
  .annotate(Tool.Title, "Manage this agent's workspace")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Meta, { "anthropic/alwaysLoad": true });

export const AgentWorkspaceToolkit = Toolkit.make(AgentWorkspaceTool);
