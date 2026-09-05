import {
  CommandId,
  DEFAULT_VM_AGENT_DELEGATION_LIMITS,
  VM_AGENT_COLLABORATION_LIST_LIMIT,
  VM_AGENT_DELEGATION_DETAIL_PAGE_SIZE,
  VM_AGENT_DELEGATION_MAX_MESSAGES,
  VM_AGENT_DELEGATION_OUTPUT_PREVIEW_MAX_LENGTH,
  VM_AGENT_DELEGATION_TASK_PREVIEW_MAX_LENGTH,
  type VmAgent,
  type VmAgentCollaborationAgentSummary,
  type VmAgentCollaborationError,
  type VmAgentCollaborationIdentitySummary,
  VmAgentCollaborationOperationError,
  type VmAgentCollaborationReceipt,
  type VmAgentCollaborationSnapshot,
  type VmAgentDelegation,
  type VmAgentDelegationDetail,
  VmAgentDelegationId,
  VmAgentDelegationInvalidStateError,
  type VmAgentDelegationListItem,
  VmAgentDelegationLimitError,
  VmAgentDelegationMessageId,
  VmAgentDelegationNotFoundError,
  VmAgentDelegationScopeError,
  type VmAgentDelegationSummary,
  type VmAgentId,
  type VmAgentIdentitySnapshot,
  type VmAgentLegacyCollaborationSnapshot,
  type VmAgentLegacyDelegationSummary,
  VmAgentNotFoundError,
  VmAgentTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeBuffer from "node:buffer";
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
type LegacyCollaborationListener = (
  snapshot: VmAgentLegacyCollaborationSnapshot,
) => Effect.Effect<void>;
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
  readonly subscribeLegacy: (
    listener: LegacyCollaborationListener,
  ) => Effect.Effect<() => void, VmAgentCollaborationError>;
  readonly getDetail: (
    actor: CollaborationActor,
    delegationId: VmAgentDelegationId,
    options?: {
      readonly beforeSequence?: number | undefined;
      readonly messageLimit?: number | undefined;
    },
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

/** Leaves the WebSocket buffer's 512-byte accounting overhead inside its 2 MiB item cap. */
export const VM_AGENT_COLLABORATION_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024 - 512;

/** Absent preserves the pre-pagination 200-message detail response. */
export const delegationDetailMessageLimit = (paged: true | undefined) =>
  paged === true ? VM_AGENT_DELEGATION_DETAIL_PAGE_SIZE : VM_AGENT_DELEGATION_MAX_MESSAGES;

/** Absent preserves the full-row snapshot expected by clients from before compact rows. */
export const collaborationSubscriptionMode = (compact: true | undefined) =>
  compact === true ? ("compact" as const) : ("legacy" as const);

const jsonBytes = (value: unknown) => NodeBuffer.Buffer.byteLength(JSON.stringify(value), "utf8");

export const collaborationSnapshotPage = <A>(rows: ReadonlyArray<A>) => ({
  rows: rows.slice(0, VM_AGENT_COLLABORATION_LIST_LIMIT),
  hasMore: rows.length > VM_AGENT_COLLABORATION_LIST_LIMIT,
});

export const boundedCollaborationSnapshot = (
  agents: ReadonlyArray<VmAgentCollaborationAgentSummary>,
  delegations: ReadonlyArray<VmAgentDelegationSummary>,
  sourceHasMoreDelegations = false,
): VmAgentCollaborationSnapshot => {
  const boundedAgents: Array<VmAgentCollaborationAgentSummary> = [];
  const boundedDelegations: Array<VmAgentDelegationSummary> = [];
  // `false` is one byte longer than `true`, so this is the worst-case fixed
  // envelope regardless of which truncation markers the final snapshot uses.
  let bytes = jsonBytes({
    type: "snapshot",
    compact: true,
    hasMoreAgents: false,
    hasMoreDelegations: false,
    agents: [],
    delegations: [],
  });
  // A registry with thousands of agents must not consume the entire envelope
  // before the first work row. Reserve the exact first-row cost so a non-empty
  // source snapshot can never be rendered as an empty handoff list.
  const firstDelegationBytes = delegations[0] === undefined ? 0 : jsonBytes(delegations[0]);
  for (const agent of agents) {
    const added = jsonBytes(agent) + (boundedAgents.length > 0 ? 1 : 0);
    if (bytes + added + firstDelegationBytes > VM_AGENT_COLLABORATION_SNAPSHOT_MAX_BYTES) {
      break;
    }
    boundedAgents.push(agent);
    bytes += added;
  }
  for (const delegation of delegations) {
    const added = jsonBytes(delegation) + (boundedDelegations.length > 0 ? 1 : 0);
    if (bytes + added > VM_AGENT_COLLABORATION_SNAPSHOT_MAX_BYTES) break;
    boundedDelegations.push(delegation);
    bytes += added;
  }
  return {
    type: "snapshot",
    compact: true,
    hasMoreAgents: boundedAgents.length < agents.length,
    hasMoreDelegations: sourceHasMoreDelegations || boundedDelegations.length < delegations.length,
    agents: boundedAgents,
    delegations: boundedDelegations,
  };
};

export const boundedLegacyCollaborationSnapshot = (
  agents: ReadonlyArray<VmAgentCollaborationAgentSummary>,
  delegations: ReadonlyArray<VmAgentLegacyDelegationSummary>,
  sourceHasMoreDelegations = false,
): VmAgentLegacyCollaborationSnapshot => {
  const boundedAgents: Array<VmAgentCollaborationAgentSummary> = [];
  const boundedDelegations: Array<VmAgentLegacyDelegationSummary> = [];
  let bytes = jsonBytes({
    type: "snapshot",
    hasMoreAgents: false,
    hasMoreDelegations: false,
    agents: [],
    delegations: [],
  });
  const firstDelegationBytes = delegations[0] === undefined ? 0 : jsonBytes(delegations[0]);
  for (const agent of agents) {
    const added = jsonBytes(agent) + (boundedAgents.length > 0 ? 1 : 0);
    if (bytes + added + firstDelegationBytes > VM_AGENT_COLLABORATION_SNAPSHOT_MAX_BYTES) {
      break;
    }
    boundedAgents.push(agent);
    bytes += added;
  }
  for (const delegation of delegations) {
    const added = jsonBytes(delegation) + (boundedDelegations.length > 0 ? 1 : 0);
    if (bytes + added > VM_AGENT_COLLABORATION_SNAPSHOT_MAX_BYTES) break;
    boundedDelegations.push(delegation);
    bytes += added;
  }
  return {
    type: "snapshot",
    hasMoreAgents: boundedAgents.length < agents.length,
    hasMoreDelegations: sourceHasMoreDelegations || boundedDelegations.length < delegations.length,
    agents: boundedAgents,
    delegations: boundedDelegations,
  };
};

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

const compactIdentity = (
  identity: Pick<VmAgentIdentitySnapshot, "vmAgentId" | "name" | "handle">,
): VmAgentCollaborationIdentitySummary => ({
  vmAgentId: identity.vmAgentId,
  name: identity.name,
  handle: identity.handle,
});

/** Keeps list payloads bounded while avoiding an unmatched UTF-16 surrogate before the ellipsis. */
export const boundedDelegationPreview = (text: string, maxLength: number) => {
  if (text.length <= maxLength) return { text, truncated: false } as const;
  let end = maxLength - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return {
    text: `${text.slice(0, end).trimEnd()}…`,
    truncated: true,
  } as const;
};

export const delegationListItem = (delegation: VmAgentDelegation): VmAgentDelegationListItem => ({
  delegationId: delegation.delegationId,
  rootVmAgentId: delegation.rootVmAgentId,
  sourceVmAgentId: delegation.sourceVmAgentId,
  rootDelegationId: delegation.rootDelegationId,
  parentDelegationId: delegation.parentDelegationId,
  depth: delegation.depth,
  target: delegation.target,
  targetVmAgentId: delegation.targetVmAgentId,
  rootAgentSnapshot: compactIdentity(delegation.rootAgentSnapshot),
  sourceAgentSnapshot: compactIdentity(delegation.sourceAgentSnapshot),
  targetAgentSnapshot:
    delegation.targetAgentSnapshot === null
      ? null
      : compactIdentity(delegation.targetAgentSnapshot),
  title: delegation.title,
  taskPreview: boundedDelegationPreview(
    delegation.task,
    VM_AGENT_DELEGATION_TASK_PREVIEW_MAX_LENGTH,
  ),
  status: delegation.status,
  followupCount: delegation.followupCount,
  messageCount: delegation.messageCount,
  revision: delegation.revision,
  createdAt: delegation.createdAt,
  startedAt: delegation.startedAt,
  completedAt: delegation.completedAt,
  expiresAt: delegation.expiresAt,
  updatedAt: delegation.updatedAt,
  resultPreview:
    delegation.result === null
      ? null
      : {
          ...boundedDelegationPreview(
            delegation.result.summary,
            VM_AGENT_DELEGATION_OUTPUT_PREVIEW_MAX_LENGTH,
          ),
          completedBy: delegation.result.completedBy,
          completedAt: delegation.result.completedAt,
        },
  errorPreview:
    delegation.error === null
      ? null
      : boundedDelegationPreview(delegation.error, VM_AGENT_DELEGATION_OUTPUT_PREVIEW_MAX_LENGTH),
});

export const delegationSummary = (
  delegation: VmAgentDelegation | VmAgentDelegationListItem,
  agentsById: ReadonlyMap<VmAgentId, VmAgentCollaborationAgentSummary>,
): VmAgentDelegationSummary => {
  const agentIdentity = (vmAgentId: VmAgentId | null) => {
    if (vmAgentId === null) return null;
    const agent = agentsById.get(vmAgentId);
    return agent === undefined ? null : compactIdentity(agent);
  };
  const listItem = "taskPreview" in delegation ? delegation : delegationListItem(delegation);
  return {
    delegation: listItem,
    rootAgent: agentIdentity(delegation.rootVmAgentId),
    sourceAgent: agentIdentity(delegation.sourceVmAgentId),
    targetAgent: agentIdentity(delegation.targetVmAgentId),
    latestMessage: null,
  };
};

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
  const legacyListeners = new Set<LegacyCollaborationListener>();

  const requireAgent = Effect.fn("VmAgentCollaboration.requireAgent")(function* (
    vmAgentId: VmAgentId,
  ) {
    const agent = yield* agents
      .getById(vmAgentId)
      .pipe(Effect.mapError(operationError("resolving agent")));
    if (Option.isNone(agent)) return yield* new VmAgentNotFoundError({ vmAgentId });
    return agent.value;
  });

  const summarizeAgents = Effect.fn("VmAgentCollaboration.summarizeAgents")(function* (
    agentRows: ReadonlyArray<VmAgent>,
    delegationRows: ReadonlyArray<Pick<VmAgentDelegation, "status" | "targetVmAgentId">>,
  ) {
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
    return yield* Effect.forEach(
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
  });

  const readSnapshot = Effect.fn("VmAgentCollaboration.readSnapshot")(function* (
    visibleTo?: VmAgentId,
  ) {
    const [agentRows, delegationRows] = yield* Effect.all([
      agents.list().pipe(Effect.mapError(operationError("listing agents"))),
      visibleTo === undefined
        ? store.listSummaries().pipe(Effect.mapError(operationError("listing delegated work")))
        : store
            .listSummariesForAgent(visibleTo)
            .pipe(Effect.mapError(operationError("listing delegated work"))),
    ]);
    const delegationPage = collaborationSnapshotPage(delegationRows);
    const agentSummaries = yield* summarizeAgents(agentRows, delegationPage.rows);
    const byId = new Map(agentSummaries.map((agent) => [agent.vmAgentId, agent] as const));
    const delegations: Array<VmAgentDelegationSummary> = delegationPage.rows.map((delegation) =>
      delegationSummary(delegation, byId),
    );
    return boundedCollaborationSnapshot(agentSummaries, delegations, delegationPage.hasMore);
  });

  const readLegacySnapshot = Effect.fn("VmAgentCollaboration.readLegacySnapshot")(function* () {
    const [agentRows, delegationRows] = yield* Effect.all([
      agents.list().pipe(Effect.mapError(operationError("listing agents"))),
      store.list().pipe(Effect.mapError(operationError("listing delegated work"))),
    ]);
    const delegationPage = collaborationSnapshotPage(delegationRows);
    const agentSummaries = yield* summarizeAgents(agentRows, delegationPage.rows);
    const byId = new Map(agentSummaries.map((agent) => [agent.vmAgentId, agent] as const));
    const delegations: Array<VmAgentLegacyDelegationSummary> = delegationPage.rows.map(
      (delegation) => ({
        delegation,
        rootAgent: byId.get(delegation.rootVmAgentId) ?? null,
        sourceAgent: byId.get(delegation.sourceVmAgentId) ?? null,
        targetAgent:
          delegation.targetVmAgentId === null
            ? null
            : (byId.get(delegation.targetVmAgentId) ?? null),
        latestMessage: null,
      }),
    );
    return boundedLegacyCollaborationSnapshot(agentSummaries, delegations, delegationPage.hasMore);
  });

  const snapshot: VmAgentCollaborationShape["snapshot"] = () => readSnapshot();
  const snapshotForAgent: VmAgentCollaborationShape["snapshotForAgent"] = (vmAgentId) =>
    requireAgent(vmAgentId).pipe(Effect.flatMap(() => readSnapshot(vmAgentId)));

  const publish = Effect.fn("VmAgentCollaboration.publish")(function* () {
    if (listeners.size > 0) {
      const next = yield* readSnapshot().pipe(Effect.orElseSucceed(() => null));
      if (next) {
        for (const listener of listeners) {
          yield* listener(next).pipe(Effect.ignoreCause({ log: true }));
        }
      }
    }
    if (legacyListeners.size > 0) {
      const next = yield* readLegacySnapshot().pipe(Effect.orElseSucceed(() => null));
      if (next) {
        for (const listener of legacyListeners) {
          yield* listener(next).pipe(Effect.ignoreCause({ log: true }));
        }
      }
    }
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

  const subscribeLegacy: VmAgentCollaborationShape["subscribeLegacy"] = (listener) => {
    let subscribed = false;
    return Effect.gen(function* () {
      legacyListeners.add(listener);
      subscribed = true;
      yield* listener(yield* readLegacySnapshot());
      return () => legacyListeners.delete(listener);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          if (subscribed) legacyListeners.delete(listener);
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
  )(function* (actor, delegationId, options) {
    const delegation = yield* requireDelegation(delegationId);
    yield* authorize(actor, delegation);
    const [rootAgent, sourceAgent, targetAgent, messagePage] = yield* Effect.all([
      getLiveAgentSummary(delegation.rootVmAgentId, 0),
      getLiveAgentSummary(delegation.sourceVmAgentId, 0),
      delegation.targetVmAgentId === null
        ? Effect.succeed(null)
        : getLiveAgentSummary(
            delegation.targetVmAgentId,
            activeStatuses.has(delegation.status) ? 1 : 0,
          ),
      store
        .listMessagesPage(
          delegationId,
          options?.beforeSequence ?? null,
          Math.min(
            VM_AGENT_DELEGATION_MAX_MESSAGES,
            Math.max(1, options?.messageLimit ?? VM_AGENT_DELEGATION_MAX_MESSAGES),
          ),
        )
        .pipe(Effect.mapError(operationError("reading messages"))),
    ]);
    return {
      delegation,
      rootAgent,
      sourceAgent,
      targetAgent,
      messages: messagePage.messages,
      hasEarlierMessages: messagePage.hasEarlierMessages,
    };
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
    const parent =
      source.threadId === null ? Option.none() : yield* activeDelegationForThread(source.threadId);
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
      workerThreadId: ThreadId.make(`delegation-worker:${delegationId}`),
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
        let activeTurnId = Option.isSome(thread)
          ? (thread.value.session?.activeTurnId ??
            (thread.value.latestTurn?.state === "running" ? thread.value.latestTurn.turnId : null))
          : null;
        if (activeTurnId && delegation.workerThreadId === null) {
          const ownedTurn =
            projections.getActiveTurnDelegation === undefined
              ? Option.none()
              : yield* projections
                  .getActiveTurnDelegation(threadId)
                  .pipe(Effect.orElseSucceed(() => Option.none()));
          if (Option.isNone(ownedTurn) || ownedTurn.value.delegationId !== delegationId)
            activeTurnId = null;
        }
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
        // Legacy named delegations can own a main-chat turn. Queued work or
        // another worker using this agent's identity does not own that chat.
        return (
          projections.getActiveTurnDelegation?.(ThreadId.make(threadId)) ??
          Effect.succeed(Option.none())
        ).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(Option.none()),
              onSome: ({ delegationId }) =>
                store
                  .getById(delegationId)
                  .pipe(
                    Effect.map(
                      Option.filter(
                        (delegation) =>
                          delegation.workerThreadId === null &&
                          activeStatuses.has(delegation.status),
                      ),
                    ),
                  ),
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
    subscribeLegacy,
    getDetail,
    delegate,
    sendMessage,
    cancel,
    activeDelegationForThread,
    refresh: publish(),
  });
});

export const VmAgentCollaborationLive = Layer.effect(VmAgentCollaboration, make);
