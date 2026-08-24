import { VmAgentDelegationId, VmAgentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { VmAgentCollaborationStore } from "../../../persistence/Services/VmAgentCollaborations.ts";
import { VmAgentStore } from "../../../persistence/Services/VmAgents.ts";
import { type CollaborationActor, VmAgentCollaboration } from "../../../vm/VmAgentCollaboration.ts";
import { VmAgentTaskScheduler } from "../../../vm/VmAgentTaskScheduler.ts";
import { AgentCollaborationToolkit } from "./tools.ts";
import {
  AgentCollaborationCapabilityUnavailableError,
  AgentCollaborationInvalidInputError,
  AgentCollaborationNoActorError,
  AgentCollaborationOperationFailedError,
  type AgentCollaborationInput,
} from "./types.ts";

type ResolvedActor =
  | {
      readonly kind: "agent";
      readonly actor: Extract<CollaborationActor, { readonly kind: "agent" }>;
    }
  | {
      readonly kind: "worker";
      readonly actor: Extract<CollaborationActor, { readonly kind: "worker" }>;
      readonly rootVmAgentId: VmAgentId;
    };

const operationFailure = (operation: string) => (error: unknown) =>
  new AgentCollaborationOperationFailedError({
    operation,
    detail: error instanceof Error ? error.message : String(error),
  });

const requireField = <K extends keyof AgentCollaborationInput>(
  input: AgentCollaborationInput,
  field: K,
): Effect.Effect<NonNullable<AgentCollaborationInput[K]>, AgentCollaborationInvalidInputError> => {
  const value = input[field];
  if (value === undefined || (typeof value === "string" && value.trim().length === 0)) {
    return Effect.fail(
      new AgentCollaborationInvalidInputError({ action: input.action, missing: String(field) }),
    );
  }
  return Effect.succeed(value as NonNullable<AgentCollaborationInput[K]>);
};

export const handleAgentCollaboration = Effect.fn("AgentCollaboration.handle")(function* (
  input: AgentCollaborationInput,
) {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("collaboration")) {
    return yield* new AgentCollaborationCapabilityUnavailableError({
      threadId: invocation.threadId,
    });
  }
  const agents = yield* VmAgentStore;
  const store = yield* VmAgentCollaborationStore;
  const collaboration = yield* VmAgentCollaboration;
  const scheduler = yield* VmAgentTaskScheduler;
  const callingAgent = yield* agents
    .getByThreadId(invocation.threadId)
    .pipe(Effect.mapError(operationFailure("resolving the calling agent")));
  let resolved: ResolvedActor;
  if (Option.isSome(callingAgent)) {
    resolved = {
      kind: "agent",
      actor: { kind: "agent", vmAgentId: callingAgent.value.vmAgentId },
    };
  } else {
    const workerDelegation = yield* store
      .getByWorkerThreadId(invocation.threadId)
      .pipe(Effect.mapError(operationFailure("resolving the delegated worker")));
    if (Option.isNone(workerDelegation)) {
      return yield* new AgentCollaborationNoActorError({ threadId: invocation.threadId });
    }
    resolved = {
      kind: "worker",
      actor: { kind: "worker", delegationId: workerDelegation.value.delegationId },
      rootVmAgentId: workerDelegation.value.rootVmAgentId,
    };
  }

  const actorSnapshot = Effect.fn("AgentCollaboration.actorSnapshot")(function* () {
    const ownerId = resolved.kind === "agent" ? resolved.actor.vmAgentId : resolved.rootVmAgentId;
    const snapshot = yield* collaboration.snapshotForAgent(ownerId);
    if (resolved.kind === "agent") return snapshot;
    const own = snapshot.delegations.find(
      ({ delegation }) => delegation.delegationId === resolved.actor.delegationId,
    );
    if (!own) {
      return { type: "snapshot" as const, agents: [], delegations: [] };
    }
    const allowedAgentIds = new Set(
      [
        own.delegation.rootVmAgentId,
        own.delegation.sourceVmAgentId,
        own.delegation.targetVmAgentId,
      ].filter((id): id is VmAgentId => id !== null),
    );
    return {
      type: "snapshot" as const,
      agents: snapshot.agents.filter((agent) => allowedAgentIds.has(agent.vmAgentId)),
      delegations: [own],
    };
  });

  switch (input.action) {
    case "list_agents": {
      const snapshot = yield* actorSnapshot();
      return {
        action: input.action,
        status: `${snapshot.agents.length} collaborator${snapshot.agents.length === 1 ? "" : "s"} available in this scope.`,
        agents: snapshot.agents,
        hasMoreAgents: snapshot.hasMoreAgents === true,
      };
    }
    case "list_work": {
      const snapshot = yield* actorSnapshot();
      return {
        action: input.action,
        status: `${snapshot.delegations.length} delegated work item${snapshot.delegations.length === 1 ? "" : "s"} visible.`,
        work: snapshot.delegations,
        hasMoreWork: snapshot.hasMoreDelegations === true,
      };
    }
    case "delegate": {
      if (resolved.kind !== "agent") {
        return yield* new AgentCollaborationInvalidInputError({
          action: input.action,
          missing: "a root VM-agent credential (delegated workers cannot create workers)",
        });
      }
      const targetKind = yield* requireField(input, "targetKind");
      const title = yield* requireField(input, "title");
      const task = yield* requireField(input, "task");
      const idempotencyKey = yield* requireField(input, "idempotencyKey");
      const target =
        targetKind === "agent"
          ? {
              kind: "agent" as const,
              vmAgentId: yield* requireField(input, "targetVmAgentId"),
            }
          : {
              kind: "ephemeral" as const,
              ...(input.workerLabel?.trim() ? { label: input.workerLabel.trim() } : {}),
            };
      const created = yield* collaboration.delegate(resolved.actor.vmAgentId, {
        target,
        title: title.trim(),
        task: task.trim(),
        completionCriteria: input.completionCriteria,
        requestedCapabilities: input.requestedCapabilities,
        idempotencyKey: idempotencyKey.trim(),
      });
      yield* scheduler.wake();
      return {
        action: input.action,
        status: `Delegated work accepted as ${created.delegation.status}.`,
        receipt: created.receipt,
      };
    }
    case "read_work": {
      const delegationId = VmAgentDelegationId.make(yield* requireField(input, "delegationId"));
      const detail = yield* collaboration.getDetail(resolved.actor, delegationId);
      return { action: input.action, status: "Delegated work loaded.", detail };
    }
    case "send_message": {
      const delegationId = VmAgentDelegationId.make(yield* requireField(input, "delegationId"));
      const message = yield* requireField(input, "message");
      const receipt = yield* collaboration.sendMessage(resolved.actor, {
        delegationId,
        message: message.trim(),
        kind: input.kind,
        waitForReply: input.waitForReply,
      });
      yield* scheduler.wake();
      return { action: input.action, status: "Message recorded.", receipt };
    }
    case "cancel": {
      const delegationId = VmAgentDelegationId.make(yield* requireField(input, "delegationId"));
      const receipt = yield* collaboration.cancel(resolved.actor, delegationId);
      return { action: input.action, status: "Delegated work cancelled.", receipt };
    }
  }
});

const handlers = {
  agent_collaboration: handleAgentCollaboration,
} satisfies Parameters<typeof AgentCollaborationToolkit.toLayer>[0];

export const AgentCollaborationToolkitHandlersLive = AgentCollaborationToolkit.toLayer(handlers);
