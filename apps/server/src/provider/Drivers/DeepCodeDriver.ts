import { DeepCodeSettings, TextGenerationError, type ServerProvider } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { ServerConfig } from "../../config.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { ProviderDriverError } from "../Errors.ts";
import { readDeepCodeBalance, resolveDeepCodeConnection } from "../deepcodeUsage.ts";
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
  | Path.Path
  | BackgroundPolicy.BackgroundPolicy
  | ServerSettingsService;
export const DeepCodeDriver: ProviderDriver<DeepCodeSettings, DeepCodeDriverEnv> = {
  driverKind: DEEPCODE_DRIVER_KIND,
  metadata: { displayName: "Deep Code", supportsMultipleInstances: true },
  configSchema: DeepCodeSettings,
  defaultConfig: () => decodeSettings({}),
  create: Effect.fn("DeepCodeDriver.create")(function* (input) {
    const serverConfig = yield* ServerConfig;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverSettings = yield* ServerSettingsService;
    const environment = mergeProviderInstanceEnvironment(input.environment);
    const selectedApiKey = serverSettings.getProviderApiKey(input.instanceId);
    const credentialEnvironment = (selected: Effect.Success<typeof selectedApiKey>) =>
      selected
        ? {
            ...environment,
            DEEPCODE_API_KEY: selected.apiKey,
            DEEPCODE_BASE_URL: selected.account.baseUrl,
          }
        : environment;
    const binaryPath = input.config.binaryPath || "deepcode";
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DEEPCODE_DRIVER_KIND,
      instanceId: input.instanceId,
    });
    const lastUsageRef = yield* Ref.make<{
      identity: string;
      usage: NonNullable<ServerProvider["accountUsage"]>;
      reportedAt: string;
    } | null>(null);
    const probe = Effect.fn("DeepCodeDriver.probe")(function* (): Effect.fn.Return<ServerProvider> {
      const selectionResult = yield* selectedApiKey.pipe(Effect.result);
      const selection = selectionResult._tag === "Success" ? selectionResult.success : null;
      const probeEnvironment = credentialEnvironment(selection);
      const runProbe = Effect.fn("DeepCodeDriver.runProbe")(function* (args: string[]) {
        const command = yield* resolveSpawnCommand(binaryPath, args, { env: probeEnvironment });
        return yield* spawnAndCollect(
          binaryPath,
          ChildProcess.make(command.command, command.args, {
            env: probeEnvironment,
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
      const plusSettings = yield* fs
        .readFileString(path.join(deepCodeHomeDir(environment), ".deepcode-plus", "settings.json"))
        .pipe(Effect.orElseSucceed(() => ""));
      // This is the instance's base account. Project overrides are deliberately
      // excluded: one project's key cannot stand in for every project on the host.
      const connection = resolveDeepCodeConnection({
        userSettings: settingsRaw,
        plusSettings,
        environment: probeEnvironment,
      });
      const authenticated = selectionResult._tag === "Success" && connection.apiKey !== null;
      const installed = versionResult?._tag === "Success";
      const versionReady = installed && versionResult.success.code === 0;
      const available = versionReady;
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      const usageResult =
        input.enabled &&
        available &&
        authenticated &&
        connection.apiKey &&
        connection.supportsBalance
          ? yield* readDeepCodeBalance(connection.apiKey)
          : null;
      if (usageResult?.status === "success" && connection.identity) {
        yield* Ref.set(lastUsageRef, {
          identity: connection.identity,
          usage: usageResult.balance,
          reportedAt: DateTime.formatIso(yield* DateTime.now),
        });
      }
      const previousUsage = yield* Ref.get(lastUsageRef);
      const accountUsage =
        authenticated && previousUsage?.identity === connection.identity ? previousUsage : null;
      if (previousUsage && !accountUsage) yield* Ref.set(lastUsageRef, null);
      const accountUsageStatus: NonNullable<ServerProvider["accountUsageStatus"]> = !authenticated
        ? {
            state: "unavailable",
            message:
              selectionResult._tag === "Failure"
                ? "The selected API key could not be loaded. Replace it in Providers settings."
                : "Add a named API key in Settings > Providers > Deep Code, or configure the Deep Code CLI.",
          }
        : !connection.supportsBalance
          ? {
              state: "unsupported",
              message:
                "This endpoint uses separate billing. Deep Code Plus and custom endpoints do not expose a supported balance API.",
            }
          : usageResult?.status === "success"
            ? { state: "available" }
            : usageResult?.status === "error"
              ? { state: "error", message: usageResult.message }
              : {
                  state: "unavailable",
                  message: "Enable and install Deep Code to refresh its DeepSeek balance.",
                };
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
          ...(authenticated ? { type: connection.authType } : {}),
          ...(authenticated && selection ? { label: selection.account.name } : {}),
        },
        checkedAt,
        ...(connection.identity ? { accountUsageIdentity: connection.identity } : {}),
        ...(accountUsage
          ? { accountUsage: accountUsage.usage, accountUsageReportedAt: accountUsage.reportedAt }
          : {}),
        accountUsageStatus,
        message: !input.enabled
          ? "Deep Code is disabled in Solla Code settings."
          : available
            ? authenticated
              ? "Headless --exec cannot confirm permission prompts; keep permissions.defaultMode allowAll or pre-allow the scopes the agent needs."
              : "Deep Code is installed. Add a named API key in Settings > Providers > Deep Code."
            : installed
              ? "Deep Code is installed, but its CLI check failed. Refresh to try again."
              : "Install Deep Code, then add a named API key in its provider settings.",
        availability: "available",
        showInteractionModeToggle: true,
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
    const adapter = yield* makeDeepCodeAdapter({
      instanceId: input.instanceId,
      binaryPath,
      environment,
      resolveEnvironment: selectedApiKey.pipe(Effect.map(credentialEnvironment)),
      cwd: serverConfig.cwd,
      attachmentsDir: serverConfig.attachmentsDir,
    });
    const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
      binaryPath,
      env: environment,
    });
    const snapshot = yield* makeManagedServerProvider({
      maintenanceCapabilities,
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providerApiKeyAccounts?.[input.instanceId] ?? null),
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providerApiKeyAccounts?.[input.instanceId] ?? null),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      initialSnapshot: () => probe(),
      refreshOnCreate: false,
      checkProvider: probe(),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DEEPCODE_DRIVER_KIND,
            instanceId: input.instanceId,
            detail: "Could not initialize provider usage refresh.",
            cause,
          }),
      ),
    );
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
      snapshot,
    };
  }),
};
