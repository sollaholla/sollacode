import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { actionApprovalFingerprint } from "@t3tools/shared/actionApproval";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ActionApprovalBroker from "./ActionApprovalBroker.ts";
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

  const fingerprint = actionApprovalFingerprint(input);
  const broker = yield* ActionApprovalBroker.ActionApprovalBroker;
  const existing = yield* broker.findOpen({ threadId: invocation.threadId, fingerprint });
  if (existing !== null) {
    return {
      status: "pending" as const,
      approvalMode: "user" as const,
      requestId: existing,
      message:
        "This exact approval is already waiting for the user. Do not retry it or create another. End the turn now; in Agent mode emit AGENT_STOP.",
    };
  }

  const prompt = yield* ActionApprovalPrompt.ActionApprovalPrompt;
  const outcome = yield* prompt.request(input, {
    threadId: invocation.threadId,
    turnId: thread.value.session?.activeTurnId ?? thread.value.latestTurn?.turnId ?? null,
  });
  switch (outcome.status) {
    case "pending":
      yield* broker.rememberOpen({
        threadId: invocation.threadId,
        requestId: outcome.requestId,
        fingerprint,
      });
      return {
        status: "pending" as const,
        approvalMode: "user" as const,
        requestId: outcome.requestId,
        message:
          "The user has this approval. Do not retry it or continue the gated action. End the turn now; in Agent mode emit AGENT_STOP.",
      };
    case "unsupported":
      return { status: "approval_unavailable" as const, approvalMode: "none" as const };
  }
});

export const ActionApprovalToolkitHandlersLive = ActionApprovalToolkit.toLayer({
  request_action_approval: handleActionApproval,
});
