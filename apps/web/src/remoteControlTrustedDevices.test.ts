import { EnvironmentId, RemoteControlDeviceId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { removeLocalStorageItem } from "./hooks/useLocalStorage";
import {
  isRemoteControlDeviceRemembered,
  readRememberedRemoteControlDevices,
  rememberRemoteControlDevice,
  remoteControlTrustStorageKey,
} from "./remoteControlTrustedDevices";

const firstEnvironment = EnvironmentId.make("remote-control-trust-env-1");
const secondEnvironment = EnvironmentId.make("remote-control-trust-env-2");
const deviceId = RemoteControlDeviceId.make("paired-device-session-1");

afterEach(() => {
  removeLocalStorageItem(remoteControlTrustStorageKey(firstEnvironment));
  removeLocalStorageItem(remoteControlTrustStorageKey(secondEnvironment));
});

describe("remembered remote-control devices", () => {
  it("remembers a paired device only for the selected host environment", () => {
    expect(rememberRemoteControlDevice(firstEnvironment, deviceId, ["screen"])).toBe(true);
    expect(isRemoteControlDeviceRemembered(firstEnvironment, deviceId, ["screen"])).toBe(true);
    expect(isRemoteControlDeviceRemembered(firstEnvironment, deviceId, ["keyboard"])).toBe(false);
    expect(isRemoteControlDeviceRemembered(secondEnvironment, deviceId, ["screen"])).toBe(false);
  });

  it("deduplicates remembered device identities", () => {
    expect(rememberRemoteControlDevice(firstEnvironment, deviceId, ["screen"])).toBe(true);
    expect(rememberRemoteControlDevice(firstEnvironment, deviceId, ["screen"])).toBe(true);
    expect(readRememberedRemoteControlDevices(firstEnvironment)).toEqual([
      { deviceId, capabilities: ["screen"] },
    ]);
  });
});
