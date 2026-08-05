import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadHistoryQuery from "./ThreadHistoryQuery.ts";
import { ThreadHistoryError, ThreadHistoryQueryInput, ThreadHistoryQueryResult } from "./types.ts";

export const ThreadHistoryQueryTool = Tool.make("thread_history_query", {
  description:
    "Search and page through persisted history for this Solla Code thread, including user/assistant messages and activity/tool summaries. Omit threadId to resolve the calling agent's thread automatically; an explicit threadId must match the credential-bound thread. Supports literal or bounded regex matching, source/role/kind/turn/time filters, stable opaque cursors, payload controls, and a resumeContext containing the latest user request, completed assistant output, activity, and active turn.",
  parameters: ThreadHistoryQueryInput,
  success: ThreadHistoryQueryResult,
  failure: ThreadHistoryError,
  dependencies: [McpInvocationContext.McpInvocationContext, ThreadHistoryQuery.ThreadHistoryQuery],
})
  .annotate(Tool.Title, "Query thread history")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Meta, { "anthropic/alwaysLoad": true });

export const ThreadHistoryToolkit = Toolkit.make(ThreadHistoryQueryTool);
