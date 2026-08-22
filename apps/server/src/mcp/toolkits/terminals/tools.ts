import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { TerminalManager } from "../../../terminal/Manager.ts";
import { ThreadTerminalsError, ThreadTerminalsInput, ThreadTerminalsResult } from "./types.ts";

export const ThreadTerminalsTool = Tool.make("thread_terminals", {
  description:
    "Inspect and type into terminals currently open in this Solla Code environment, the same way thread_collaboration inspects related chats. action=list_terminals is the usual first and only call: it returns every live pane with the owning thread's title, whether the pane is on this chat's thread (belongsToThisChat), the running-command label, and a preview of what is on screen. A Grok or Claude CLI in this thread's terminal pane is a separate process — not this chat agent. Omit threadId on list to see the whole environment. Use read_terminal only when you need a longer tail than the preview; write_to_terminal types into a live pane as if the user had typed there.",
  parameters: ThreadTerminalsInput,
  success: ThreadTerminalsResult,
  failure: ThreadTerminalsError,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    TerminalManager,
    ProjectionSnapshotQuery,
  ],
})
  .annotate(Tool.Title, "Use open terminals")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Meta, { "anthropic/alwaysLoad": true });

export const ThreadTerminalsToolkit = Toolkit.make(ThreadTerminalsTool);
