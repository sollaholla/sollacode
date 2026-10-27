import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createAtomCommandScheduler, createEnvironmentRpcCommand } from "./runtime.ts";

/**
 * iOS simulators and Android emulators on an environment's machine. Changes to
 * one device run in order, so a quick Start then Shut down can't cross.
 */
export function createDeviceEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const perDevice = {
    mode: "serial" as const,
    key: ({
      environmentId,
      input,
    }: {
      environmentId: string;
      input: { platform: string; id: string };
    }) => JSON.stringify([environmentId, input.platform, input.id]),
  };
  return {
    list: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:devices:list",
      tag: WS_METHODS.devicesList,
      scheduler,
      concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    }),
    catalog: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:devices:catalog",
      tag: WS_METHODS.devicesCatalog,
      scheduler,
      concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:devices:create",
      tag: WS_METHODS.devicesCreate,
      scheduler,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:devices:delete",
      tag: WS_METHODS.devicesDelete,
      scheduler,
      concurrency: perDevice,
    }),
    setPower: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:devices:set-power",
      tag: WS_METHODS.devicesSetPower,
      scheduler,
      concurrency: perDevice,
    }),
    view: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:devices:view",
      tag: WS_METHODS.devicesView,
      scheduler,
      concurrency: perDevice,
    }),
  };
}
