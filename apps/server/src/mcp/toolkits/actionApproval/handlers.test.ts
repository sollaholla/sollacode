import { expect, it, vi } from "@effect/vitest";
import {
  ApprovalRequestId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type IsoDateTime,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { handleActionApproval } from "./handlers.ts";
import * as ActionApprovalPrompt from "./prompt.ts";
import type { ActionApprovalInput } from "./types.ts";

const threadId = ThreadId.make("thread-action-approval");
const requestId = ApprovalRequestId.make("action-approval:test-request");
const createdAt = "2026-08-21T12:00:00.000Z" as IsoDateTime;
const input: ActionApprovalInput = {
  actionKind: "send_email",
  summary: "Send email to pat@example.com",
  preview: "To: pat@example.com\nSubject: Status\n\nThe work is complete.",
};
const makeThread = (interactionMode: "default" | "plan" | "agent"): OrchestrationThreadShell => ({
  id: threadId,
  projectId: ProjectId.make("project-action-approval"),
  title: "Action approval",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
  runtimeMode: "full-access",
  interactionMode,
  branch: "main",
  worktreePath: null,
  latestTurn: null,
  createdAt,
  updatedAt: createdAt,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

const invocation = (
  capabilities = new Set<McpInvocationContext.McpCapability>(["collaboration"]),
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-action-approval"),
  threadId,
  providerSessionId: "provider-session-action-approval",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities,
  issuedAt: 1,
});

const run = (
  interactionMode: "default" | "plan" | "agent",
  outcome: ActionApprovalPrompt.ActionApprovalPromptOutcome = { status: "pending", requestId },
  capabilities?: Set<McpInvocationContext.McpCapability>,
  delegated = false,
) => {
  const request = vi.fn(() => Effect.succeed(outcome));
  const getThreadShellById = vi.fn(() => Effect.succeed(Option.some(makeThread(interactionMode))));
  const effect = handleActionApproval(input).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
    Effect.provideService(
      ProjectionSnapshotQuery,
      ProjectionSnapshotQuery.of({
        getThreadShellById,
        getActiveTurnDelegation: () =>
          Effect.succeed(
            delegated
              ? Option.some({ delegationId: "delegation-action-approval" as never })
              : Option.none(),
          ),
      } as never),
    ),
    Effect.provideService(
      ActionApprovalPrompt.ActionApprovalPrompt,
      ActionApprovalPrompt.ActionApprovalPrompt.of({ request }),
    ),
  );
  return { effect, request, getThreadShellById };
};

it.effect("returns a durable pending request in normal interaction mode", () => {
  const harness = run("default");
  return Effect.gen(function* () {
    expect(yield* harness.effect).toEqual({ status: "pending", approvalMode: "user", requestId });
    expect(harness.request).toHaveBeenCalledWith(input, {
      threadId,
      turnId: null,
    });
  });
});

it.effect("auto-approves in agent mode without opening a prompt", () => {
  const harness = run("agent");
  return Effect.gen(function* () {
    expect(yield* harness.effect).toEqual({ status: "approved", approvalMode: "agent" });
    expect(harness.request).not.toHaveBeenCalled();
  });
});

it.effect("requires explicit approval for the exact delegated turn even in agent mode", () => {
  const harness = run("agent", { status: "pending", requestId }, undefined, true);
  return Effect.gen(function* () {
    expect(yield* harness.effect).toEqual({ status: "pending", approvalMode: "user", requestId });
    expect(harness.request).toHaveBeenCalledOnce();
  });
});

it.effect("does not treat an unrelated agent-mode turn as delegated", () => {
  const harness = run("agent", { status: "pending", requestId }, undefined, false);
  return Effect.gen(function* () {
    expect(yield* harness.effect).toEqual({ status: "approved", approvalMode: "agent" });
    expect(harness.request).not.toHaveBeenCalled();
  });
});

it.effect("reports unsupported elicitation without implying approval", () =>
  Effect.gen(function* () {
    expect(yield* run("default", { status: "unsupported" }).effect).toEqual({
      status: "approval_unavailable",
      approvalMode: "none",
    });
  }),
);

it.effect("rejects a credential without collaboration-bound thread access", () => {
  const harness = run("default", { status: "pending", requestId }, new Set(["history"]));
  return Effect.gen(function* () {
    const error = yield* Effect.flip(harness.effect);
    expect(error._tag).toBe("ActionApprovalCapabilityUnavailableError");
    expect(harness.getThreadShellById).not.toHaveBeenCalled();
    expect(harness.request).not.toHaveBeenCalled();
  });
});
