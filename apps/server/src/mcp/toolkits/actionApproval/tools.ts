import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ActionApprovalPrompt from "./prompt.ts";
import { ActionApprovalError, ActionApprovalInput, ActionApprovalResult } from "./types.ts";

export const ActionApprovalTool = Tool.make("request_action_approval", {
  description:
    "Ask the user to approve a consequential external action before performing it, such as sending an email or message, publishing content, making a purchase, or changing an account. Supply the exact destination and content in preview, then wait. If the result is changes_requested, revise the action from feedback and call this tool again; do not perform the action until status is approved. Ordinary Agent-mode turns return approved automatically, but delegated agent and ephemeral-worker turns always require explicit human approval. This tool approves only the proposal -- the caller must perform the external action afterward.",
  parameters: ActionApprovalInput,
  success: ActionApprovalResult,
  failure: ActionApprovalError,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ProjectionSnapshotQuery,
    ActionApprovalPrompt.ActionApprovalPrompt,
  ],
})
  .annotate(Tool.Title, "Request action approval")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Meta, { "anthropic/alwaysLoad": true });

export const ActionApprovalToolkit = Toolkit.make(ActionApprovalTool);
