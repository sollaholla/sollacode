import { VmAgentBlockerId, VmAgentTaskId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { VmAgentStore } from "../../../persistence/Services/VmAgents.ts";
import { VmAgentWorkspace } from "../../../vm/VmAgentWorkspace.ts";
import { VmAgentTaskScheduler } from "../../../vm/VmAgentTaskScheduler.ts";
import { AgentWorkspaceToolkit } from "./tools.ts";
import {
  AgentWorkspaceCapabilityUnavailableError,
  AgentWorkspaceFailedError,
  AgentWorkspaceInvalidInputError,
  AgentWorkspaceNoAgentError,
  type AgentWorkspaceInput,
} from "./types.ts";

const requireString = (
  input: AgentWorkspaceInput,
  field: "taskId" | "title" | "prompt" | "notificationBody" | "blockerDetail" | "blockerId",
) => {
  const value = input[field];
  return typeof value === "string" && value.trim().length > 0
    ? Effect.succeed(value.trim())
    : Effect.fail(new AgentWorkspaceInvalidInputError({ action: input.action, missing: field }));
};

const mapFailure = (operation: string) => (error: unknown) =>
  new AgentWorkspaceFailedError({
    operation,
    detail: error instanceof Error ? error.message : String(error),
  });

export const handleAgentWorkspace = Effect.fn("AgentWorkspace.handle")(function* (
  input: AgentWorkspaceInput,
) {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("vm")) {
    return yield* new AgentWorkspaceCapabilityUnavailableError({ threadId: invocation.threadId });
  }
  const agents = yield* VmAgentStore;
  const workspace = yield* VmAgentWorkspace;
  const scheduler = yield* VmAgentTaskScheduler;
  const agent = yield* agents
    .getByThreadId(invocation.threadId)
    .pipe(Effect.mapError(mapFailure("resolving this agent")));
  if (Option.isNone(agent)) {
    return yield* new AgentWorkspaceNoAgentError({ threadId: invocation.threadId });
  }
  const vmAgentId = agent.value.vmAgentId;

  switch (input.action) {
    case "list_tasks": {
      const snapshot = yield* workspace
        .snapshot(vmAgentId)
        .pipe(Effect.mapError(mapFailure("listing tasks")));
      return { action: input.action, status: "Workspace loaded.", workspace: snapshot };
    }
    case "propose_task":
    case "create_task": {
      const title = yield* requireString(input, "title");
      const prompt = yield* requireString(input, "prompt");
      const task = yield* workspace
        .createTask({
          vmAgentId,
          title,
          prompt,
          completionCriteria: input.completionCriteria ?? [],
          schedule: input.schedule ?? null,
          notificationPolicy: input.notificationPolicy ?? "always",
          createdBy: "agent",
          activate: input.action === "create_task",
        })
        .pipe(Effect.mapError(mapFailure("creating a task")));
      yield* scheduler.wake();
      return {
        action: input.action,
        status:
          task.approvalState === "pending"
            ? "Task saved as a draft and is waiting for user approval."
            : task.schedule?.kind === "interval"
              ? "Task created and activated (auto-approved: this chat runs in Agent mode)."
              : "Task created and queued when due.",
        task,
      };
    }
    case "update_task": {
      const taskId = VmAgentTaskId.make(yield* requireString(input, "taskId"));
      const snapshot = yield* workspace
        .snapshot(vmAgentId)
        .pipe(Effect.mapError(mapFailure("checking the task approval boundary")));
      const current = snapshot.tasks.find((task) => task.taskId === taskId);
      const recurring =
        input.schedule === undefined
          ? current?.schedule?.kind === "interval"
          : input.schedule?.kind === "interval";
      const autoApproved = recurring
        ? yield* workspace
            .autoApprovesTasks(vmAgentId)
            .pipe(Effect.mapError(mapFailure("checking the task approval boundary")))
        : false;
      const task = yield* workspace
        .updateTask({
          vmAgentId,
          taskId,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
          ...(input.completionCriteria !== undefined
            ? { completionCriteria: input.completionCriteria }
            : {}),
          ...(input.schedule !== undefined ? { schedule: input.schedule } : {}),
          ...(input.notificationPolicy !== undefined
            ? { notificationPolicy: input.notificationPolicy }
            : {}),
          ...(recurring
            ? autoApproved
              ? { status: "active" as const, approvalState: "approved" as const }
              : { status: "draft" as const, approvalState: "pending" as const }
            : {}),
        })
        .pipe(Effect.mapError(mapFailure("updating the task")));
      yield* scheduler.wake();
      return {
        action: input.action,
        status: recurring
          ? autoApproved
            ? "Recurring task updated and active (auto-approved: this chat runs in Agent mode)."
            : "Recurring task update saved and is waiting for user approval."
          : "Task updated.",
        task,
      };
    }
    case "complete_task": {
      const taskId = VmAgentTaskId.make(yield* requireString(input, "taskId"));
      const task = yield* workspace
        .updateTask({ vmAgentId, taskId, status: "completed" })
        .pipe(Effect.mapError(mapFailure("completing the task")));
      return { action: input.action, status: "Task marked complete.", task };
    }
    case "notify_user": {
      const title = yield* requireString(input, "title");
      const body = yield* requireString(input, "notificationBody");
      const delivered = yield* workspace
        .notify({ vmAgentId, kind: "agent-message", title, body })
        .pipe(Effect.mapError(mapFailure("notifying the user")));
      return {
        action: input.action,
        status: delivered
          ? "Notification sent."
          : "Notification preferences are disabled; no notification was delivered.",
      };
    }
    case "report_blocker": {
      const title = yield* requireString(input, "title");
      const detail = yield* requireString(input, "blockerDetail");
      const blocker = yield* workspace
        .raiseBlocker({ vmAgentId, title, detail, url: input.blockerUrl ?? null })
        .pipe(Effect.mapError(mapFailure("reporting a blocker")));
      return {
        action: input.action,
        status:
          "Blocker recorded as the standing alert the user sees until it is resolved. No separate notification is needed: do not call notify_user for this request. Re-reporting the same title refreshes it; call resolve_blocker when it no longer blocks you.",
        blocker,
      };
    }
    case "resolve_blocker": {
      const blockerId = VmAgentBlockerId.make(yield* requireString(input, "blockerId"));
      const resolved = yield* workspace
        .resolveBlocker({ vmAgentId, blockerId, resolvedBy: "agent" })
        .pipe(Effect.mapError(mapFailure("resolving a blocker")));
      if (Option.isNone(resolved)) {
        return {
          action: input.action,
          status: "No open blocker with that id — it may already be resolved.",
        };
      }
      return { action: input.action, status: "Blocker resolved.", blocker: resolved.value };
    }
    case "define_artifact":
    case "update_artifact": {
      const title = yield* requireString(input, "title");
      if (input.artifactDefinition === undefined) {
        return yield* new AgentWorkspaceInvalidInputError({
          action: input.action,
          missing: "artifactDefinition",
        });
      }
      const artifact = yield* workspace
        .upsertArtifact({ vmAgentId, title, definition: input.artifactDefinition })
        .pipe(Effect.mapError(mapFailure("updating the artifact")));
      return { action: input.action, status: "Artifact updated.", artifact };
    }
  }
});

const handlers = {
  agent_workspace: handleAgentWorkspace,
} satisfies Parameters<typeof AgentWorkspaceToolkit.toLayer>[0];

export const AgentWorkspaceToolkitHandlersLive = AgentWorkspaceToolkit.toLayer(handlers);
