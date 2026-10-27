import type {
  DeviceListResult,
  DevicePlatform,
  DeviceSummary,
  EnvironmentId,
} from "@t3tools/contracts";
import { isDeviceChanging } from "@t3tools/client-runtime/devices/device-logic";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useRef, useState } from "react";

import { deviceEnvironment } from "~/state/devices";
import { useAtomCommand } from "~/state/use-atom-command";

const CHANGING_REFRESH_MS = 2_000;

export function deviceKey(device: { platform: DevicePlatform; id: string }): string {
  return `${device.platform}:${device.id}`;
}

/** The message a device command failed with, ready to show. */
export function deviceFailureMessage<A, E>(
  result: AtomCommandResult<A, E>,
  fallback: string,
): string | null {
  if (result._tag !== "Failure") return null;
  const cause = squashAtomCommandFailure(result);
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/**
 * The environment's simulators and emulators. Refreshes on mount, when the
 * window regains focus, and every couple of seconds while a device is
 * starting or shutting down. Pass null to skip loading entirely.
 */
export function useDeviceList(environmentId: EnvironmentId | null) {
  const list = useAtomCommand(deviceEnvironment.list, { reportFailure: false });
  const listRef = useRef(list);
  listRef.current = list;
  const [result, setResult] = useState<DeviceListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    if (environmentId === null) return;
    setRefreshing(true);
    const outcome = await listRef.current({ environmentId, input: {} });
    setRefreshing(false);
    const failure = deviceFailureMessage(outcome, "Couldn't list devices.");
    if (failure !== null) {
      setError(failure);
      return;
    }
    if (outcome._tag === "Success") {
      setError(null);
      setResult(outcome.value);
    }
  }, [environmentId]);

  useEffect(() => {
    setResult(null);
    setError(null);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const changing = result?.devices.some(isDeviceChanging) ?? false;
  useEffect(() => {
    if (!changing) return;
    const timer = setInterval(() => void refresh(), CHANGING_REFRESH_MS);
    return () => clearInterval(timer);
  }, [changing, refresh]);

  /** Shows a state change right away, before the next refresh confirms it. */
  const patchDevice = useCallback(
    (key: string, patch: Partial<DeviceSummary> | null) =>
      setResult((current) => {
        if (current === null) return current;
        return {
          ...current,
          devices:
            patch === null
              ? current.devices.filter((device) => deviceKey(device) !== key)
              : current.devices.map((device) =>
                  deviceKey(device) === key ? { ...device, ...patch } : device,
                ),
        };
      }),
    [],
  );

  return { result, error, refreshing, refresh, patchDevice };
}
