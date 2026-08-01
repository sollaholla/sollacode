import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadHistoryQuery from "./ThreadHistoryQuery.ts";
import { ThreadHistoryToolkit } from "./tools.ts";
import { ThreadHistoryCapabilityUnavailableError, ThreadHistoryScopeError } from "./types.ts";

const handlers = {
  thread_history_query: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      if (!invocation.capabilities.has("history")) {
        return yield* new ThreadHistoryCapabilityUnavailableError({
          threadId: invocation.threadId,
        });
      }

      const threadId = input.threadId ?? invocation.threadId;
      if (threadId !== invocation.threadId) {
        return yield* new ThreadHistoryScopeError({
          requestedThreadId: threadId,
          authorizedThreadId: invocation.threadId,
        });
      }

      const history = yield* ThreadHistoryQuery.ThreadHistoryQuery;
      return yield* history.query({
        ...input,
        threadId,
        resolvedThreadIdFromInvocation: input.threadId === undefined,
      });
    }),
} satisfies Parameters<typeof ThreadHistoryToolkit.toLayer>[0];

export const ThreadHistoryToolkitHandlersLive = ThreadHistoryToolkit.toLayer(handlers);
