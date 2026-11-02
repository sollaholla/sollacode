import * as Crypto from "effect/Crypto";
import { Tool, Toolkit } from "effect/unstable/ai";
import { HttpClient } from "effect/unstable/http";

import { ServerEnvironment } from "../../../environment/ServerEnvironment.ts";
import { RelayedEnvironments } from "../../../relay/RelayedEnvironments.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { VmAgentStore } from "../../../persistence/Services/VmAgents.ts";
import { WorkspaceConsultError, WorkspaceConsultInput, WorkspaceConsultResult } from "./types.ts";

/**
 * The message door between chats: any chat (a person's chat, a custom agent or
 * its side chats, a terminal CLI on a thread's credential) can discover the
 * workspace's projects and conversations, put a real question to one, and get
 * the reply back. `thread_collaboration` covers a caller's own side-chat
 * family; this reaches everything else, on this computer and on the computers
 * its desktop app connected to.
 *
 * Open to every chat holding the universal "collaboration" capability. The
 * handler carries the loop guards: no messages into the caller's own family,
 * the orchestrator, Agent Builder or delegated-worker chats; a request may pass
 * through at most three chats and never back to one waiting on it; asks and
 * opened threads are capped per caller.
 */
export const WorkspaceConsultTool = Tool.make("workspace_consult", {
  description:
    "Talk to other chats and custom agents, on this computer and on the computers connected to it. `list_projects` and `list_threads` show what exists (`isAgent` marks an agent's chat; `environmentId` and `computer` mark a row on a connected computer, and `computers` says which were reachable); `ask` sends a question or request to an existing thread, or to a project (opening a new thread that shares the calling chat's browser profile), and waits for the reply; `read_thread` reads a conversation's recent messages. Both work the same for a chat on a connected computer: pass its `environmentId`. Ask the conversation that owns the context instead of guessing about a product, a codebase or a past decision. To have the person called, ask an agent's chat to use call_user. The other chat cannot see yours, so include the context it needs. Limits: not your own side-chat family, the orchestrator, Agent Builder or delegated-worker chats; a request passes through at most 3 chats and never back to one waiting on it; 20 asks per 10 minutes; 10 open threads you created. Work your message starts or joins asks the person before consequential actions.",
  parameters: WorkspaceConsultInput,
  success: WorkspaceConsultResult,
  failure: WorkspaceConsultError,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ProjectionSnapshotQuery,
    OrchestrationEngineService,
    VmAgentStore,
    Crypto.Crypto,
    RelayedEnvironments,
    ServerEnvironment,
    HttpClient.HttpClient,
  ],
})
  .annotate(Tool.Title, "Message other chats and agents")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  // Eagerly loaded: the whole point is that a chat reaches for this instead
  // of guessing, which it will never do if the tool is merely discoverable on
  // search.
  .annotate(Tool.Meta, { "anthropic/alwaysLoad": true });

export const WorkspaceConsultToolkit = Toolkit.make(WorkspaceConsultTool);
