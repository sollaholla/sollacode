import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ActionApprovalPrompt from "./prompt.ts";
import { ActionApprovalToolkit } from "./tools.ts";
import {
  ActionApprovalCapabilityUnavailableError,
  ActionApprovalOperationFailedError,
  ActionApprovalThreadNotFoundError,
} from "./types.ts";

export const handleActionApproval = Effect.fn("ActionApproval.handle")(function* (
  input: import("./types.ts").ActionApprovalInput,
) {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("collaboration")) {
    return yield* new ActionApprovalCapabilityUnavailableError({
      threadId: invocation.threadId,
    });
  }

  const projection = yield* ProjectionSnapshotQuery;
  const thread = yield* projection.getThreadShellById(invocation.threadId).pipe(
    Effect.mapError(
      () =>
        new ActionApprovalOperationFailedError({
          threadId: invocation.threadId,
        }),
    ),
  );
  if (Option.isNone(thread)) {
    return yield* new ActionApprovalThreadNotFoundError({
      threadId: invocation.threadId,
    });
  }

  const getActiveTurnDelegation = projection.getActiveTurnDelegation;
  if (getActiveTurnDelegation === undefined) {
    return yield* new ActionApprovalOperationFailedError({
      threadId: invocation.threadId,
    });
  }
  const activeDelegation = yield* getActiveTurnDelegation(invocation.threadId).pipe(
    Effect.mapError(
      () =>
        new ActionApprovalOperationFailedError({
          threadId: invocation.threadId,
        }),
    ),
  );

  if (thread.value.interactionMode === "agent" && Option.isNone(activeDelegation)) {
    return {
      status: "approved" as const,
      approvalMode: "agent" as const,
    };
  }

  const prompt = yield* ActionApprovalPrompt.ActionApprovalPrompt;
  const outcome = yield* prompt.request(input, {
    threadId: invocation.threadId,
    turnId: thread.value.session?.activeTurnId ?? thread.value.latestTurn?.turnId ?? null,
  });
  switch (outcome.status) {
    case "approved":
      return { status: "approved" as const, approvalMode: "user" as const };
    case "changes_requested":
      return {
        status: "changes_requested" as const,
        approvalMode: "user" as const,
        feedback: outcome.feedback,
      };
    case "cancelled":
      return { status: "cancelled" as const, approvalMode: "none" as const };
    case "unsupported":
      return { status: "approval_unavailable" as const, approvalMode: "none" as const };
  }
});

export const ActionApprovalToolkitHandlersLive = ActionApprovalToolkit.toLayer({
  request_action_approval: handleActionApproval,
});
