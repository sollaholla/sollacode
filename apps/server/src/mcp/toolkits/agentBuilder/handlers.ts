import { CommandId, VmAgentTaskId, type VmAgent } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import { VmAgentStore } from "../../../persistence/Services/VmAgents.ts";
import { createAgentThread, deleteAgentThread } from "../../../vm/agentThread.ts";
import { VmAgentTaskScheduler } from "../../../vm/VmAgentTaskScheduler.ts";
import { VmAgentWorkspace } from "../../../vm/VmAgentWorkspace.ts";
import { VmManager } from "../../../vm/VmManager.ts";
import { AgentBuilderToolkit } from "./tools.ts";
import {
  AgentBuilderCapabilityUnavailableError,
  AgentBuilderFailedError,
  AgentBuilderInvalidInputError,
  AgentBuilderUnknownAgentError,
  type AgentBuilderInput,
} from "./types.ts";

const mapFailure = (operation: string) => (error: unknown) =>
  new AgentBuilderFailedError({
    operation,
    detail: error instanceof Error ? error.message : String(error),
  });

const requireField = <K extends keyof AgentBuilderInput>(input: AgentBuilderInput, field: K) => {
  const value = input[field];
  const present =
    typeof value === "string" ? value.trim().length > 0 : value !== undefined && value !== null;
  return present
    ? Effect.succeed(value as NonNullable<AgentBuilderInput[K]>)
    : Effect.fail(new AgentBuilderInvalidInputError({ action: input.action, missing: field }));
};

export const handleAgentBuilder = Effect.fn("AgentBuilder.handle")(function* (
  input: AgentBuilderInput,
) {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("agent-builder")) {
    return yield* new AgentBuilderCapabilityUnavailableError({ threadId: invocation.threadId });
  }
  const agents = yield* VmAgentStore;
  const workspace = yield* VmAgentWorkspace;
  const scheduler = yield* VmAgentTaskScheduler;
  const manager = yield* VmManager;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;

  /**
   * Resolves the target agent from `agentId` or exact (case-insensitive) name.
   * Exact only — this is a tool call, not speech, so a typo should fail loudly
   * rather than land on whichever agent is spelled most alike.
   */
  const resolveAgent = Effect.gen(function* () {
    const reference = (input.agentId ?? input.agentName ?? "").trim();
    if (reference.length === 0) {
      return yield* new AgentBuilderInvalidInputError({
        action: input.action,
        missing: "agentName",
      });
    }
    const all = yield* agents.list().pipe(Effect.mapError(mapFailure("listing agents")));
    const match = all.find(
      (agent) =>
        agent.vmAgentId === reference || agent.name.toLowerCase() === reference.toLowerCase(),
    );
    if (match === undefined) {
      return yield* new AgentBuilderUnknownAgentError({ reference });
    }
    return match;
  });

  /** Applies chat-level configuration to an agent's dedicated thread. */
  const configureChat = (agent: VmAgent) =>
    Effect.gen(function* () {
      if (agent.threadId === null) {
        return yield* new AgentBuilderFailedError({
          operation: "configuring the agent chat",
          detail: "This agent has no dedicated chat thread.",
        });
      }
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      if (input.modelSelection !== undefined) {
        yield* engine
          .dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make(NodeCrypto.randomUUID()),
            threadId: agent.threadId,
            modelSelection: input.modelSelection,
          })
          .pipe(Effect.mapError(mapFailure("setting the chat model")));
      }
      if (input.runtimeMode !== undefined) {
        yield* engine
          .dispatch({
            type: "thread.runtime-mode.set",
            commandId: CommandId.make(NodeCrypto.randomUUID()),
            threadId: agent.threadId,
            runtimeMode: input.runtimeMode,
            createdAt,
          })
          .pipe(Effect.mapError(mapFailure("setting the chat access mode")));
      }
      if (input.interactionMode !== undefined) {
        yield* engine
          .dispatch({
            type: "thread.interaction-mode.set",
            commandId: CommandId.make(NodeCrypto.randomUUID()),
            threadId: agent.threadId,
            interactionMode: input.interactionMode,
            createdAt,
          })
          .pipe(Effect.mapError(mapFailure("setting the chat interaction mode")));
      }
    });

  switch (input.action) {
    case "list_agents": {
      const all = yield* agents.list().pipe(Effect.mapError(mapFailure("listing agents")));
      return {
        action: input.action,
        status: all.length === 0 ? "No agents exist yet." : `${all.length} agent(s).`,
        agents: all,
      };
    }
    case "get_agent": {
      const agent = yield* resolveAgent;
      const snapshot = yield* workspace
        .snapshot(agent.vmAgentId)
        .pipe(Effect.mapError(mapFailure("loading the workspace")));
      return { action: input.action, status: "Agent loaded.", agent, workspace: snapshot };
    }
    case "create_agent": {
      const name = (yield* requireField(input, "name")) as string;
      const purpose = (yield* requireField(input, "purpose")) as string;
      const threadId = yield* createAgentThread(name).pipe(
        Effect.mapError(mapFailure("creating the agent chat")),
      );
      const agent = yield* manager
        .create({ name: name.trim(), purpose: purpose.trim(), icon: input.icon ?? null, threadId })
        .pipe(Effect.mapError(mapFailure("creating the agent")));
      yield* workspace.ensure(agent.vmAgentId).pipe(Effect.ignoreCause({ log: true }));
      if (input.modelSelection !== undefined || input.runtimeMode !== undefined) {
        yield* configureChat(agent);
      }
      return {
        action: input.action,
        status: `Agent "${agent.name}" created and ready. Mention it anywhere as @${agent.handle}.`,
        agent,
      };
    }
    case "configure_agent_chat": {
      const agent = yield* resolveAgent;
      if (
        input.modelSelection === undefined &&
        input.runtimeMode === undefined &&
        input.interactionMode === undefined
      ) {
        return yield* new AgentBuilderInvalidInputError({
          action: input.action,
          missing: "modelSelection",
        });
      }
      yield* configureChat(agent);
      return { action: input.action, status: "Agent chat configured.", agent };
    }
    case "create_task": {
      const agent = yield* resolveAgent;
      const title = (yield* requireField(input, "title")) as string;
      const prompt = (yield* requireField(input, "prompt")) as string;
      // The builder chat is the user configuring their own agent, so the task
      // is created the way the workspace UI creates one: active and approved.
      // The agent_workspace tool's draft-and-approve discipline exists for an
      // agent scheduling work for *itself*, which this is not.
      const task = yield* workspace
        .createTask({
          vmAgentId: agent.vmAgentId,
          title,
          prompt,
          completionCriteria: input.completionCriteria ?? [],
          schedule: input.schedule ?? null,
          notificationPolicy: input.notificationPolicy ?? "always",
          createdBy: "user",
          activate: true,
        })
        .pipe(Effect.mapError(mapFailure("creating the task")));
      yield* scheduler.wake();
      return { action: input.action, status: "Task created.", task };
    }
    case "update_task": {
      const agent = yield* resolveAgent;
      const taskId = VmAgentTaskId.make((yield* requireField(input, "taskId")) as string);
      const task = yield* workspace
        .updateTask({
          vmAgentId: agent.vmAgentId,
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
          ...(input.taskStatus !== undefined ? { status: input.taskStatus } : {}),
        })
        .pipe(Effect.mapError(mapFailure("updating the task")));
      yield* scheduler.wake();
      return { action: input.action, status: "Task updated.", task };
    }
    case "delete_task": {
      const agent = yield* resolveAgent;
      const taskId = VmAgentTaskId.make((yield* requireField(input, "taskId")) as string);
      yield* workspace
        .deleteTask(agent.vmAgentId, taskId)
        .pipe(Effect.mapError(mapFailure("deleting the task")));
      return { action: input.action, status: "Task deleted." };
    }
    case "run_task_now": {
      const agent = yield* resolveAgent;
      const taskId = VmAgentTaskId.make((yield* requireField(input, "taskId")) as string);
      const task = yield* workspace
        .runTaskNow(agent.vmAgentId, taskId)
        .pipe(Effect.mapError(mapFailure("queueing the task")));
      yield* scheduler.wake();
      return { action: input.action, status: "Task queued to run now.", task };
    }
    case "set_notification_preferences": {
      const agent = yield* resolveAgent;
      const snapshot = yield* workspace
        .snapshot(agent.vmAgentId)
        .pipe(Effect.mapError(mapFailure("reading notification preferences")));
      const current = snapshot.notificationPreferences;
      yield* workspace
        .updateNotificationPreferences({
          vmAgentId: agent.vmAgentId,
          enabled: input.notificationsEnabled ?? current.enabled,
          taskCompletions: input.notifyTaskCompletions ?? current.taskCompletions,
          taskFailures: input.notifyTaskFailures ?? current.taskFailures,
          agentMessages: input.notifyAgentMessages ?? current.agentMessages,
        })
        .pipe(Effect.mapError(mapFailure("updating notification preferences")));
      return { action: input.action, status: "Notification preferences updated." };
    }
    case "define_artifact": {
      const agent = yield* resolveAgent;
      const title = (yield* requireField(input, "title")) as string;
      if (input.artifactDefinition === undefined) {
        return yield* new AgentBuilderInvalidInputError({
          action: input.action,
          missing: "artifactDefinition",
        });
      }
      const artifact = yield* workspace
        .upsertArtifact({
          vmAgentId: agent.vmAgentId,
          title,
          definition: input.artifactDefinition,
        })
        .pipe(Effect.mapError(mapFailure("defining the artifact")));
      return { action: input.action, status: "Artifact defined.", artifact };
    }
    case "start_agent": {
      const agent = yield* resolveAgent;
      const started = yield* manager
        .setStatus(agent.vmAgentId, "running")
        .pipe(Effect.mapError(mapFailure("starting the agent")));
      yield* scheduler.wake();
      return {
        action: input.action,
        status: `Agent "${agent.name}" started. Scheduled tasks resume.`,
        agent: started,
      };
    }
    case "stop_agent": {
      const agent = yield* resolveAgent;
      const stopped = yield* manager
        .setStatus(agent.vmAgentId, "stopped")
        .pipe(Effect.mapError(mapFailure("stopping the agent")));
      yield* scheduler.interruptAgent(agent.vmAgentId);
      return {
        action: input.action,
        status: `Agent "${agent.name}" stopped. Its running turn was interrupted and scheduled tasks are ignored until it is started again.`,
        agent: stopped,
      };
    }
    case "delete_agent": {
      const agent = yield* resolveAgent;
      // The same discipline as the UI's delete dialog: destroying a computer,
      // its schedule and its history requires naming the victim exactly.
      if ((input.confirmName ?? "").trim() !== agent.name) {
        return yield* new AgentBuilderInvalidInputError({
          action: input.action,
          missing: "confirmName (must equal the agent's name exactly)",
        });
      }
      const threadId = yield* manager
        .deleteAgent(agent.vmAgentId)
        .pipe(Effect.mapError(mapFailure("deleting the agent")));
      if (threadId !== null) {
        yield* deleteAgentThread(threadId).pipe(Effect.ignoreCause({ log: true }));
      }
      return { action: input.action, status: `Agent "${agent.name}" deleted.` };
    }
  }
});

const handlers = {
  agent_builder: handleAgentBuilder,
} satisfies Parameters<typeof AgentBuilderToolkit.toLayer>[0];

export const AgentBuilderToolkitHandlersLive = AgentBuilderToolkit.toLayer(handlers);
