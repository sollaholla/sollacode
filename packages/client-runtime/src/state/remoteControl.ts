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
    sendInput: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:remote-control:send-input",
      tag: WS_METHODS.remoteControlSendInput,
      scheduler: controllerScheduler,
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
