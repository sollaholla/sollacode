import { DeepCodeSettings, TextGenerationError, type ServerProvider } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { ServerConfig } from "../../config.ts";
import {
  customModelCapabilitiesFrom,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot.ts";
import { defaultProviderContinuationIdentity, type ProviderDriver } from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  DEEPCODE_BUILT_IN_MODELS,
  DEEPCODE_MODEL_CAPABILITIES,
  deepCodeHomeDir,
  deepCodeSettingsPath,
  parseDeepCodeSettingsAuth,
} from "../deepcodeProtocol.ts";
import { DEEPCODE_DRIVER_KIND } from "../deepcodeRuntime.ts";
import { makeDeepCodeAdapter } from "../Layers/DeepCodeAdapter.ts";

const decodeSettings = Schema.decodeSync(DeepCodeSettings);

const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DEEPCODE_DRIVER_KIND,
  npmPackageName: "@vegamo/deepcode-cli",
  homebrewFormula: null,
  nativeUpdate: null,
});

export type DeepCodeDriverEnv =
  | ServerConfig
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path;
export const DeepCodeDriver: ProviderDriver<DeepCodeSettings, DeepCodeDriverEnv> = {
  driverKind: DEEPCODE_DRIVER_KIND,
  metadata: { displayName: "Deep Code", supportsMultipleInstances: true },
  configSchema: DeepCodeSettings,
  defaultConfig: () => decodeSettings({}),
  create: Effect.fn("DeepCodeDriver.create")(function* (input) {
    const serverConfig = yield* ServerConfig;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const environment = mergeProviderInstanceEnvironment(input.environment);
    const binaryPath = input.config.binaryPath || "deepcode";
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DEEPCODE_DRIVER_KIND,
      instanceId: input.instanceId,
    });
    const probe = Effect.fn("DeepCodeDriver.probe")(function* (): Effect.fn.Return<ServerProvider> {
      const runProbe = Effect.fn("DeepCodeDriver.runProbe")(function* (args: string[]) {
        const command = yield* resolveSpawnCommand(binaryPath, args, { env: environment });
        return yield* spawnAndCollect(
          binaryPath,
          ChildProcess.make(command.command, command.args, {
            env: environment,
            extendEnv: false,
            shell: command.shell,
            forceKillAfter: "2 seconds",
          }),
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.timeout("15 seconds"),
          Effect.result,
        );
      });
      const versionResult = input.enabled ? yield* runProbe(["--version"]) : undefined;
      const settingsRaw = yield* fs
        .readFileString(deepCodeSettingsPath(deepCodeHomeDir(environment)))
        .pipe(Effect.orElseSucceed(() => ""));
      const settingsAuth = parseDeepCodeSettingsAuth(settingsRaw);
      const envKey = environment.DEEPCODE_API_KEY?.trim() ?? "";
      const authenticated = settingsAuth.hasApiKey || envKey.length > 0;
      const installed = versionResult?._tag === "Success";
      const versionReady = installed && versionResult.success.code === 0;
      const available = versionReady;
      const checkedAt = DateTime.formatIso(DateTime.nowUnsafe());
      const models = providerModelsFromSettings(
        DEEPCODE_BUILT_IN_MODELS,
        input.config.customModels,
        customModelCapabilitiesFrom(DEEPCODE_BUILT_IN_MODELS, DEEPCODE_MODEL_CAPABILITIES),
      );
      return {
        instanceId: input.instanceId,
        driver: DEEPCODE_DRIVER_KIND,
        displayName: input.displayName ?? "Deep Code",
        ...(input.accentColor ? { accentColor: input.accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
        badgeLabel: "DC",
        enabled: input.enabled,
        installed,
        version: versionReady ? parseGenericCliVersion(versionResult.success.stdout) : null,
        status: !input.enabled ? "disabled" : available ? "ready" : "error",
        auth: {
          status: authenticated
            ? "authenticated"
            : settingsRaw.length > 0
              ? "unauthenticated"
              : "unknown",
          ...(authenticated ? { type: "DeepSeek API key" } : {}),
        },
        checkedAt,
        message: !input.enabled
          ? "Deep Code is disabled in Solla Code settings."
          : available
            ? authenticated
              ? "Uses ~/.deepcode/settings.json. Headless --exec cannot confirm permission prompts; keep permissions.defaultMode allowAll or pre-allow the scopes the agent needs."
              : "Deep Code is installed. Add a DeepSeek API key to ~/.deepcode/settings.json (env.API_KEY), then refresh."
            : installed
              ? "Deep Code is installed, but its CLI check failed. Run deepcode --version in a terminal, then refresh."
              : "Install @vegamo/deepcode-cli (`npm install -g @vegamo/deepcode-cli`), add your DeepSeek API key to ~/.deepcode/settings.json, then refresh.",
        availability: "available",
        showInteractionModeToggle: false,
        requiresNewThreadForModelChange: false,
        models,
        slashCommands: [],
        skills: [],
        runtimeCapabilities: {
          taskStop: false,
          threadRollback: false,
          threadFork: false,
          textGeneration: false,
          modelSwitchRequiresNewThread: false,
        },
      };
    });
    const snapshotRef = yield* Ref.make(yield* probe());
    const changes = yield* Effect.acquireRelease(
      PubSub.unbounded<ServerProvider>(),
      PubSub.shutdown,
    );
    const adapter = yield* makeDeepCodeAdapter({
      instanceId: input.instanceId,
      binaryPath,
      environment,
      cwd: serverConfig.cwd,
    });
    const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
      binaryPath,
      env: environment,
    });
    return {
      instanceId: input.instanceId,
      driverKind: DEEPCODE_DRIVER_KIND,
      continuationIdentity,
      displayName: input.displayName,
      accentColor: input.accentColor,
      enabled: input.enabled,
      adapter,
      textGeneration: {
        generateCommitMessage: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateCommitMessage",
              detail: "Deep Code auxiliary generation is unavailable.",
            }),
          ),
        generatePrContent: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generatePrContent",
              detail: "Deep Code auxiliary generation is unavailable.",
            }),
          ),
        generateBranchName: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateBranchName",
              detail: "Deep Code auxiliary generation is unavailable.",
            }),
          ),
        generateThreadTitle: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateThreadTitle",
              detail: "Deep Code auxiliary generation is unavailable.",
            }),
          ),
        correctVoiceTranscript: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "correctVoiceTranscript",
              detail: "Deep Code auxiliary generation is unavailable.",
            }),
          ),
        generatePlanRefresh: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generatePlanRefresh",
              detail: "Deep Code auxiliary generation is unavailable.",
            }),
          ),
        generateVmAgentTaskPrompt: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateVmAgentTaskPrompt",
              detail: "Deep Code auxiliary generation is unavailable.",
            }),
          ),
      },
      snapshot: {
        maintenanceCapabilities,
        getSnapshot: Ref.get(snapshotRef),
        refresh: probe().pipe(
          Effect.tap((snapshot) => Ref.set(snapshotRef, snapshot)),
          Effect.tap((snapshot) => PubSub.publish(changes, snapshot)),
        ),
        streamChanges: Stream.fromPubSub(changes),
      },
    };
  }),
};
