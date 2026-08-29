for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE") throw err;
  });
}

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

import * as NetService from "@t3tools/shared/Net";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveRemoteT3CliPackageSpec } from "@t3tools/ssh/command";
import type { RemoteT3RunnerOptions } from "@t3tools/ssh/tunnel";
import serverPackageJson from "../../server/package.json" with { type: "json" };

import * as DesktopIpc from "./ipc/DesktopIpc.ts";
import * as ElectronApp from "./electron/ElectronApp.ts";
import * as ElectronDialog from "./electron/ElectronDialog.ts";
import * as ElectronMenu from "./electron/ElectronMenu.ts";
import * as ElectronPowerMonitor from "./electron/ElectronPowerMonitor.ts";
import * as ElectronProtocol from "./electron/ElectronProtocol.ts";
import * as ElectronSafeStorage from "./electron/ElectronSafeStorage.ts";
import * as ElectronShell from "./electron/ElectronShell.ts";
import * as ElectronTheme from "./electron/ElectronTheme.ts";
import * as ElectronWindow from "./electron/ElectronWindow.ts";
import * as DesktopApp from "./app/DesktopApp.ts";
import { disabledCaptureFeatures } from "./app/DesktopCaptureCompatibility.ts";
import * as DesktopAppIdentity from "./app/DesktopAppIdentity.ts";
import * as DesktopConnectionCatalogStore from "./app/DesktopConnectionCatalogStore.ts";
import * as DesktopApplicationMenu from "./window/DesktopApplicationMenu.ts";
import * as DesktopAssets from "./app/DesktopAssets.ts";
import * as DesktopBackendConfiguration from "./backend/DesktopBackendConfiguration.ts";
import * as DesktopBackendPool from "./backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "./backend/DesktopLocalEnvironmentAuth.ts";
import * as DesktopNetworkInterfaces from "./backend/DesktopNetworkInterfaces.ts";
import * as DesktopEnvironment from "./app/DesktopEnvironment.ts";
import { resolveDesktopReleaseChannel } from "./app/DesktopReleaseChannel.ts";
import * as DesktopLifecycle from "./app/DesktopLifecycle.ts";
import * as DesktopShutdown from "./app/DesktopShutdown.ts";
import * as DesktopObservability from "./app/DesktopObservability.ts";
import * as DesktopServerExposure from "./backend/DesktopServerExposure.ts";
import * as DesktopClientSettings from "./settings/DesktopClientSettings.ts";
import * as DesktopSavedEnvironments from "./settings/DesktopSavedEnvironments.ts";
import * as DesktopAppSettings from "./settings/DesktopAppSettings.ts";
import * as DesktopShellEnvironment from "./shell/DesktopShellEnvironment.ts";
import * as DesktopSshEnvironment from "./ssh/DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "./ssh/DesktopSshPasswordPrompts.ts";
import * as DesktopState from "./app/DesktopState.ts";
import * as DesktopTelemetryPublisher from "./telemetry/DesktopTelemetryPublisher.ts";
import * as BrowserSession from "./preview/BrowserSession.ts";
import * as PreviewManager from "./preview/Manager.ts";
import * as DesktopWindow from "./window/DesktopWindow.ts";
import * as OrchestratorBubbleWindow from "./window/OrchestratorBubbleWindow.ts";
import * as DesktopWslBackend from "./wsl/DesktopWslBackend.ts";
import * as DesktopWslEnvironment from "./wsl/DesktopWslEnvironment.ts";
import * as DesktopLanDiscovery from "./network/DesktopLanDiscovery.ts";

// This must happen synchronously during module initialization. Windows shell
// environment discovery is asynchronous and can otherwise cross Electron's
// ready boundary before the capture backend override is registered.
// Must match CFBundleName in the packaged Info.plist; Chromium builds the
// cookie-encryption Keychain service name from it.
const DESKTOP_PRODUCT_NAME = "Solla Code";

const disabledCaptureFeatureList = disabledCaptureFeatures(Effect.runSync(HostProcessPlatform));
if (disabledCaptureFeatureList) {
  Electron.app.commandLine.appendSwitch("disable-features", disabledCaptureFeatureList);
}

// Align `app.getName()` with the macOS bundle name, before ready.
//
// Chromium keys its cookie store on a Keychain item named after the bundle
// (`Solla Code Safe Storage`), but Electron's `safeStorage` derives its name
// from `app.getName()`, which comes from the packaged `package.json` — here
// `solla-code`. The two disagreed, so anything that encrypted minted
// `solla-code Safe Storage` while the cookie store went on looking for a key
// that was never created. It then wrote every cookie in plaintext and
// discarded the stored ones on load, which read as the browser being signed
// out of every site in every tab and every agent.
//
// The rename has to be pinned in place: `userData` and `sessionData` default
// to `appData/<app name>`, so renaming alone relocates every cache, profile
// and cookie jar to an empty directory and loses exactly the logins this was
// meant to keep. Capture the pre-rename locations and set them back.
const desktopUserDataPath = Electron.app.getPath("userData");
const desktopSessionDataPath = Electron.app.getPath("sessionData");
Electron.app.setName(DESKTOP_PRODUCT_NAME);
Electron.app.setPath("userData", desktopUserDataPath);
Electron.app.setPath("sessionData", desktopSessionDataPath);

// Custom schemes must be registered before Electron becomes ready. Marking
// them standard and CORS-capable gives renderer assets a real same-origin
// identity instead of Chromium's opaque `null` origin.
Electron.protocol.registerSchemesAsPrivileged(
  [ElectronProtocol.DESKTOP_PRODUCTION_SCHEME, ElectronProtocol.DESKTOP_DEVELOPMENT_SCHEME].map(
    (scheme) => ({
      scheme,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    }),
  ),
);

const developmentRoot = process.argv
  .find((argument) => argument.startsWith("--t3code-dev-root="))
  ?.slice("--t3code-dev-root=".length);

const desktopEnvironmentLayer = Layer.unwrap(
  Effect.gen(function* () {
    const metadata = yield* Effect.service(ElectronApp.ElectronApp).pipe(
      Effect.flatMap((app) => app.metadata),
    );
    const platform = yield* HostProcessPlatform;
    const processArch = yield* HostProcessArchitecture;
    return DesktopEnvironment.layer({
      dirname: __dirname,
      homeDirectory: NodeOS.homedir(),
      platform,
      processArch,
      ...(developmentRoot ? { developmentRoot } : {}),
      ...metadata,
    });
  }),
);

const resolveDesktopSshCliRunner = (
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
): RemoteT3RunnerOptions => {
  const devRemoteEntryPath = Option.getOrUndefined(environment.devRemoteT3ServerEntryPath);
  if (environment.isDevelopment && devRemoteEntryPath !== undefined) {
    return {
      nodeScriptPath: devRemoteEntryPath,
      nodeEngineRange: serverPackageJson.engines.node,
    };
  }
  return {
    packageSpec: resolveRemoteT3CliPackageSpec({
      appVersion: environment.appVersion,
      releaseChannel: resolveDesktopReleaseChannel(environment.appVersion),
      isDevelopment: environment.isDevelopment,
    }),
    nodeEngineRange: serverPackageJson.engines.node,
  };
};

const desktopSshEnvironmentLayer = Layer.unwrap(
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return DesktopSshEnvironment.layer({
      resolveCliRunner: Effect.succeed(resolveDesktopSshCliRunner(environment)),
    });
  }),
);

const electronLayer = Layer.mergeAll(
  ElectronApp.layer,
  ElectronDialog.layer,
  ElectronMenu.layer,
  ElectronPowerMonitor.layer,
  ElectronProtocol.layer,
  ElectronSafeStorage.layer,
  ElectronShell.layer,
  ElectronTheme.layer,
  ElectronWindow.layer,
  DesktopIpc.layer(Electron.ipcMain),
);

const desktopFoundationLayer = Layer.mergeAll(
  DesktopState.layer,
  DesktopShutdown.layer,
  DesktopAppSettings.layer,
  DesktopClientSettings.layer,
  DesktopConnectionCatalogStore.layer.pipe(Layer.provideMerge(DesktopSavedEnvironments.layer)),
  DesktopAssets.layer,
  DesktopObservability.layer,
).pipe(Layer.provideMerge(desktopEnvironmentLayer));

const desktopSshLayer = desktopSshEnvironmentLayer.pipe(
  Layer.provideMerge(DesktopSshPasswordPrompts.layer()),
);

const desktopServerExposureLayer = DesktopServerExposure.layer.pipe(
  Layer.provideMerge(DesktopNetworkInterfaces.layer),
  Layer.provideMerge(desktopFoundationLayer),
);

const desktopPreviewLayer = PreviewManager.layer.pipe(
  Layer.provideMerge(BrowserSession.layer),
  Layer.provideMerge(desktopFoundationLayer),
);

const desktopWindowLayer = Layer.mergeAll(DesktopWindow.layer, OrchestratorBubbleWindow.layer).pipe(
  Layer.provideMerge(desktopServerExposureLayer),
  Layer.provideMerge(desktopPreviewLayer),
);

// Pool layer instantiates the backend factory once for the Windows
// primary instance and exposes it via pool.primary. Consumers go through
// the pool now; the legacy DesktopBackendManager service is gone. The
// WSL second instance gets registered later in the migration. See
// DesktopBackendPool.ts header for the full rollout plan.
const desktopBackendLayer = DesktopBackendPool.layer.pipe(
  Layer.provideMerge(DesktopAppIdentity.layer),
  Layer.provideMerge(DesktopBackendConfiguration.layer),
  Layer.provideMerge(DesktopWslEnvironment.layer),
  Layer.provideMerge(DesktopTelemetryPublisher.layer),
  Layer.provideMerge(desktopWindowLayer),
);

// WSL orchestrator hangs off the backend layer because it needs the
// pool + configuration + serverExposure; it pulls NetService and the
// foundation services through the same provideMerge chain.
const desktopWslBackendLayer = DesktopWslBackend.layer.pipe(
  Layer.provideMerge(desktopBackendLayer),
);

const desktopLocalEnvironmentAuthLayer = DesktopLocalEnvironmentAuth.layer.pipe(
  Layer.provideMerge(desktopBackendLayer),
);

const desktopLanDiscoveryLayer = DesktopLanDiscovery.layer.pipe(
  Layer.provide(desktopServerExposureLayer),
);

const desktopApplicationLayer = Layer.mergeAll(
  DesktopLifecycle.layer,
  DesktopApplicationMenu.layer,
  DesktopShellEnvironment.layer,
  desktopSshLayer,
  desktopLanDiscoveryLayer,
).pipe(
  Layer.provideMerge(desktopWslBackendLayer),
  Layer.provideMerge(desktopLocalEnvironmentAuthLayer),
);

const desktopRuntimeLayer = desktopApplicationLayer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeHttpClient.layerUndici),
  Layer.provideMerge(NetService.layer),
  Layer.provideMerge(electronLayer),
);

DesktopApp.program.pipe(Effect.provide(desktopRuntimeLayer), NodeRuntime.runMain);
