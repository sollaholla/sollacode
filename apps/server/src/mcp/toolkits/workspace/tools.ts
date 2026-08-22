import * as Crypto from "effect/Crypto";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { TerminalManager } from "../../../terminal/Manager.ts";
import {
  WorkspaceOrchestrationError,
  WorkspaceOrchestrationInput,
  WorkspaceOrchestrationResult,
} from "./types.ts";

/**
 * Workspace-wide read/write, available only to the orchestrator thread.
 *
 * The existing `thread_collaboration` toolkit deliberately scopes a caller to
 * its own side-chat family, which is right for ordinary agents but leaves them
 * unable to see anything else. The orchestrator's entire job is the opposite —
 * it is the one agent that is supposed to see and act across every thread — so
 * it gets its own toolkit, gated on the reserved thread id rather than on a
 * capability any thread could be granted.
 */
export const WorkspaceOrchestrationTool = Tool.make("workspace_orchestration", {
  description:
    "Inspect and act on every thread in this Solla Code workspace. Use action=list_threads to see all threads with their status, what each is blocked on, and which terminals they have open; describe_thread for one thread's detail; list_terminals to see every live terminal; read_terminal to read a terminal's current output; write_to_terminal to type into a live terminal; send_to_thread to write a message into any thread exactly as if the user typed it; interrupt_thread to stop an in-flight turn. Only the orchestrator thread may call this.",
  parameters: WorkspaceOrchestrationInput,
  success: WorkspaceOrchestrationResult,
  failure: WorkspaceOrchestrationError,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ProjectionSnapshotQuery,
    OrchestrationEngineService,
    Crypto.Crypto,
    TerminalManager,
  ],
})
  .annotate(Tool.Title, "Orchestrate the workspace")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Meta, { "anthropic/alwaysLoad": true });

export const WorkspaceOrchestrationToolkit = Toolkit.make(WorkspaceOrchestrationTool);
