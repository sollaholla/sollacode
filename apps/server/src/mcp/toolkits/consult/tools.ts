import * as Crypto from "effect/Crypto";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { VmAgentStore } from "../../../persistence/Services/VmAgents.ts";
import { WorkspaceConsultError, WorkspaceConsultInput, WorkspaceConsultResult } from "./types.ts";

/**
 * Lets a VM agent reach the rest of the workspace.
 *
 * An agent's own environment is a browser; plenty of what it needs to answer —
 * how a product actually behaves, what a codebase does, what a project decided —
 * lives in the user's other conversations instead. The preview browser cannot
 * reach those, and `thread_collaboration` scopes a caller to its own side-chat
 * family.
 * This is the outward door: discover projects and threads, then put a real
 * question to one and get the reply back.
 *
 * Gated on the caller being a VM agent (resolved through {@link VmAgentStore}),
 * mirroring how the orchestrator's toolkit is gated on its reserved thread id.
 */
export const WorkspaceConsultTool = Tool.make("workspace_consult", {
  description:
    "Consult the rest of this workspace — its projects and their conversations — when the answer lives outside your own browser. Use `list_projects` and `list_threads` to see what exists, then `ask` to put a question to a project (which opens a new thread there) or to an existing thread, and you get the reply back. Ideal for questions about a product's real behavior, a codebase, or a past decision that you would otherwise have to guess at: ask the conversation that owns that context instead of guessing. If `ask` returns while the other side is still working, poll `read_thread` for the reply. The other conversation cannot see your screen or your chat, so include the context it needs in the question.",
  parameters: WorkspaceConsultInput,
  success: WorkspaceConsultResult,
  failure: WorkspaceConsultError,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ProjectionSnapshotQuery,
    OrchestrationEngineService,
    VmAgentStore,
    Crypto.Crypto,
  ],
})
  .annotate(Tool.Title, "Consult the workspace")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  // Eagerly loaded: the whole point is that the agent reaches for this
  // instead of guessing, which it will never do if the tool is merely
  // discoverable on search.
  .annotate(Tool.Meta, { "anthropic/alwaysLoad": true });

export const WorkspaceConsultToolkit = Toolkit.make(WorkspaceConsultTool);
