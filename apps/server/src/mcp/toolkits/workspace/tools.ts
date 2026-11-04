import * as Crypto from "effect/Crypto";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { TerminalManager } from "../../../terminal/Manager.ts";
import { AgentCalls } from "../../../vm/AgentCalls.ts";
import {
  WorkspaceOrchestrationError,
  WorkspaceOrchestrationInput,
  WorkspaceOrchestrationResult,
} from "./types.ts";

/**
 * Workspace-wide reads for every chat, and writes for the orchestrator thread.
 *
 * The existing `thread_collaboration` toolkit deliberately scopes a caller to
 * its own side-chat family. Any chat may look across every thread and terminal
 * here (list_threads, describe_thread, list_terminals, read_terminal), so it can
 * find a chat or agent to message with `workspace_consult`. Acting on another
 * thread (send_to_thread, interrupt_thread, write_to_terminal) is the
 * orchestrator's job alone, gated on the reserved thread id rather than on a
 * capability any thread could be granted.
 */
export const WorkspaceOrchestrationTool = Tool.make("workspace_orchestration", {
  description:
    "Inspect every thread in this Solla Code workspace; the orchestrator thread can also act on them. Any chat may use the read actions: list_threads to see all threads except the caller's own, with their status, what each is blocked on, and which terminals they have open. Match a project a person names against projectTitle, not the thread title; side chats need includeSideChats. isWorking matches the sidebar's Working: a turn in flight, scheduled pendingWork, or backgroundTaskCount tasks still running after the turn. describe_thread for one thread's detail; list_terminals to see every live terminal; read_terminal to read a terminal's current output. Orchestrator thread only: write_to_terminal to type into a live terminal; send_to_thread to write a message into any thread exactly as if the user typed it; interrupt_thread to stop an in-flight turn; call_user to ring the person for a live voice call with you (give a one-sentence callReason), when something needs their attention or decision, or an update is worth saying out loud. A call says what they hear; for anything else, write in this chat. Other chats message a thread or agent with workspace_consult ask (waitMs 0 just sends).",
  parameters: WorkspaceOrchestrationInput,
  success: WorkspaceOrchestrationResult,
  failure: WorkspaceOrchestrationError,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ProjectionSnapshotQuery,
    OrchestrationEngineService,
    Crypto.Crypto,
    TerminalManager,
    AgentCalls,
  ],
})
  .annotate(Tool.Title, "Inspect or orchestrate the workspace")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Meta, { "anthropic/alwaysLoad": true });

export const WorkspaceOrchestrationToolkit = Toolkit.make(WorkspaceOrchestrationTool);
