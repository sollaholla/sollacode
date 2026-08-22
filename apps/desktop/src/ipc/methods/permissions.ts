import {
  DESKTOP_PERMISSIONS_ONBOARDING_VERSION,
  DesktopPermissionActionInputSchema,
  DesktopPermissionsSnapshotSchema,
  type DesktopPermissionsSnapshot,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import {
  makeLiveMacPermissionRuntime,
  openMacPermissionSettings,
  readMacPermissionStates,
  requestMacPermission,
} from "../../permissions/DesktopPermissions.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const readSnapshot = Effect.fn("desktop.permissions.readSnapshot")(function* () {
  const platform = yield* HostProcessPlatform;
  const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const settings = yield* appSettings.get;
  if (platform !== "darwin") {
    return {
      supported: false,
      onboardingVersion: settings.permissionSetupVersion,
      onboardingRequired: false,
      permissions: [],
    } satisfies DesktopPermissionsSnapshot;
  }

  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const permissions = yield* readMacPermissionStates(
    makeLiveMacPermissionRuntime(environment.homeDirectory),
  );
  return {
    supported: true,
    onboardingVersion: settings.permissionSetupVersion,
    onboardingRequired: settings.permissionSetupVersion < DESKTOP_PERMISSIONS_ONBOARDING_VERSION,
    permissions: [...permissions],
  } satisfies DesktopPermissionsSnapshot;
});

export const getDesktopPermissions = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_DESKTOP_PERMISSIONS_CHANNEL,
  payload: Schema.Void,
  result: DesktopPermissionsSnapshotSchema,
  handler: readSnapshot,
});

export const requestDesktopPermission = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REQUEST_DESKTOP_PERMISSION_CHANNEL,
  payload: DesktopPermissionActionInputSchema,
  result: DesktopPermissionsSnapshotSchema,
  handler: Effect.fn("desktop.permissions.request")(function* ({ id }) {
    const platform = yield* HostProcessPlatform;
    if (platform === "darwin") {
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      yield* Effect.promise(() =>
        requestMacPermission(makeLiveMacPermissionRuntime(environment.homeDirectory), id),
      );
    }
    return yield* readSnapshot();
  }),
});

export const openDesktopPermissionSettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_DESKTOP_PERMISSION_SETTINGS_CHANNEL,
  payload: DesktopPermissionActionInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.permissions.openSystemSettings")(function* ({ id }) {
    const platform = yield* HostProcessPlatform;
    if (platform !== "darwin") return;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    yield* Effect.promise(() =>
      openMacPermissionSettings(makeLiveMacPermissionRuntime(environment.homeDirectory), id),
    );
  }),
});

export const completeDesktopPermissionsOnboarding = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPLETE_DESKTOP_PERMISSIONS_ONBOARDING_CHANNEL,
  payload: Schema.Void,
  result: DesktopPermissionsSnapshotSchema,
  handler: Effect.fn("desktop.permissions.completeOnboarding")(function* () {
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    yield* appSettings.setPermissionSetupVersion(DESKTOP_PERMISSIONS_ONBOARDING_VERSION);
    return yield* readSnapshot();
  }),
});

export const relaunchForDesktopPermissions = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RELAUNCH_FOR_DESKTOP_PERMISSIONS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.permissions.relaunch")(function* () {
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    yield* lifecycle.relaunch("permissions-changed");
  }),
});
