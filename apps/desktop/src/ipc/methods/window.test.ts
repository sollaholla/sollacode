import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type * as Electron from "electron";

import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as ElectronShell from "../../electron/ElectronShell.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import {
  getLocalEnvironmentBootstraps,
  getWindowFullscreenState,
  revealFile,
  writeComposerClipboard,
} from "./window.ts";

const readyWslConfig: DesktopBackendManager.DesktopBackendStartConfig = {
  executablePath: "wsl.exe",
  args: ["-d", "Ubuntu", "--", "node", "/app/bin.mjs"],
  entryPath: "/app/bin.mjs",
  cwd: "/app",
  env: {},
  extendEnv: false,
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3774,
    host: "0.0.0.0",
    desktopBootstrapToken: "bootstrap-token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  bootstrapDelivery: "stdin",
  httpBaseUrl: new URL("http://127.0.0.1:3774"),
  captureOutput: true,
  preflightFailure: Option.none(),
  runningDistro: "Ubuntu",
};

const defaultWslInstance: DesktopBackendManager.DesktopBackendInstance = {
  id: DesktopBackendManager.BackendInstanceId("wsl:default"),
  label: Effect.succeed("WSL (default distro)"),
  start: Effect.void,
  stop: () => Effect.void,
  currentConfig: Effect.succeed(Option.some(readyWslConfig)),
  snapshot: Effect.succeed({
    desiredRunning: true,
    ready: true,
    activePid: Option.some(123),
    restartAttempt: 0,
    restartScheduled: false,
  }),
  waitForReady: () => Effect.succeed(true),
};

describe("getLocalEnvironmentBootstraps", () => {
  it.effect("publishes the concrete running distro without replacing the stable instance id", () =>
    Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();

      assert.deepEqual(result, [
        {
          id: "wsl:default",
          label: "WSL (Ubuntu)",
          runningDistro: "Ubuntu",
          httpBaseUrl: "http://127.0.0.1:3774/",
          wsBaseUrl: "ws://127.0.0.1:3774/",
          bootstrapToken: "bootstrap-token",
        },
      ]);
    }).pipe(Effect.provide(DesktopBackendPool.layerTest([defaultWslInstance]))),
  );

  it.effect("publishes a pending bootstrap only while a transient retry is scheduled", () => {
    const retryingConfig: DesktopBackendManager.DesktopBackendStartConfig = {
      ...readyWslConfig,
      preflightFailure: Option.some({
        reason: "WSL probe timed out",
        fatal: false,
        retryLimit: 12,
      }),
    };
    const retryingInstance: DesktopBackendManager.DesktopBackendInstance = {
      ...defaultWslInstance,
      currentConfig: Effect.succeed(Option.some(retryingConfig)),
      snapshot: Effect.succeed({
        desiredRunning: true,
        ready: false,
        activePid: Option.none(),
        restartAttempt: 2,
        restartScheduled: true,
      }),
    };

    return Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();
      assert.deepEqual(result, [
        {
          id: "wsl:default",
          label: "WSL (default distro)",
          runningDistro: null,
          httpBaseUrl: null,
          wsBaseUrl: null,
        },
      ]);
    }).pipe(Effect.provide(DesktopBackendPool.layerTest([retryingInstance])));
  });

  it.effect("omits a bounded transient bootstrap after retries stop", () => {
    const stoppedInstance: DesktopBackendManager.DesktopBackendInstance = {
      ...defaultWslInstance,
      currentConfig: Effect.succeed(
        Option.some({
          ...readyWslConfig,
          preflightFailure: Option.some({
            reason: "WSL probe timed out",
            fatal: false,
            retryLimit: 12,
          }),
        }),
      ),
      snapshot: Effect.succeed({
        desiredRunning: false,
        ready: false,
        activePid: Option.none(),
        restartAttempt: 12,
        restartScheduled: false,
      }),
    };

    return Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();
      assert.deepEqual(result, []);
    }).pipe(Effect.provide(DesktopBackendPool.layerTest([stoppedInstance])));
  });
});

describe("getWindowFullscreenState", () => {
  it.effect("reads the current native window state", () => {
    const window = { isFullScreen: () => true } as Electron.BrowserWindow;

    return Effect.gen(function* () {
      assert.isTrue(yield* getWindowFullscreenState.handler());
    }).pipe(
      Effect.provide(
        Layer.mock(ElectronWindow.ElectronWindow)({
          currentMainOrFirst: Effect.succeed(Option.some(window)),
          // Plain function rather than an Effect, so `Layer.mock` cannot stub it.
          isAuxiliaryWindowId: () => false,
        }),
      ),
    );
  });
});

describe("writeComposerClipboard", () => {
  it.effect("validates the IPC payload and delegates the atomic native write", () => {
    let received:
      | Parameters<ElectronShell.ElectronShell["Service"]["writeComposerClipboard"]>[0]
      | null = null;

    return Effect.gen(function* () {
      const result = yield* writeComposerClipboard.handler({
        text: "move this",
        html: '<div data-solla-composer-transfer="solla-token">move this</div>',
        imagePng: new Uint8Array([1, 2, 3]),
      });

      assert.isTrue(result);
      assert.deepEqual(received, {
        text: "move this",
        html: '<div data-solla-composer-transfer="solla-token">move this</div>',
        imagePng: new Uint8Array([1, 2, 3]),
      });
    }).pipe(
      Effect.provide(
        Layer.mock(ElectronShell.ElectronShell)({
          writeComposerClipboard: (input) =>
            Effect.sync(() => {
              received = input;
              return true;
            }),
        }),
      ),
    );
  });
});

describe("revealFile", () => {
  const provideRevealFile = (input: {
    readonly exists: boolean;
    readonly revealedPaths: Array<string>;
  }) =>
    Layer.mergeAll(
      FileSystem.layerNoop({
        exists: () => Effect.succeed(input.exists),
      }),
      Path.layer,
      Layer.mock(ElectronShell.ElectronShell)({
        revealFile: (path) =>
          Effect.sync(() => {
            input.revealedPaths.push(path);
          }),
      }),
    );

  it.effect("reveals an existing absolute path and reports success", () => {
    const revealedPaths: Array<string> = [];

    return Effect.gen(function* () {
      assert.isTrue(yield* revealFile.handler("/tmp/clip.mp4"));
      assert.deepEqual(revealedPaths, ["/tmp/clip.mp4"]);
    }).pipe(Effect.provide(provideRevealFile({ exists: true, revealedPaths })));
  });

  it.effect("reports a missing file without invoking the shell", () => {
    const revealedPaths: Array<string> = [];

    return Effect.gen(function* () {
      assert.isFalse(yield* revealFile.handler("/tmp/missing.mp4"));
      assert.deepEqual(revealedPaths, []);
    }).pipe(Effect.provide(provideRevealFile({ exists: false, revealedPaths })));
  });

  it.effect("rejects a relative path before invoking the shell", () => {
    const revealedPaths: Array<string> = [];

    return Effect.gen(function* () {
      assert.isFalse(yield* revealFile.handler("relative/clip.mp4"));
      assert.deepEqual(revealedPaths, []);
    }).pipe(Effect.provide(provideRevealFile({ exists: true, revealedPaths })));
  });
});
