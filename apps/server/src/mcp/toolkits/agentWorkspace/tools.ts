import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { VmAgentStore } from "../../../persistence/Services/VmAgents.ts";
import { AgentCalls } from "../../../vm/AgentCalls.ts";
import { VmAgentWorkspace } from "../../../vm/VmAgentWorkspace.ts";
import { VmAgentTaskScheduler } from "../../../vm/VmAgentTaskScheduler.ts";
import { VmManager } from "../../../vm/VmManager.ts";
import { AgentWorkspaceError, AgentWorkspaceInput, AgentWorkspaceResult } from "./types.ts";

export const AgentWorkspaceTool = Tool.make("agent_workspace", {
  description:
    "Manage your durable custom-agent workspace. You can list tasks, propose or create one-off work, update or complete tasks, notify the user, report and resolve blockers, define your single artifact (structured data or an HTML/CSS dashboard), and maintain a legacy icon for older clients (set_icon). Current clients automatically assign your blob avatar and stable color; no icon setup is needed. When your work is blocked on something only the user can do — a login, a CAPTCHA, a permission grant, a purchase — use report_blocker instead of only describing it in prose: it keeps a standing, visible request in front of the user that persists across turns and scheduled runs until resolved. The blocker card is already the user's alert: NEVER also call notify_user for the same request. notify_user is only for an independent informational update that requires no user action. Raise ONE blocker per distinct user action, each with its own blockerUrl — four accounts to create is four blockers, not one with a numbered list; the card's Open button takes the user straight to that blocker's page, so the URL belongs in blockerUrl, never described in prose. Keep blockerDetail to a sentence or two: what is blocked and the one thing to do at that page. Check the workspace snapshot's open blockers at the start of a run, retest whether each still blocks you, and resolve_blocker the ones that no longer do. call_user rings the user for a live voice call with you (give a one-sentence callReason); use it only when a real conversation is genuinely needed — a new blocker or a question already rings the user when calls are on, so never pair call_user with report_blocker or notify_user. Recurring tasks you create require user approval before they run, unless the user enabled task auto-approval and this chat runs in Agent mode — then they activate immediately. The server derives your agent identity from this chat; you cannot target another agent.",
  parameters: AgentWorkspaceInput,
  success: AgentWorkspaceResult,
  failure: AgentWorkspaceError,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    VmAgentStore,
    VmAgentWorkspace,
    VmAgentTaskScheduler,
    VmManager,
    AgentCalls,
  ],
})
  .annotate(Tool.Title, "Manage this agent's workspace")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Meta, { "anthropic/alwaysLoad": true });

export const AgentWorkspaceToolkit = Toolkit.make(AgentWorkspaceTool);
