import * as NodeServices from "@effect/platform-node/NodeServices";
import { DesktopPermissionsSnapshotSchema } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopShutdown from "../../app/DesktopShutdown.ts";
import * as DesktopState from "../../app/DesktopState.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronTheme from "../../electron/ElectronTheme.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import {
  completeDesktopPermissionsOnboarding,
  getDesktopPermissions,
  relaunchForDesktopPermissions,
} from "./permissions.ts";

const settingsLayer = DesktopAppSettings.layerTest(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS);
const environmentLayer = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
  homeDirectory: "/Users/test",
} as DesktopEnvironment.DesktopEnvironment["Service"]);
const unsupportedPlatformLayer = Layer.mergeAll(
  settingsLayer,
  environmentLayer,
  NodeServices.layer,
  Layer.succeed(HostProcessPlatform, "linux"),
);
const unusedLifecycleRuntimeLayer = Layer.mergeAll(
  environmentLayer,
  Layer.succeed(DesktopShutdown.DesktopShutdown, {} as DesktopShutdown.DesktopShutdown["Service"]),
  Layer.succeed(DesktopState.DesktopState, {} as DesktopState.DesktopState["Service"]),
  Layer.succeed(DesktopWindow.DesktopWindow, {} as DesktopWindow.DesktopWindow["Service"]),
  Layer.succeed(ElectronApp.ElectronApp, {} as ElectronApp.ElectronApp["Service"]),
  Layer.succeed(ElectronTheme.ElectronTheme, {} as ElectronTheme.ElectronTheme["Service"]),
);
const decodePermissionsSnapshot = Schema.decodeUnknownEffect(DesktopPermissionsSnapshotSchema);

describe("desktop permissions IPC", () => {
  it.effect("does not gate startup on unsupported host platforms", () =>
    Effect.gen(function* () {
      const snapshot = yield* getDesktopPermissions
        .handler(undefined)
        .pipe(Effect.flatMap(decodePermissionsSnapshot));

      assert.deepEqual(snapshot, {
        supported: false,
        onboardingVersion: 0,
        onboardingRequired: false,
        permissions: [],
      });
    }).pipe(Effect.provide(unsupportedPlatformLayer)),
  );

  it.effect("persists completion before returning the refreshed snapshot", () =>
    Effect.gen(function* () {
      const snapshot = yield* completeDesktopPermissionsOnboarding
        .handler(undefined)
        .pipe(Effect.flatMap(decodePermissionsSnapshot));
      const settings = yield* DesktopAppSettings.DesktopAppSettings;

      assert.equal(snapshot.onboardingVersion, 1);
      assert.isFalse(snapshot.onboardingRequired);
      assert.equal((yield* settings.get).permissionSetupVersion, 1);
    }).pipe(Effect.provide(unsupportedPlatformLayer)),
  );

  it.effect("uses the existing lifecycle for a permission restart", () => {
    const reasons: Array<string> = [];
    const lifecycleLayer = Layer.mergeAll(
      unusedLifecycleRuntimeLayer,
      Layer.succeed(
        DesktopLifecycle.DesktopLifecycle,
        DesktopLifecycle.DesktopLifecycle.of({
          relaunch: (reason) =>
            Effect.sync(() => {
              reasons.push(reason);
            }),
          register: Effect.void,
        }),
      ),
    );
    return relaunchForDesktopPermissions.handler(undefined).pipe(
      Effect.provide(lifecycleLayer),
      Effect.tap(() => Effect.sync(() => assert.deepEqual(reasons, ["permissions-changed"]))),
    );
  });
});
