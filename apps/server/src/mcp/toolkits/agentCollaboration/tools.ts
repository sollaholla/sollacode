import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { VmAgentCollaborationStore } from "../../../persistence/Services/VmAgentCollaborations.ts";
import { VmAgentStore } from "../../../persistence/Services/VmAgents.ts";
import { VmAgentCollaboration } from "../../../vm/VmAgentCollaboration.ts";
import { VmAgentTaskScheduler } from "../../../vm/VmAgentTaskScheduler.ts";
import {
  AgentCollaborationError,
  AgentCollaborationInput,
  AgentCollaborationResult,
} from "./types.ts";

export const AgentCollaborationTool = Tool.make("agent_collaboration", {
  description:
    "Collaborate with VM agents in this Solla environment through bounded durable work. list_agents returns sanitized capabilities and provider/model summaries; delegate targets either one explicit existing agent or a hidden one-off ephemeral worker; list_work and read_work inspect only work in your authorized family; send_message adds a durable note, question, answer, or follow-up; cancel stops work you coordinate. The server derives source identity from this credential, enforces one generation of workers, three active children, a 30-minute wall clock, five follow-ups, 200 messages, same-environment/model inheritance, and explicit human approval for consequential delegated actions.",
  parameters: AgentCollaborationInput,
  success: AgentCollaborationResult,
  failure: AgentCollaborationError,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    VmAgentStore,
    VmAgentCollaborationStore,
    VmAgentCollaboration,
    VmAgentTaskScheduler,
  ],
})
  .annotate(Tool.Title, "Collaborate with VM agents")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Meta, { "anthropic/alwaysLoad": true });

export const AgentCollaborationToolkit = Toolkit.make(AgentCollaborationTool);
