import {
  CommandId,
  DEFAULT_VM_AGENT_DELEGATION_LIMITS,
  type VmAgent,
  type VmAgentCollaborationAgentSummary,
  type VmAgentCollaborationError,
  VmAgentCollaborationOperationError,
  type VmAgentCollaborationReceipt,
  type VmAgentCollaborationSnapshot,
  type VmAgentDelegation,
  type VmAgentDelegationDetail,
  VmAgentDelegationId,
  VmAgentDelegationInvalidStateError,
  VmAgentDelegationLimitError,
  VmAgentDelegationMessageId,
  VmAgentDelegationNotFoundError,
  VmAgentDelegationScopeError,
  type VmAgentDelegationSummary,
  type VmAgentId,
  type VmAgentIdentitySnapshot,
  VmAgentNotFoundError,
  VmAgentTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { VmAgentCollaborationStore } from "../persistence/Services/VmAgentCollaborations.ts";
import { VmAgentStore } from "../persistence/Services/VmAgents.ts";

type CollaborationListener = (snapshot: VmAgentCollaborationSnapshot) => Effect.Effect<void>;
export type CollaborationActor =
  | { readonly kind: "user" }
  | { readonly kind: "agent"; readonly vmAgentId: VmAgentId }
  | { readonly kind: "worker"; readonly delegationId: VmAgentDelegationId };

export interface DelegateVmAgentWorkInput {
  readonly target: VmAgentDelegation["target"];
  readonly title: string;
  readonly task: string;
  readonly completionCriteria?: ReadonlyArray<string> | undefined;
  readonly requestedCapabilities?: ReadonlyArray<string> | undefined;
  readonly idempotencyKey: string;
}

export interface SendVmAgentCollaborationMessageInput {
  readonly delegationId: VmAgentDelegationId;
  readonly message: string;
  readonly kind?: "note" | "question" | "answer" | undefined;
  readonly waitForReply?: boolean | undefined;
}

export interface VmAgentCollaborationShape {
  readonly snapshot: () => Effect.Effect<VmAgentCollaborationSnapshot, VmAgentCollaborationError>;
  readonly snapshotForAgent: (
    vmAgentId: VmAgentId,
  ) => Effect.Effect<VmAgentCollaborationSnapshot, VmAgentCollaborationError>;
  readonly subscribe: (
    listener: CollaborationListener,
  ) => Effect.Effect<() => void, VmAgentCollaborationError>;
  readonly getDetail: (
    actor: CollaborationActor,
    delegationId: VmAgentDelegationId,
  ) => Effect.Effect<VmAgentDelegationDetail, VmAgentCollaborationError>;
  readonly delegate: (
    sourceVmAgentId: VmAgentId,
    input: DelegateVmAgentWorkInput,
  ) => Effect.Effect<
    {
      readonly receipt: VmAgentCollaborationReceipt;
      readonly delegation: VmAgentDelegation;
    },
    VmAgentCollaborationError
  >;
  readonly sendMessage: (
    actor: CollaborationActor,
    input: SendVmAgentCollaborationMessageInput,
  ) => Effect.Effect<VmAgentCollaborationReceipt, VmAgentCollaborationError>;
  readonly cancel: (
    actor: CollaborationActor,
    delegationId: VmAgentDelegationId,
  ) => Effect.Effect<VmAgentCollaborationReceipt, VmAgentCollaborationError>;
  readonly activeDelegationForThread: (
    threadId: string,
  ) => Effect.Effect<Option.Option<VmAgentDelegation>, VmAgentCollaborationError>;
  readonly refresh: Effect.Effect<void>;
}

export class VmAgentCollaboration extends Context.Service<
  VmAgentCollaboration,
  VmAgentCollaborationShape
>()("t3/vm/VmAgentCollaboration") {}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const activeStatuses = new Set(["pending-approval", "queued", "running", "waiting-input"]);

const operationError = (operation: string) => (error: unknown) =>
  new VmAgentCollaborationOperationError({
    operation,
    detail: error instanceof Error ? error.message : String(error),
  });

const identitySnapshot = (agent: VmAgent): VmAgentIdentitySnapshot => ({
  vmAgentId: agent.vmAgentId,
  name: agent.name,
  handle: agent.handle,
  purpose: agent.purpose,
});

const agentAvailability = (
  agent: VmAgent,
  activeDelegations: number,
  runningDelegations = activeDelegations,
  modelSelection?: { readonly instanceId: string; readonly model: string } | null,
): VmAgentCollaborationAgentSummary => {
  // Agents have no bootable VM and no user-takeover any more: one is simply
  // busy while a delegated run is in flight, and available otherwise.
  const availability = runningDelegations > 0 ? ("busy" as const) : ("available" as const);
  return {
    vmAgentId: agent.vmAgentId,
    name: agent.name,
    handle: agent.handle,
    purpose: agent.purpose,
    status: agent.status,
    controlMode: agent.controlMode,
    availability,
    capabilities: [
      "workspace.tasks",
      "workspace.consult",
      "browser.preview",
      "collaboration.receive",
    ],
    providerInstanceId:
      modelSelection === undefined || modelSelection === null
        ? null
        : (modelSelection.instanceId as VmAgentCollaborationAgentSummary["providerInstanceId"]),
    model: modelSelection?.model ?? null,
    activeDelegations,
    canReceiveDelegation: true,
  };
};

export const make = Effect.gen(function* () {
  const store = yield* VmAgentCollaborationStore;
  const agents = yield* VmAgentStore;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const listeners = new Set<CollaborationListener>();

  const requireAgent = Effect.fn("VmAgentCollaboration.requireAgent")(function* (
    vmAgentId: VmAgentId,
  ) {
    const agent = yield* agents
      .getById(vmAgentId)
      .pipe(Effect.mapError(operationError("resolving agent")));
    if (Option.isNone(agent)) return yield* new VmAgentNotFoundError({ vmAgentId });
    return agent.value;
  });

  const readSnapshot = Effect.fn("VmAgentCollaboration.readSnapshot")(function* (
    visibleTo?: VmAgentId,
  ) {
    const [agentRows, delegationRows] = yield* Effect.all([
      agents.list().pipe(Effect.mapError(operationError("listing agents"))),
      visibleTo === undefined
        ? store.list().pipe(Effect.mapError(operationError("listing delegated work")))
        : store
            .listForAgent(visibleTo)
            .pipe(Effect.mapError(operationError("listing delegated work"))),
    ]);
    const activeByTarget = new Map<string, number>();
    const runningByTarget = new Map<string, number>();
    for (const delegation of delegationRows) {
      if (!activeStatuses.has(delegation.status) || delegation.targetVmAgentId === null) continue;
      activeByTarget.set(
        delegation.targetVmAgentId,
        (activeByTarget.get(delegation.targetVmAgentId) ?? 0) + 1,
      );
      if (delegation.status === "running") {
        runningByTarget.set(
          delegation.targetVmAgentId,
          (runningByTarget.get(delegation.targetVmAgentId) ?? 0) + 1,
        );
      }
    }
    const agentSummaries = yield* Effect.forEach(
      agentRows,
      (agent) =>
        (agent.threadId === null
          ? Effect.succeed(null)
          : projections.getThreadShellById(agent.threadId).pipe(
              Effect.map(Option.getOrNull),
              Effect.orElseSucceed(() => null),
            )
        ).pipe(
          Effect.map((thread) =>
            agentAvailability(
              agent,
              activeByTarget.get(agent.vmAgentId) ?? 0,
              runningByTarget.get(agent.vmAgentId) ?? 0,
              thread?.modelSelection ?? null,
            ),
          ),
        ),
      { concurrency: 8 },
    );
    const byId = new Map(agentSummaries.map((agent) => [agent.vmAgentId, agent]));
    const delegations: Array<VmAgentDelegationSummary> = delegationRows.map((delegation) => ({
      delegation,
      rootAgent: byId.get(delegation.rootVmAgentId) ?? null,
      sourceAgent: byId.get(delegation.sourceVmAgentId) ?? null,
      targetAgent:
        delegation.targetVmAgentId === null ? null : (byId.get(delegation.targetVmAgentId) ?? null),
      latestMessage: null,
    }));
    return {
      type: "snapshot" as const,
      agents: agentSummaries,
      delegations,
    } satisfies VmAgentCollaborationSnapshot;
  });

  const snapshot: VmAgentCollaborationShape["snapshot"] = () => readSnapshot();
  const snapshotForAgent: VmAgentCollaborationShape["snapshotForAgent"] = (vmAgentId) =>
    requireAgent(vmAgentId).pipe(Effect.flatMap(() => readSnapshot(vmAgentId)));

  const publish = Effect.fn("VmAgentCollaboration.publish")(function* () {
    if (listeners.size === 0) return;
    const next = yield* readSnapshot().pipe(Effect.orElseSucceed(() => null));
    if (!next) return;
    for (const listener of listeners) yield* listener(next).pipe(Effect.ignoreCause({ log: true }));
  });

  const subscribe: VmAgentCollaborationShape["subscribe"] = (listener) => {
    let subscribed = false;
    return Effect.gen(function* () {
      listeners.add(listener);
      subscribed = true;
      yield* listener(yield* readSnapshot());
      return () => listeners.delete(listener);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          if (subscribed) listeners.delete(listener);
        }).pipe(Effect.flatMap(() => Effect.failCause(cause))),
      ),
    );
  };

  const requireDelegation = Effect.fn("VmAgentCollaboration.requireDelegation")(function* (
    delegationId: VmAgentDelegationId,
  ) {
    const delegation = yield* store
      .getById(delegationId)
      .pipe(Effect.mapError(operationError("reading delegated work")));
    if (Option.isNone(delegation))
      return yield* new VmAgentDelegationNotFoundError({ delegationId });
    return delegation.value;
  });

  const actorLabel = (actor: CollaborationActor) =>
    actor.kind === "user"
      ? "user"
      : actor.kind === "agent"
        ? actor.vmAgentId
        : `worker:${actor.delegationId}`;

  const authorize = Effect.fn("VmAgentCollaboration.authorize")(function* (
    actor: CollaborationActor,
    delegation: VmAgentDelegation,
  ) {
    const allowed =
      actor.kind === "user" ||
      (actor.kind === "worker" && actor.delegationId === delegation.delegationId) ||
      (actor.kind === "agent" &&
        (actor.vmAgentId === delegation.rootVmAgentId ||
          actor.vmAgentId === delegation.sourceVmAgentId ||
          actor.vmAgentId === delegation.targetVmAgentId));
    if (!allowed) {
      return yield* new VmAgentDelegationScopeError({
        delegationId: delegation.delegationId,
        vmAgentId: actorLabel(actor),
      });
    }
  });

  const getLiveAgentSummary = Effect.fn("VmAgentCollaboration.getLiveAgentSummary")(function* (
    vmAgentId: VmAgentId,
    activeDelegations: number,
  ) {
    const agent = yield* agents
      .getById(vmAgentId)
      .pipe(Effect.mapError(operationError("resolving agent detail")));
    if (Option.isNone(agent)) return null;
    const thread =
      agent.value.threadId === null
        ? null
        : yield* projections.getThreadShellById(agent.value.threadId).pipe(
            Effect.map(Option.getOrNull),
            Effect.orElseSucceed(() => null),
          );
    return agentAvailability(
      agent.value,
      activeDelegations,
      activeDelegations,
      thread?.modelSelection ?? null,
    );
  });

  const getDetail: VmAgentCollaborationShape["getDetail"] = Effect.fn(
    "VmAgentCollaboration.getDetail",
  )(function* (actor, delegationId) {
    const delegation = yield* requireDelegation(delegationId);
    yield* authorize(actor, delegation);
    const [rootAgent, sourceAgent, targetAgent, messages] = yield* Effect.all([
      getLiveAgentSummary(delegation.rootVmAgentId, 0),
      getLiveAgentSummary(delegation.sourceVmAgentId, 0),
      delegation.targetVmAgentId === null
        ? Effect.succeed(null)
        : getLiveAgentSummary(
            delegation.targetVmAgentId,
            activeStatuses.has(delegation.status) ? 1 : 0,
          ),
      store.listMessages(delegationId).pipe(Effect.mapError(operationError("reading messages"))),
    ]);
    return { delegation, rootAgent, sourceAgent, targetAgent, messages };
  });

  const delegate: VmAgentCollaborationShape["delegate"] = Effect.fn(
    "VmAgentCollaboration.delegate",
  )(function* (sourceVmAgentId, input) {
    const prior = yield* store
      .getByIdempotencyKey(sourceVmAgentId, input.idempotencyKey)
      .pipe(Effect.mapError(operationError("checking delegation idempotency")));
    if (Option.isSome(prior)) {
      return {
        delegation: prior.value,
        receipt: {
          operation: "delegate" as const,
          delegationId: prior.value.delegationId,
          status: prior.value.status,
          revision: prior.value.revision,
          acceptedAt: prior.value.updatedAt,
        },
      };
    }
    const source = yield* requireAgent(sourceVmAgentId);
    const parent = yield* store
      .findActiveForTarget(sourceVmAgentId)
      .pipe(Effect.mapError(operationError("checking delegation depth")));
    if (Option.isSome(parent)) {
      return yield* new VmAgentDelegationLimitError({
        limit: "depth",
        maximum: DEFAULT_VM_AGENT_DELEGATION_LIMITS.maxDepth,
      });
    }
    const activeChildren = yield* store
      .countActiveForRoot(sourceVmAgentId)
      .pipe(Effect.mapError(operationError("checking active delegation count")));
    if (activeChildren >= DEFAULT_VM_AGENT_DELEGATION_LIMITS.maxChildDelegations) {
      return yield* new VmAgentDelegationLimitError({
        limit: "active-children",
        maximum: DEFAULT_VM_AGENT_DELEGATION_LIMITS.maxChildDelegations,
      });
    }

    let targetAgent: VmAgent | null = null;
    if (input.target.kind === "agent") {
      if (input.target.vmAgentId === sourceVmAgentId) {
        return yield* new VmAgentDelegationLimitError({
          limit: "depth",
          maximum: DEFAULT_VM_AGENT_DELEGATION_LIMITS.maxDepth,
        });
      }
      targetAgent = yield* requireAgent(input.target.vmAgentId);
    }

    // Every thread carries the collaborative preview browser, so ephemeral
    // workers get the browser capability just like named agents.
    const allowedCapabilities = new Set([
      "workspace.tasks",
      "workspace.consult",
      "browser.preview",
      "collaboration.receive",
    ]);
    const unavailableCapability = (input.requestedCapabilities ?? []).find(
      (capability) => !allowedCapabilities.has(capability),
    );
    if (unavailableCapability !== undefined) {
      return yield* new VmAgentCollaborationOperationError({
        operation: "delegating work",
        detail: `Requested capability '${unavailableCapability}' is unavailable to this target.`,
      });
    }

    const createdAt = yield* nowIso;
    const delegationId = VmAgentDelegationId.make(NodeCrypto.randomUUID());
    const taskId = VmAgentTaskId.make(`delegation-task:${delegationId}`);
    const expiresAt = DateTime.formatIso(
      DateTime.add(DateTime.makeUnsafe(createdAt), {
        minutes: DEFAULT_VM_AGENT_DELEGATION_LIMITS.maxWallClockMinutes,
      }),
    );
    const delegation: VmAgentDelegation = {
      delegationId,
      rootVmAgentId: sourceVmAgentId,
      sourceVmAgentId,
      rootDelegationId: null,
      parentDelegationId: null,
      depth: 1,
      target: input.target,
      targetVmAgentId: targetAgent?.vmAgentId ?? null,
      workerThreadId: null,
      rootAgentSnapshot: identitySnapshot(source),
      sourceAgentSnapshot: identitySnapshot(source),
      targetAgentSnapshot: targetAgent ? identitySnapshot(targetAgent) : null,
      taskId,
      runId: null,
      title: input.title,
      task: input.task,
      completionCriteria: input.completionCriteria ?? [],
      requestedCapabilities: input.requestedCapabilities ?? [],
      status: "queued",
      followupCount: 0,
      messageCount: 1,
      effectiveLimits: DEFAULT_VM_AGENT_DELEGATION_LIMITS,
      revision: 1,
      createdAt,
      startedAt: null,
      completedAt: null,
      expiresAt,
      updatedAt: createdAt,
      result: null,
      error: null,
    };
    yield* store
      .create({
        delegation,
        schedulerVmAgentId: targetAgent?.vmAgentId ?? sourceVmAgentId,
        idempotencyKey: input.idempotencyKey,
        initialMessage: {
          messageId: VmAgentDelegationMessageId.make(`delegation-message:${delegationId}:1`),
          delegationId,
          sequence: 1,
          sender: "source-agent",
          senderVmAgentId: sourceVmAgentId,
          kind: "note",
          delivery: "delivered",
          text: input.task,
          createdAt,
        },
      })
      .pipe(Effect.mapError(operationError("creating delegated work")));
    yield* publish();
    return {
      delegation,
      receipt: {
        operation: "delegate" as const,
        delegationId,
        status: "queued" as const,
        revision: 1,
        acceptedAt: createdAt,
      },
    };
  });

  const targetThread = Effect.fn("VmAgentCollaboration.targetThread")(function* (
    delegation: VmAgentDelegation,
  ) {
    if (delegation.workerThreadId !== null) return ThreadId.make(delegation.workerThreadId);
    if (delegation.targetVmAgentId === null) {
      return yield* new VmAgentCollaborationOperationError({
        operation: "resolving delegated worker",
        detail: "The ephemeral worker has not started yet.",
      });
    }
    const target = yield* requireAgent(delegation.targetVmAgentId);
    if (target.threadId === null) {
      return yield* new VmAgentCollaborationOperationError({
        operation: "resolving delegated worker",
        detail: "The target agent has no chat thread.",
      });
    }
    return target.threadId;
  });

  const sendMessage: VmAgentCollaborationShape["sendMessage"] = Effect.fn(
    "VmAgentCollaboration.sendMessage",
  )(function* (actor, input) {
    const delegation = yield* requireDelegation(input.delegationId);
    yield* authorize(actor, delegation);
    if (!activeStatuses.has(delegation.status)) {
      return yield* new VmAgentDelegationInvalidStateError({
        delegationId: delegation.delegationId,
        status: delegation.status,
        operation: "send a message to",
      });
    }
    if (delegation.messageCount >= delegation.effectiveLimits.maxMessages) {
      return yield* new VmAgentDelegationLimitError({
        limit: "messages",
        maximum: delegation.effectiveLimits.maxMessages,
      });
    }
    const sourceSide =
      actor.kind === "user" ||
      (actor.kind === "agent" &&
        (actor.vmAgentId === delegation.rootVmAgentId ||
          actor.vmAgentId === delegation.sourceVmAgentId));
    const createdAt = yield* nowIso;
    const messageId = VmAgentDelegationMessageId.make(NodeCrypto.randomUUID());
    if (sourceSide) {
      if (delegation.status !== "running" && delegation.status !== "waiting-input") {
        return yield* new VmAgentDelegationInvalidStateError({
          delegationId: delegation.delegationId,
          status: delegation.status,
          operation: "follow up on",
        });
      }
      if (delegation.followupCount >= delegation.effectiveLimits.maxFollowups) {
        return yield* new VmAgentDelegationLimitError({
          limit: "followups",
          maximum: delegation.effectiveLimits.maxFollowups,
        });
      }
      yield* store
        .appendMessage({
          messageId,
          delegationId: delegation.delegationId,
          sender: actor.kind === "user" ? "user" : "source-agent",
          senderVmAgentId: actor.kind === "agent" ? actor.vmAgentId : null,
          kind: input.kind ?? (delegation.status === "waiting-input" ? "answer" : "note"),
          delivery: "pending",
          text: input.message,
          createdAt,
          incrementFollowup: true,
          nextStatus: "queued",
        })
        .pipe(Effect.mapError(operationError("recording delegation follow-up")));
    } else {
      yield* store
        .appendMessage({
          messageId,
          delegationId: delegation.delegationId,
          sender: "target-agent",
          senderVmAgentId: actor.kind === "agent" ? actor.vmAgentId : null,
          kind: input.kind ?? (input.waitForReply === true ? "question" : "note"),
          delivery: "delivered",
          text: input.message,
          createdAt,
          incrementFollowup: false,
          ...(input.waitForReply === true ? { nextStatus: "waiting-input" as const } : {}),
        })
        .pipe(Effect.mapError(operationError("recording delegated worker message")));
    }
    yield* publish();
    const updated = yield* requireDelegation(delegation.delegationId);
    return {
      operation: "send-message" as const,
      delegationId: delegation.delegationId,
      status: updated.status,
      revision: updated.revision,
      acceptedAt: createdAt,
    };
  });

  const cancel: VmAgentCollaborationShape["cancel"] = Effect.fn("VmAgentCollaboration.cancel")(
    function* (actor, delegationId) {
      const delegation = yield* requireDelegation(delegationId);
      yield* authorize(actor, delegation);
      const canCancel =
        actor.kind === "user" ||
        (actor.kind === "agent" &&
          (actor.vmAgentId === delegation.rootVmAgentId ||
            actor.vmAgentId === delegation.sourceVmAgentId));
      if (!canCancel) {
        return yield* new VmAgentDelegationScopeError({
          delegationId,
          vmAgentId: actorLabel(actor),
        });
      }
      if (!activeStatuses.has(delegation.status)) {
        return yield* new VmAgentDelegationInvalidStateError({
          delegationId,
          status: delegation.status,
          operation: "cancel",
        });
      }
      const completedAt = yield* nowIso;
      yield* store
        .cancel({
          delegationId,
          status: "cancelled",
          detail: "Cancelled by the coordinating agent or user.",
          completedAt,
        })
        .pipe(Effect.mapError(operationError("cancelling delegated work")));
      const threadId = yield* targetThread(delegation).pipe(Effect.orElseSucceed(() => null));
      if (threadId !== null) {
        const thread = yield* projections
          .getThreadShellById(threadId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        const activeTurnId = Option.isSome(thread) ? thread.value.session?.activeTurnId : null;
        if (activeTurnId) {
          yield* engine
            .dispatch({
              type: "thread.turn.interrupt",
              commandId: CommandId.make(`delegation-cancel:${delegationId}`),
              threadId,
              turnId: activeTurnId,
              createdAt: completedAt,
            })
            .pipe(Effect.ignoreCause({ log: true }));
        }
      }
      yield* publish();
      const updated = yield* requireDelegation(delegationId);
      return {
        operation: "cancel" as const,
        delegationId,
        status: "cancelled" as const,
        revision: updated.revision,
        acceptedAt: completedAt,
      };
    },
  );

  const activeDelegationForThread: VmAgentCollaborationShape["activeDelegationForThread"] = (
    threadId,
  ) =>
    store.getByWorkerThreadId(threadId).pipe(
      Effect.flatMap((worker) => {
        if (Option.isSome(worker) && activeStatuses.has(worker.value.status))
          return Effect.succeed(worker);
        return agents.getByThreadId(threadId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(Option.none()),
              onSome: (agent) => store.findActiveForTarget(agent.vmAgentId),
            }),
          ),
        );
      }),
      Effect.mapError(operationError("reading active delegated work")),
    );

  return VmAgentCollaboration.of({
    snapshot,
    snapshotForAgent,
    subscribe,
    getDetail,
    delegate,
    sendMessage,
    cancel,
    activeDelegationForThread,
    refresh: publish(),
  });
});

export const VmAgentCollaborationLive = Layer.effect(VmAgentCollaboration, make);
