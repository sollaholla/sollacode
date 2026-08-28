import { Tool, Toolkit } from "effect/unstable/ai";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { VmAgentStore } from "../../../persistence/Services/VmAgents.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ServerConfig from "../../../config.ts";
import { VmAgentTaskScheduler } from "../../../vm/VmAgentTaskScheduler.ts";
import { VmAgentWorkspace } from "../../../vm/VmAgentWorkspace.ts";
import { VmManager } from "../../../vm/VmManager.ts";
import { AgentBuilderError, AgentBuilderInput, AgentBuilderResult } from "./types.ts";

export const AgentBuilderTool = Tool.make("agent_builder", {
  description:
    "Design and manage custom agents end to end from this Agent Builder chat. create_agent makes a named agent with a dedicated chat, sharing the environment's browser profile and its logins; then configure everything it has: its chat's model and access (configure_agent_chat), scheduled or manual tasks with full prompts, criteria, schedules and notification policies (create_task/update_task/delete_task/run_task_now), notification preferences, and its artifact (define_artifact — structured data or an HTML/CSS dashboard). get_agent returns the full picture to verify against. delete_agent destroys the agent and requires confirmName to equal its name exactly. Act as the user's pen: what you create is live immediately, so read back with get_agent and report what you built.",
  parameters: AgentBuilderInput,
  success: AgentBuilderResult,
  failure: AgentBuilderError,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    VmAgentStore,
    VmAgentWorkspace,
    VmAgentTaskScheduler,
    VmManager,
    OrchestrationEngine.OrchestrationEngineService,
    // createAgentThread provisions the agent's isolated working directory.
    ServerConfig.ServerConfig,
    FileSystem.FileSystem,
    Path.Path,
  ],
})
  .annotate(Tool.Title, "Build and configure custom agents")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Meta, { "anthropic/alwaysLoad": true });

export const AgentBuilderToolkit = Toolkit.make(AgentBuilderTool);
