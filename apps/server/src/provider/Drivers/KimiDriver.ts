/**
 * KimiDriver — `ProviderDriver` for the Kimi Code CLI (`kimi acp`).
 *
 * The catalog, default model, and sign-in all live in the CLI's own home
 * (`~/.kimi-code`); the driver reads them through `kimi provider list` and an
 * ACP `authenticate` check, and never opens a Kimi session to do so.
 *
 * Auxiliary text generation is not offered: every Kimi call is a session in
 * the person's own Kimi history and spends their plan.
 *
 * Plan usage is read from Kimi's own `/usages` endpoint with the token Kimi
 * stores, never refreshed here (see `kimiUsage.ts`): on health checks and
 * after every turn, when Kimi has just renewed it.
 *
 * @module provider/Drivers/KimiDriver
 */
import {
  KimiSettings,
  type ServerProvider,
  type ServerProviderRuntimeCapabilities,
  TextGenerationError,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { KIMI_DRIVER_KIND, kimiBinaryPath } from "../acp/KimiAcpSupport.ts";
import { ProviderDriverError } from "../Errors.ts";
import { readKimiAccountUsage } from "../kimiUsage.ts";
import { makeKimiAdapter } from "../Layers/KimiAdapter.ts";
import {
  buildInitialKimiProviderSnapshot,
  checkKimiProviderStatus,
  enrichKimiSnapshot,
} from "../Layers/KimiProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makeScriptInstalledProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const decodeKimiSettings = Schema.decodeSync(KimiSettings);

/** Install commands are the CLI's own (`NATIVE_INSTALL_COMMAND_*` in kimi 0.28). */
const UPDATE = makeScriptInstalledProviderMaintenanceResolver({
  provider: KIMI_DRIVER_KIND,
  update: {
    executable: (options) => kimiBinaryPath({ binaryPath: options?.binaryPath ?? "" }),
    args: ["upgrade"],
    lockKey: "kimi-code",
  },
  installScript: {
    lockKey: "kimi-code-install",
    posix: {
      executable: "bash",
      args: ["-lc", "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash"],
    },
    windows: {
      executable: "powershell",
      args: ["-NoProfile", "-Command", "irm https://code.kimi.com/kimi-code/install.ps1 | iex"],
    },
  },
});

/**
 * Stated rather than left absent: Settings treats a provider without this
 * block as able to generate text and lists it as a writing model.
 */
const KIMI_RUNTIME_CAPABILITIES: ServerProviderRuntimeCapabilities = {
  taskStop: false,
  textGeneration: false,
  threadRollback: false,
  threadFork: false,
  modelSwitchRequiresNewThread: false,
};

const unavailableTextGeneration = (operation: string) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail: "Kimi Code auxiliary generation is unavailable.",
    }),
  );

export type KimiDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: KIMI_DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
    runtimeCapabilities: KIMI_RUNTIME_CAPABILITIES,
  });

export const KimiDriver: ProviderDriver<KimiSettings, KimiDriverEnv> = {
  driverKind: KIMI_DRIVER_KIND,
  metadata: {
    displayName: "Kimi Code",
    supportsMultipleInstances: true,
  },
  configSchema: KimiSettings,
  defaultConfig: (): KimiSettings => decodeKimiSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: KIMI_DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies KimiSettings;
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });

      const adapter = yield* makeKimiAdapter(effectiveConfig, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
        readAccountUsage: readKimiAccountUsage(processEnv),
      });

      const checkProvider = checkKimiProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<KimiSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          settings.provider.enabled
            ? buildInitialKimiProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity))
            : checkProvider,
        refreshOnCreate: effectiveConfig.enabled,
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          enrichKimiSnapshot({
            snapshot: currentSnapshot,
            maintenanceCapabilities,
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
            publishSnapshot,
            httpClient,
          }),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: KIMI_DRIVER_KIND,
              instanceId,
              detail: `Failed to build Kimi Code snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: KIMI_DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration: {
          generateCommitMessage: () => unavailableTextGeneration("generateCommitMessage"),
          generatePrContent: () => unavailableTextGeneration("generatePrContent"),
          generateBranchName: () => unavailableTextGeneration("generateBranchName"),
          generateThreadTitle: () => unavailableTextGeneration("generateThreadTitle"),
          correctVoiceTranscript: () => unavailableTextGeneration("correctVoiceTranscript"),
          generatePlanRefresh: () => unavailableTextGeneration("generatePlanRefresh"),
          generateVmAgentTaskPrompt: () => unavailableTextGeneration("generateVmAgentTaskPrompt"),
        },
      } satisfies ProviderInstance;
    }),
};
