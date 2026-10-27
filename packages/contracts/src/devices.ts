import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** iOS simulators (Xcode) and Android emulators (Android SDK) on the environment's machine. */
export const DevicePlatform = Schema.Literals(["ios", "android"]);
export type DevicePlatform = typeof DevicePlatform.Type;

export const DeviceKind = Schema.Literals(["phone", "tablet"]);
export type DeviceKind = typeof DeviceKind.Type;

/** Power state, folded from what simctl and adb report. */
export const DeviceState = Schema.Literals(["off", "starting", "on", "stopping"]);
export type DeviceState = typeof DeviceState.Type;

export const DeviceSummary = Schema.Struct({
  platform: DevicePlatform,
  /** iOS: the simulator's UDID. Android: the emulator's AVD name. */
  id: TrimmedNonEmptyString,
  name: Schema.String,
  /** Hardware model, such as "iPhone 17 Pro" or "Pixel 9". */
  model: Schema.NullOr(Schema.String),
  /** Operating system, such as "iOS 26.5" or "Android 16". */
  system: Schema.NullOr(Schema.String),
  kind: DeviceKind,
  state: DeviceState,
});
export type DeviceSummary = typeof DeviceSummary.Type;

export const DevicePlatformStatus = Schema.Struct({
  platform: DevicePlatform,
  available: Schema.Boolean,
  /** Why the platform can't be used here, written for the person who can fix it. */
  detail: Schema.NullOr(Schema.String),
});
export type DevicePlatformStatus = typeof DevicePlatformStatus.Type;

export const DeviceListResult = Schema.Struct({
  platforms: Schema.Array(DevicePlatformStatus),
  devices: Schema.Array(DeviceSummary),
});
export type DeviceListResult = typeof DeviceListResult.Type;

/** A hardware model a new device can be created as, newest first. */
export const DeviceModelOption = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: DeviceKind,
});
export type DeviceModelOption = typeof DeviceModelOption.Type;

/** An installed operating system a new device can run, newest first. */
export const DeviceSystemOption = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** Models this system supports. Empty means it runs on every listed model. */
  modelIds: Schema.Array(Schema.String),
});
export type DeviceSystemOption = typeof DeviceSystemOption.Type;

export const DevicePlatformCatalog = Schema.Struct({
  platform: DevicePlatform,
  models: Schema.Array(DeviceModelOption),
  systems: Schema.Array(DeviceSystemOption),
  /** Why new devices can't be added on this platform yet, when they can't. */
  detail: Schema.NullOr(Schema.String),
});
export type DevicePlatformCatalog = typeof DevicePlatformCatalog.Type;

export const DeviceCatalog = Schema.Struct({
  platforms: Schema.Array(DevicePlatformCatalog),
});
export type DeviceCatalog = typeof DeviceCatalog.Type;

export const DeviceRef = Schema.Struct({
  platform: DevicePlatform,
  id: TrimmedNonEmptyString,
});
export type DeviceRef = typeof DeviceRef.Type;

export const DeviceCreateInput = Schema.Struct({
  platform: DevicePlatform,
  name: TrimmedNonEmptyString,
  modelId: TrimmedNonEmptyString,
  systemId: TrimmedNonEmptyString,
});
export type DeviceCreateInput = typeof DeviceCreateInput.Type;

export const DevicePowerInput = Schema.Struct({
  platform: DevicePlatform,
  id: TrimmedNonEmptyString,
  on: Schema.Boolean,
});
export type DevicePowerInput = typeof DevicePowerInput.Type;

/**
 * A live, controllable view of a device. The URL is served on the
 * environment's own loopback interface, so only a browser tab rendered on that
 * machine (the desktop app's browser panel) can load it; other clients watch
 * that tab.
 */
export const DeviceViewResult = Schema.Struct({
  url: Schema.String,
});
export type DeviceViewResult = typeof DeviceViewResult.Type;

export class DeviceError extends Schema.TaggedErrorClass<DeviceError>()("DeviceError", {
  message: Schema.String,
}) {}
