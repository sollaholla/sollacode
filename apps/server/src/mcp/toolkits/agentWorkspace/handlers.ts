// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import {
  isOrchestratorThreadId,
  VmAgentBlockerId,
  VmAgentTaskId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { VmAgentStore } from "../../../persistence/Services/VmAgents.ts";
import { AgentCalls, type AgentCallRingOutcome } from "../../../vm/AgentCalls.ts";
import { resolveOwningVmAgent } from "../../../vm/owningAgent.ts";
import { VmAgentWorkspace } from "../../../vm/VmAgentWorkspace.ts";
import { VmAgentTaskScheduler } from "../../../vm/VmAgentTaskScheduler.ts";
import { VmManager } from "../../../vm/VmManager.ts";
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

/**
 * What call_user tells the agent; it decides its next step from this. An
 * answered call always talks in the agent's main chat (AgentCallLive pins the
 * session there), so a side chat or delegated worker hears nothing back.
 */
const CALL_USER_STATUS: Record<AgentCallRingOutcome["status"], string> = {
  ringing:
    "ringing — if the user answers, the call's conversation arrives in this chat, the agent's main chat, as messages. End your turn so you can reply to them.",
  disabled: "calls are turned off",
  "already-ringing": "already ringing",
  busy: "already on a call with the user",
  duplicate: "already ringing",
  cooldown: "rate-limited — use report_blocker instead",
  "rate-limited": "rate-limited — use report_blocker instead",
};
const CALL_USER_RINGING_ELSEWHERE =
  "ringing — if the user answers, the call's conversation goes into this agent's main chat, not this one; the main chat replies to them. End your turn.";

/**
 * Whether the caller's current turn was started by another chat: delegated
 * work, or a message another chat sent. Such a turn cannot approve work for the
 * person, so the tasks it adds or changes wait for them — the rule
 * request_action_approval applies. The orchestrator speaks for the person.
 * Fails closed: an unreadable trigger counts as another chat.
 */
const turnStartedByAnotherChat = (projection: ProjectionSnapshotQueryShape, threadId: ThreadId) =>
  projection.getTurnTrigger === undefined
    ? Effect.succeed(true)
    : projection.getTurnTrigger(threadId).pipe(
        Effect.map(
          Option.match({
            onNone: () => false,
            onSome: ({ senderThreadId, delegationId }) =>
              delegationId !== null ||
              (senderThreadId !== null && !isOrchestratorThreadId(senderThreadId)),
          }),
        ),
        Effect.orElseSucceed(() => true),
      );

const ANOTHER_CHAT_APPROVAL =
  "waiting for user approval: another chat started this turn, so the person approves the work it adds or changes.";

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
  const projection = yield* ProjectionSnapshotQuery;
  const workspace = yield* VmAgentWorkspace;
  const scheduler = yield* VmAgentTaskScheduler;
  // An agent's side chats and its delegated workers (side chats of its chat)
  // act as the agent, so the lookup walks the side-chat chain.
  const agent = yield* resolveOwningVmAgent({
    threadId: invocation.threadId,
    getAgentByThreadId: agents.getByThreadId,
    getThreadShellById: projection.getThreadShellById,
  }).pipe(Effect.mapError(mapFailure("resolving this agent")));
  if (Option.isNone(agent)) {
    return yield* new AgentWorkspaceNoAgentError({ threadId: invocation.threadId });
  }
  const vmAgentId = agent.value.vmAgentId;

  switch (input.action) {
    case "set_icon": {
      if (input.icon === undefined) {
        return yield* new AgentWorkspaceInvalidInputError({
          action: input.action,
          missing: "icon",
        });
      }
      const manager = yield* VmManager;
      yield* manager
        .setIcon(vmAgentId, input.icon)
        .pipe(Effect.mapError(mapFailure("setting the agent icon")));
      return { action: input.action, status: `Icon set to "${input.icon}".` };
    }
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
      const fromAnotherChat = yield* turnStartedByAnotherChat(projection, invocation.threadId);
      const created = yield* workspace
        .createTask({
          vmAgentId,
          title,
          prompt,
          completionCriteria: input.completionCriteria ?? [],
          schedule: input.schedule ?? null,
          notificationPolicy: input.notificationPolicy ?? "always",
          createdBy: "agent",
          activate: input.action === "create_task" && !fromAnotherChat,
          // A draft is never scheduled, even while createTask still applies the
          // main chat's auto-approval; the update below withdraws that approval.
          ...(fromAnotherChat ? { status: "draft" as const } : {}),
        })
        .pipe(Effect.mapError(mapFailure("creating a task")));
      const task =
        fromAnotherChat && created.approvalState !== "pending"
          ? yield* workspace
              .updateTask({
                vmAgentId,
                taskId: created.taskId,
                status: "draft",
                approvalState: "pending",
              })
              .pipe(Effect.mapError(mapFailure("creating a task")))
          : created;
      yield* scheduler.wake();
      return {
        action: input.action,
        status:
          task.approvalState === "pending"
            ? fromAnotherChat
              ? `Task saved as a draft and is ${ANOTHER_CHAT_APPROVAL}`
              : "Task saved as a draft and is waiting for user approval."
            : agent.value.status !== "running"
              ? "Task saved, but this agent is stopped. It will not run until the agent is started; do not report it as scheduled to execute."
              : task.schedule?.kind === "interval"
                ? "Task created and activated (auto-approved: the agent's main chat runs in Agent mode)."
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
      // Changing what a task does or when it runs is new work.
      const changesWork =
        input.title !== undefined ||
        input.prompt !== undefined ||
        input.completionCriteria !== undefined ||
        input.schedule !== undefined;
      const fromAnotherChat =
        recurring || changesWork
          ? yield* turnStartedByAnotherChat(projection, invocation.threadId)
          : false;
      const needsApproval = recurring || (fromAnotherChat && changesWork);
      const autoApproved =
        needsApproval && !fromAnotherChat
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
          ...(needsApproval
            ? autoApproved
              ? { status: "active" as const, approvalState: "approved" as const }
              : { status: "draft" as const, approvalState: "pending" as const }
            : {}),
        })
        .pipe(Effect.mapError(mapFailure("updating the task")));
      yield* scheduler.wake();
      return {
        action: input.action,
        status:
          task.approvalState !== "pending" && agent.value.status !== "running"
            ? "Task updated, but this agent is stopped. It will not run until the agent is started; do not report it as scheduled to execute."
            : !needsApproval
              ? "Task updated."
              : autoApproved
                ? "Recurring task updated and active (auto-approved: the agent's main chat runs in Agent mode)."
                : fromAnotherChat
                  ? `Task update saved and is ${ANOTHER_CHAT_APPROVAL}`
                  : "Recurring task update saved and is waiting for user approval.",
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
    case "call_user": {
      const calls = yield* AgentCalls;
      const outcome = yield* calls.ring({
        vmAgentId,
        reason: "request",
        topic: input.callReason?.trim() || null,
        key: `request:${invocation.threadId}:${NodeCrypto.randomUUID()}`,
      });
      return {
        action: input.action,
        status:
          outcome.status === "ringing" && agent.value.threadId !== invocation.threadId
            ? CALL_USER_RINGING_ELSEWHERE
            : CALL_USER_STATUS[outcome.status],
      };
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
