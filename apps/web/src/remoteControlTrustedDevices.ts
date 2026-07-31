import {
  RemoteControlDeviceId,
  RemoteControlCapability,
  type EnvironmentId,
  type RemoteControlCapability as RemoteControlCapabilityType,
  type RemoteControlDeviceId as RemoteControlDeviceIdType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

const REMOTE_CONTROL_TRUST_STORAGE_PREFIX = "solla:remote-control:trusted-devices:v1";
const MAX_REMEMBERED_REMOTE_CONTROL_DEVICES = 64;
const RememberedRemoteControlDevice = Schema.Struct({
  deviceId: RemoteControlDeviceId,
  capabilities: Schema.Array(RemoteControlCapability),
});
type RememberedRemoteControlDevice = typeof RememberedRemoteControlDevice.Type;
const RememberedRemoteControlDevices = Schema.Array(RememberedRemoteControlDevice);

export function remoteControlTrustStorageKey(environmentId: EnvironmentId): string {
  return `${REMOTE_CONTROL_TRUST_STORAGE_PREFIX}:${environmentId}`;
}

export function readRememberedRemoteControlDevices(
  environmentId: EnvironmentId,
): ReadonlyArray<RememberedRemoteControlDevice> {
  try {
    return (
      getLocalStorageItem(
        remoteControlTrustStorageKey(environmentId),
        RememberedRemoteControlDevices,
      ) ?? []
    ).slice(0, MAX_REMEMBERED_REMOTE_CONTROL_DEVICES);
  } catch {
    return [];
  }
}

export function isRemoteControlDeviceRemembered(
  environmentId: EnvironmentId,
  deviceId: RemoteControlDeviceIdType,
  requestedCapabilities: ReadonlyArray<RemoteControlCapabilityType>,
): boolean {
  const remembered = readRememberedRemoteControlDevices(environmentId).find(
    (candidate) => candidate.deviceId === deviceId,
  );
  if (!remembered) return false;
  const capabilities = new Set(remembered.capabilities);
  return requestedCapabilities.every((capability) => capabilities.has(capability));
}

export function rememberRemoteControlDevice(
  environmentId: EnvironmentId,
  deviceId: RemoteControlDeviceIdType,
  grantedCapabilities: ReadonlyArray<RemoteControlCapabilityType>,
): boolean {
  const current = readRememberedRemoteControlDevices(environmentId);
  const next = [
    {
      deviceId,
      capabilities: [...new Set(grantedCapabilities)],
    },
    ...current.filter((candidate) => candidate.deviceId !== deviceId),
  ].slice(0, MAX_REMEMBERED_REMOTE_CONTROL_DEVICES);
  try {
    setLocalStorageItem(
      remoteControlTrustStorageKey(environmentId),
      next,
      RememberedRemoteControlDevices,
    );
    return true;
  } catch {
    return false;
  }
}
