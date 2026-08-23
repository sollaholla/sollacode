import {
  WS_METHODS,
  type VmAgent,
  type VmAgentStreamEvent,
  type VmControlMode,
  type VmScreenFrame,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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
 * Folded live-screen state. The raw stream interleaves frames and takeover
 * control events; the atom only ever holds one latest value, so we scan the
 * stream into this combined view to keep the last frame across control events.
 */
export interface VmScreenView {
  readonly frame: VmScreenFrame | null;
  readonly controlMode: VmControlMode;
}

const INITIAL_SCREEN_VIEW: VmScreenView = { frame: null, controlMode: "agent" };

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
 * carry live updates. Every VM stream can also request a resync when a slow
 * remote client falls behind, so each one reopens the cold RPC stream and waits
 * for its next authoritative snapshot/control state. Lifecycle mutations are
 * serialized per agent so a rapid start/stop/delete can't race.
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
    screen: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:vm-agents:screen",
      tag: WS_METHODS.vmAgentSubscribeScreen,
      // The screen is a live view, not cached data: drop it as soon as nobody
      // is watching so the server can wind the frame pump down.
      idleTtlMs: 0,
      transform: (stream) =>
        resubscribeVmStreamOnApplicationActive(resubscribeOnTerminalResync(stream)).pipe(
          Stream.scan(INITIAL_SCREEN_VIEW, (view: VmScreenView, item): VmScreenView => {
            if (item.type === "frame") return { frame: item, controlMode: view.controlMode };
            if (item.type === "control")
              return { frame: view.frame, controlMode: item.controlMode };
            return view;
          }),
        ),
    }),
    workspace: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:vm-agents:workspace",
      tag: WS_METHODS.vmAgentWorkspaceSubscribe,
      transform: (stream) =>
        resubscribeVmStreamOnApplicationActive(resubscribeOnTerminalResync(stream)),
    }),
    collaboration: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:vm-agents:collaboration",
      tag: WS_METHODS.vmAgentCollaborationSubscribe,
      transform: (stream) =>
        resubscribeVmStreamOnApplicationActive(resubscribeOnTerminalResync(stream)),
    }),
    delegation: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:vm-agents:delegation",
      tag: WS_METHODS.vmAgentCollaborationGet,
      staleTimeMs: 2_000,
      idleTtlMs: 60_000,
      refreshIntervalMs: 5_000,
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
    builderCreate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vm-agents:builder-create",
      tag: WS_METHODS.vmAgentBuilderCreate,
      scheduler: lifecycleScheduler,
    }),
    delete: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vm-agents:delete",
      tag: WS_METHODS.vmAgentDelete,
      scheduler: lifecycleScheduler,
      concurrency: perAgentSerial,
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vm-agents:start",
      tag: WS_METHODS.vmAgentStart,
      scheduler: lifecycleScheduler,
      concurrency: perAgentSerial,
    }),
    stop: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vm-agents:stop",
      tag: WS_METHODS.vmAgentStop,
      scheduler: lifecycleScheduler,
      concurrency: perAgentSerial,
    }),
    setControlMode: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vm-agents:set-control-mode",
      tag: WS_METHODS.vmAgentSetControlMode,
      scheduler: lifecycleScheduler,
      concurrency: perAgentSerial,
    }),
    // Takeover input is high-frequency and fire-and-forget: no per-agent
    // serialization (that would queue pointer moves behind each other and lag),
    // and the WS transport already preserves order.
    sendInput: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vm-agents:send-input",
      tag: WS_METHODS.vmAgentSendInput,
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
    updateNotificationPreferences: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vm-agents:notification-preferences",
      tag: WS_METHODS.vmAgentNotificationPreferencesUpdate,
      scheduler: workspaceScheduler,
      concurrency: perAgentSerial,
    }),
  };
}
