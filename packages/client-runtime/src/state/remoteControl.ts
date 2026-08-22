import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createRemoteControlEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const hostScheduler = createAtomCommandScheduler();
  const controllerScheduler = createAtomCommandScheduler();

  return {
    hostEvents: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:remote-control:host-events",
      tag: WS_METHODS.remoteControlHostConnect,
      idleTtlMs: 0,
    }),
    watch: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:remote-control:watch",
      tag: WS_METHODS.remoteControlWatch,
      idleTtlMs: 0,
    }),
    requestAccess: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:remote-control:request-access",
      tag: WS_METHODS.remoteControlRequestAccess,
      scheduler: controllerScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.clientId]),
      },
    }),
    // Serial per session: inputs carry a monotonic sequence and the broker
    // silently drops anything that arrives with an older one, so two
    // concurrent sends racing each other over the wire turn into dropped
    // keystrokes and clicks that never land. FIFO delivery is the contract.
    sendInput: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:remote-control:send-input",
      tag: WS_METHODS.remoteControlSendInput,
      scheduler: controllerScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.sessionId]),
      },
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:remote-control:cancel",
      tag: WS_METHODS.remoteControlCancel,
      scheduler: controllerScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.sessionId]),
      },
    }),
    respondToRequest: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:remote-control:host-respond",
      tag: WS_METHODS.remoteControlHostRespond,
      scheduler: hostScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.connectionId, input.requestId]),
      },
    }),
    publishFrame: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:remote-control:host-publish-frame",
      tag: WS_METHODS.remoteControlHostPublishFrame,
      scheduler: hostScheduler,
      concurrency: {
        mode: "latest",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.frame.sessionId]),
      },
    }),
    // Serial, not "latest": a video container is continuous, so a cancelled or
    // reordered chunk corrupts every chunk after it. Frames can be dropped
    // freely; chunks cannot.
    publishVideoChunk: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:remote-control:host-publish-video-chunk",
      tag: WS_METHODS.remoteControlHostPublishVideoChunk,
      scheduler: hostScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.chunk.sessionId]),
      },
    }),
    // "latest" because only the newest state matters: a status that was
    // superseded while in flight describes a condition that has already passed.
    reportHostStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:remote-control:host-report-status",
      tag: WS_METHODS.remoteControlHostReportStatus,
      scheduler: hostScheduler,
      concurrency: {
        mode: "latest",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.sessionId]),
      },
    }),
    endByHost: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:remote-control:host-end",
      tag: WS_METHODS.remoteControlHostEnd,
      scheduler: hostScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.sessionId]),
      },
    }),
  };
}
