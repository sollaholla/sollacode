import * as Crypto from "effect/Crypto";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import * as ThreadHistoryQuery from "../history/ThreadHistoryQuery.ts";
import {
  ThreadCollaborationError,
  ThreadCollaborationInput,
  ThreadCollaborationResult,
} from "./types.ts";

export const ThreadCollaborationTool = Tool.make("thread_collaboration", {
  description:
    "Coordinate this credential-bound Solla Code chat with its side chats. Use action=set_model to change only the calling chat's model for its next turn without sending a user message; create_side_chat to fork the current conversation and immediately launch an isolated concurrent side task (Agent mode by default); list_related_chats to inspect the current chat, parent, child, and sibling states; or query_related_chat to read bounded persisted history from one listed related chat. Relationship authorization is resolved server-side: unrelated, deleted, archived, or promoted/disconnected threads cannot be accessed. Side-chat agents receive concurrency safety context and can use this same tool to inspect their parent and siblings.",
  parameters: ThreadCollaborationInput,
  success: ThreadCollaborationResult,
  failure: ThreadCollaborationError,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ProjectionSnapshotQuery,
    OrchestrationEngineService,
    ProviderRegistry,
    ThreadHistoryQuery.ThreadHistoryQuery,
    Crypto.Crypto,
  ],
})
  .annotate(Tool.Title, "Collaborate across side chats")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Meta, { "anthropic/alwaysLoad": true });

export const ThreadCollaborationToolkit = Toolkit.make(ThreadCollaborationTool);
