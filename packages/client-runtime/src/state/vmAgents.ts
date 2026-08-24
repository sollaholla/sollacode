import {
  VM_AGENT_DELEGATION_MESSAGE_PREVIEW_MAX_LENGTH,
  VM_AGENT_DELEGATION_OUTPUT_PREVIEW_MAX_LENGTH,
  VM_AGENT_DELEGATION_TASK_PREVIEW_MAX_LENGTH,
  WS_METHODS,
  type VmAgent,
  type VmAgentCollaborationIdentitySummary,
  type VmAgentCollaborationSnapshot,
  type VmAgentCollaborationStreamItem,
  type VmAgentCollaborationWireStreamItem,
  type VmAgentDelegationSummary,
  type VmAgentLegacyCollaborationSnapshot,
  type VmAgentStreamEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import { resubscribeOnTerminalResync } from "./terminalResync.ts";

export interface VmAgentRegistryView {
  readonly type: "snapshot";
  readonly agents: ReadonlyArray<VmAgent>;
}

const INITIAL_AGENT_REGISTRY_VIEW: VmAgentRegistryView = {
  type: "snapshot",
  agents: [],
};

export const LEGACY_COLLABORATION_REFRESH_INTERVAL_MS = 5_000;
export const COLLABORATION_RESYNC_INITIAL_BACKOFF_MS = 250;
export const COLLABORATION_RESYNC_MAX_BACKOFF_MS = 4_000;
export const MAX_CONSECUTIVE_COLLABORATION_RESYNCS = 5;

export const collaborationResyncBackoffMs = (consecutiveResyncs: number) =>
  Math.min(
    COLLABORATION_RESYNC_MAX_BACKOFF_MS,
    COLLABORATION_RESYNC_INITIAL_BACKOFF_MS * 2 ** Math.max(0, consecutiveResyncs - 1),
  );

const collaborationResyncExhaustedError = () =>
  new Error(
    "Collaboration could not load after repeated host resyncs. Update Solla Code on the host, then retry.",
  );

const boundedPreview = (text: string, maxLength: number) => {
  if (text.length <= maxLength) return { text, truncated: false } as const;
  let end = maxLength - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: `${text.slice(0, end).trimEnd()}…`, truncated: true } as const;
};

const compactIdentity = (
  identity: Pick<VmAgentCollaborationIdentitySummary, "vmAgentId" | "name" | "handle">,
): VmAgentCollaborationIdentitySummary => ({
  vmAgentId: identity.vmAgentId,
  name: identity.name,
  handle: identity.handle,
});

const normalizeLegacyDelegation = (
  summary: VmAgentLegacyCollaborationSnapshot["delegations"][number],
): VmAgentDelegationSummary => ({
  delegation: {
    delegationId: summary.delegation.delegationId,
    rootVmAgentId: summary.delegation.rootVmAgentId,
    sourceVmAgentId: summary.delegation.sourceVmAgentId,
    rootDelegationId: summary.delegation.rootDelegationId,
    parentDelegationId: summary.delegation.parentDelegationId,
    depth: summary.delegation.depth,
    target: summary.delegation.target,
    targetVmAgentId: summary.delegation.targetVmAgentId,
    rootAgentSnapshot: compactIdentity(summary.delegation.rootAgentSnapshot),
    sourceAgentSnapshot: compactIdentity(summary.delegation.sourceAgentSnapshot),
    targetAgentSnapshot:
      summary.delegation.targetAgentSnapshot === null
        ? null
        : compactIdentity(summary.delegation.targetAgentSnapshot),
    title: summary.delegation.title,
    taskPreview: boundedPreview(
      summary.delegation.task,
      VM_AGENT_DELEGATION_TASK_PREVIEW_MAX_LENGTH,
    ),
    status: summary.delegation.status,
    followupCount: summary.delegation.followupCount,
    messageCount: summary.delegation.messageCount,
    revision: summary.delegation.revision,
    createdAt: summary.delegation.createdAt,
    startedAt: summary.delegation.startedAt,
    completedAt: summary.delegation.completedAt,
    expiresAt: summary.delegation.expiresAt,
    updatedAt: summary.delegation.updatedAt,
    resultPreview:
      summary.delegation.result === null
        ? null
        : {
            ...boundedPreview(
              summary.delegation.result.summary,
              VM_AGENT_DELEGATION_OUTPUT_PREVIEW_MAX_LENGTH,
            ),
            completedBy: summary.delegation.result.completedBy,
            completedAt: summary.delegation.result.completedAt,
          },
    errorPreview:
      summary.delegation.error === null
        ? null
        : boundedPreview(summary.delegation.error, VM_AGENT_DELEGATION_OUTPUT_PREVIEW_MAX_LENGTH),
  },
  rootAgent: summary.rootAgent === null ? null : compactIdentity(summary.rootAgent),
  sourceAgent: summary.sourceAgent === null ? null : compactIdentity(summary.sourceAgent),
  targetAgent: summary.targetAgent === null ? null : compactIdentity(summary.targetAgent),
  latestMessage:
    summary.latestMessage === null
      ? null
      : {
          ...summary.latestMessage,
          ...boundedPreview(
            summary.latestMessage.text,
            VM_AGENT_DELEGATION_MESSAGE_PREVIEW_MAX_LENGTH,
          ),
        },
});

/** Converts a pre-compact server snapshot while retaining absence of the capability marker. */
export function normalizeVmAgentCollaborationStreamItem(
  item: VmAgentCollaborationWireStreamItem,
): VmAgentCollaborationStreamItem {
  if (item.type === "resync-required") return item;
  if ("compact" in item && item.compact === true) return item;
  const legacy = item as VmAgentLegacyCollaborationSnapshot;
  return {
    type: "snapshot",
    ...(legacy.hasMoreAgents === undefined ? {} : { hasMoreAgents: legacy.hasMoreAgents }),
    ...(legacy.hasMoreDelegations === undefined
      ? {}
      : { hasMoreDelegations: legacy.hasMoreDelegations }),
    agents: legacy.agents,
    delegations: legacy.delegations.map(normalizeLegacyDelegation),
  } satisfies VmAgentCollaborationSnapshot;
}

/**
 * Old servers do not publish scheduler-owned collaboration revisions. Poll by
 * reopening only those legacy subscriptions; compact-capable servers remain
 * fully push-driven.
 */
export function resubscribeLegacyCollaborationStream<E, R>(
  stream: Stream.Stream<VmAgentCollaborationWireStreamItem, E, R>,
): Stream.Stream<VmAgentCollaborationStreamItem, E, R> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const mode = yield* Ref.make<"unknown" | "legacy" | "compact">("unknown");
      const legacyDetected = yield* Deferred.make<void>();
      const compactDetected = yield* Deferred.make<void>();

      const observeSnapshotMode = (item: VmAgentCollaborationStreamItem) => {
        if (item.type !== "snapshot") return Effect.void;
        return Effect.gen(function* () {
          const current = yield* Ref.get(mode);
          // Capability is sticky for the lifetime of this subscription. A
          // compact host must never regain the legacy timer because of a stale
          // or malformed item delivered during a rolling upgrade.
          if (current === "compact") return;
          if (item.compact === true) {
            yield* Ref.set(mode, "compact");
            yield* Deferred.succeed(compactDetected, undefined);
            return;
          }
          if (current === "unknown") {
            yield* Ref.set(mode, "legacy");
            yield* Deferred.succeed(legacyDetected, undefined);
          }
        });
      };

      // Do not create the periodic clock until a legacy snapshot has actually
      // arrived. This prevents a slow first snapshot from being cancelled and
      // leaves compact subscriptions with no dormant interval wakeups.
      const legacyRefreshes = Stream.fromEffect(Deferred.await(legacyDetected)).pipe(
        Stream.flatMap(() =>
          Stream.tick(Duration.millis(LEGACY_COLLABORATION_REFRESH_INTERVAL_MS)).pipe(
            Stream.drop(1),
          ),
        ),
        Stream.interruptWhen(Deferred.await(compactDetected)),
        Stream.map(() => undefined),
      );

      return Stream.merge(Stream.make(undefined), legacyRefreshes).pipe(
        Stream.switchMap(() =>
          stream.pipe(
            Stream.map(normalizeVmAgentCollaborationStreamItem),
            Stream.tap(observeSnapshotMode),
          ),
        ),
      );
    }),
  );
}

/**
 * A host whose legacy full-row snapshot exceeds the stream budget can emit a
 * terminal resync marker before any usable value. Retry those markers with a
 * finite capped backoff instead of spinning forever. Any successful snapshot
 * resets the consecutive budget, and an exhausted stream fails with a clear
 * upgrade action while the subscription atom retains its previous success.
 */
export function resubscribeCollaborationOnTerminalResync<
  A extends VmAgentCollaborationStreamItem,
  E,
  R,
>(stream: Stream.Stream<A, E, R>): Stream.Stream<Exclude<A, { type: "resync-required" }>, E, R> {
  return Stream.unwrap(
    Ref.make(0).pipe(
      Effect.map(
        (consecutiveResyncs) =>
          stream.pipe(
            Stream.rechunk(1),
            Stream.takeUntilEffect(
              (item) => {
                if (item.type === "snapshot") {
                  return Ref.set(consecutiveResyncs, 0).pipe(Effect.as(false));
                }
                return Ref.updateAndGet(consecutiveResyncs, (count) => count + 1).pipe(
                  Effect.flatMap((count) =>
                    count > MAX_CONSECUTIVE_COLLABORATION_RESYNCS
                      ? Effect.die(collaborationResyncExhaustedError())
                      : Effect.sleep(Duration.millis(collaborationResyncBackoffMs(count))).pipe(
                          Effect.as(true),
                        ),
                  ),
                );
              },
              { excludeLast: true },
            ),
            Stream.repeat(Schedule.forever),
          ) as Stream.Stream<Exclude<A, { type: "resync-required" }>, E, R>,
      ),
    ),
  );
}

export function applyVmAgentRegistryEvent(
  view: VmAgentRegistryView,
  event: VmAgentStreamEvent,
): VmAgentRegistryView {
  if (event.type === "snapshot") return event;
  if (event.type === "remove") {
    return {
      type: "snapshot",
      agents: view.agents.filter((agent) => agent.vmAgentId !== event.vmAgentId),
    };
  }

  const existingIndex = view.agents.findIndex((agent) => agent.vmAgentId === event.agent.vmAgentId);
  return {
    type: "snapshot",
    agents:
      existingIndex === -1
        ? [...view.agents, event.agent]
        : view.agents.map((agent, index) => (index === existingIndex ? event.agent : agent)),
  };
}

/**
 * Mobile browsers can preserve a WebSocket while silently dropping an
 * individual subscription during suspension. Reopen these lightweight VM
 * metadata streams whenever the app becomes active, even if the supervisor
 * still considers the underlying connection healthy.
 */
export function resubscribeVmStreamOnApplicationActive<A, E, R>(
  stream: Stream.Stream<A, E, R>,
): Stream.Stream<A, E, R> {
  return Stream.unwrap(
    Effect.serviceOption(ConnectionWakeups.ConnectionWakeups).pipe(
      Effect.map(
        (
          wakeups: Option.Option<ConnectionWakeups.ConnectionWakeups["Service"]>,
        ): Stream.Stream<A, E, R> =>
          Option.match(wakeups, {
            onNone: () => stream,
            onSome: (wakeups) =>
              Stream.merge(
                Stream.make(undefined),
                wakeups.changes.pipe(
                  Stream.filter((reason) => reason === "application-active"),
                  Stream.map(() => undefined),
                ),
              ).pipe(Stream.switchMap(() => stream)),
          }),
      ),
    ),
  );
}

/**
 * Agent Stack environment atoms.
 *
 * The registry stream (`vmAgent.subscribe`) starts with a full snapshot and can
 * carry live updates. Every agent stream can also request a resync when a slow
 * remote client falls behind, so each one reopens the cold RPC stream and waits
 * for its next authoritative snapshot. Lifecycle mutations are serialized per
 * agent so a rapid create/delete can't race.
 */
export function createVmAgentEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const lifecycleScheduler = createAtomCommandScheduler();
  const workspaceScheduler = createAtomCommandScheduler();
  const collaborationScheduler = createAtomCommandScheduler();
  const perAgentSerial = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { vmAgentId: string } }) =>
      JSON.stringify([environmentId, input.vmAgentId]),
  };
  const collaboration = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:vm-agents:collaboration",
    tag: WS_METHODS.vmAgentCollaborationSubscribe,
    transform: (stream) =>
      resubscribeVmStreamOnApplicationActive(
        resubscribeCollaborationOnTerminalResync(resubscribeLegacyCollaborationStream(stream)),
      ),
  });
  const delegation = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:vm-agents:delegation",
    tag: WS_METHODS.vmAgentCollaborationGet,
    staleTimeMs: 2_000,
    idleTtlMs: 60_000,
  });

  return {
    // Keyed by the empty payload — one registry stream per environment.
    agents: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:vm-agents:registry",
      tag: WS_METHODS.vmAgentSubscribe,
      transform: (stream) =>
        resubscribeVmStreamOnApplicationActive(resubscribeOnTerminalResync(stream)).pipe(
          Stream.scan(INITIAL_AGENT_REGISTRY_VIEW, applyVmAgentRegistryEvent),
        ),
    }),
    workspace: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:vm-agents:workspace",
      tag: WS_METHODS.vmAgentWorkspaceSubscribe,
      transform: (stream) =>
        resubscribeVmStreamOnApplicationActive(resubscribeOnTerminalResync(stream)),
    }),
    attention: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:vm-agents:attention",
      tag: WS_METHODS.vmAgentAttentionSubscribe,
      transform: (stream) =>
        resubscribeVmStreamOnApplicationActive(resubscribeOnTerminalResync(stream)),
    }),
    collaboration: (target: {
      readonly environmentId: Parameters<typeof collaboration>[0]["environmentId"];
      readonly input: Record<string, never>;
    }) =>
      collaboration({
        environmentId: target.environmentId,
        input: { compact: true },
      }),
    delegation: (target: {
      readonly environmentId: Parameters<typeof delegation>[0]["environmentId"];
      readonly input: Omit<Parameters<typeof delegation>[0]["input"], "paged">;
    }) =>
      delegation({
        environmentId: target.environmentId,
        input: { ...target.input, paged: true },
      }),
    sendDelegationMessage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vm-agents:delegation-send-message",
      tag: WS_METHODS.vmAgentCollaborationSendMessage,
      scheduler: collaborationScheduler,
    }),
    cancelDelegation: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vm-agents:delegation-cancel",
      tag: WS_METHODS.vmAgentCollaborationCancel,
      scheduler: collaborationScheduler,
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vm-agents:create",
      tag: WS_METHODS.vmAgentCreate,
      scheduler: lifecycleScheduler,
    }),
    builderOpen: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vm-agents:builder-open",
      tag: WS_METHODS.vmAgentBuilderOpen,
      scheduler: lifecycleScheduler,
    }),
    delete: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vm-agents:delete",
      tag: WS_METHODS.vmAgentDelete,
      scheduler: lifecycleScheduler,
      concurrency: perAgentSerial,
    }),
    createTask: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vm-agents:task-create",
      tag: WS_METHODS.vmAgentTaskCreate,
      scheduler: workspaceScheduler,
      concurrency: perAgentSerial,
    }),
    updateTask: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vm-agents:task-update",
      tag: WS_METHODS.vmAgentTaskUpdate,
      scheduler: workspaceScheduler,
      concurrency: perAgentSerial,
    }),
    deleteTask: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vm-agents:task-delete",
      tag: WS_METHODS.vmAgentTaskDelete,
      scheduler: workspaceScheduler,
      concurrency: perAgentSerial,
    }),
    runTaskNow: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vm-agents:task-run-now",
      tag: WS_METHODS.vmAgentTaskRunNow,
      scheduler: workspaceScheduler,
      concurrency: perAgentSerial,
    }),
    generateTaskPrompt: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vm-agents:task-generate-prompt",
      tag: WS_METHODS.vmAgentTaskGeneratePrompt,
      scheduler: workspaceScheduler,
      concurrency: perAgentSerial,
    }),
    markNotificationRead: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vm-agents:notification-read",
      tag: WS_METHODS.vmAgentNotificationMarkRead,
      scheduler: workspaceScheduler,
      concurrency: perAgentSerial,
    }),
    updateNotification: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vm-agents:notification-update",
      tag: WS_METHODS.vmAgentNotificationUpdate,
      scheduler: workspaceScheduler,
      concurrency: perAgentSerial,
    }),
    resolveBlocker: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vm-agents:blocker-resolve",
      tag: WS_METHODS.vmAgentBlockerResolve,
      scheduler: workspaceScheduler,
      concurrency: perAgentSerial,
    }),
    updateNotificationPreferences: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vm-agents:notification-preferences",
      tag: WS_METHODS.vmAgentNotificationPreferencesUpdate,
      scheduler: workspaceScheduler,
      concurrency: perAgentSerial,
    }),
  };
}
