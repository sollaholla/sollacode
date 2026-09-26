import {
  AntigravitySettings,
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  TextGenerationError,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { groupAntigravityModels, splitAntigravityModel } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { parseGenericCliVersion, spawnAndCollect } from "../providerSnapshot.ts";
import { defaultProviderContinuationIdentity, type ProviderDriver } from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeScriptInstalledProviderMaintenanceResolver } from "../providerMaintenance.ts";
import { parseAntigravityModelsOutput } from "../antigravityProtocol.ts";
import { ANTIGRAVITY_DRIVER_KIND } from "../antigravityRuntime.ts";
import { makeAntigravityAdapter } from "../Layers/AntigravityAdapter.ts";

import {
  makeAntigravityAccountAuth,
  readAntigravityAuthStatus,
} from "../antigravityAccountAuth.ts";

const decodeSettings = Schema.decodeSync(AntigravitySettings);

/** `agy` ships only through Google's install script; there is no npm package. */
const ANTIGRAVITY_MAINTENANCE = makeScriptInstalledProviderMaintenanceResolver({
  provider: ANTIGRAVITY_DRIVER_KIND,
  installScript: {
    lockKey: "antigravity-install",
    posix: {
      executable: "bash",
      args: ["-lc", "curl -fsSL https://antigravity.google/cli/install.sh | bash"],
    },
    windows: {
      executable: "powershell",
      args: ["-NoProfile", "-Command", "irm https://antigravity.google/cli/install.ps1 | iex"],
    },
  },
});

/** Matches makeManagedServerProvider: a skipped tick costs 30s, not a whole interval. */
const DEFERRED_ANTIGRAVITY_RECHECK = Duration.seconds(30);

export type AntigravityDriverEnv =
  | ServerConfig
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | BackgroundPolicy.BackgroundPolicy
  | ServerSettingsService;
export const AntigravityDriver: ProviderDriver<AntigravitySettings, AntigravityDriverEnv> = {
  driverKind: ANTIGRAVITY_DRIVER_KIND,
  metadata: { displayName: "Antigravity", supportsMultipleInstances: true },
  configSchema: AntigravitySettings,
  defaultConfig: () => decodeSettings({}),
  create: Effect.fn("AntigravityDriver.create")(function* (input) {
    const serverConfig = yield* ServerConfig;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const environment = mergeProviderInstanceEnvironment(input.environment);
    const binaryPath = input.config.binaryPath || "agy";
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: ANTIGRAVITY_DRIVER_KIND,
      instanceId: input.instanceId,
    });
    const probe = Effect.fn("AntigravityDriver.probe")(
      function* (): Effect.fn.Return<ServerProvider> {
        const runProbe = Effect.fn("AntigravityDriver.runProbe")(function* (args: string[]) {
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
        const results = input.enabled
          ? yield* Effect.all(
              [
                runProbe(["--version"]),
                runProbe(["models"]),
                readAntigravityAuthStatus({ binaryPath, environment }).pipe(
                  Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                  Effect.provideService(FileSystem.FileSystem, fs),
                  Effect.provideService(Path.Path, path),
                  Effect.result,
                ),
              ],
              {
                concurrency: "unbounded",
              },
            )
          : undefined;
        const versionResult = results?.[0];
        const modelsResult = results?.[1];
        const authResult = results?.[2];
        const authenticated = authResult?._tag === "Success" && authResult.success.loggedIn;
        const unauthenticated =
          authResult?._tag === "Success" && authResult.success.unauthenticated;
        const accountUsage =
          authenticated && authResult.success.accountUsage !== undefined
            ? authResult.success.accountUsage
            : undefined;
        const installed = versionResult?._tag === "Success";
        const versionReady = installed && versionResult.success.code === 0;
        const modelsReady = modelsResult?._tag === "Success" && modelsResult.success.code === 0;
        const available = versionReady && modelsReady;
        const models = modelsReady ? parseAntigravityModelsOutput(modelsResult.success.stdout) : [];
        const checkedAt = DateTime.formatIso(DateTime.nowUnsafe());
        return {
          instanceId: input.instanceId,
          driver: ANTIGRAVITY_DRIVER_KIND,
          displayName: input.displayName ?? "Antigravity",
          ...(input.accentColor ? { accentColor: input.accentColor } : {}),
          continuation: { groupKey: continuationIdentity.continuationKey },
          badgeLabel: "AGY",
          enabled: input.enabled,
          installed,
          version: versionReady ? parseGenericCliVersion(versionResult.success.stdout) : null,
          status: !input.enabled ? "disabled" : available ? "ready" : "error",
          auth: {
            status: authenticated
              ? "authenticated"
              : unauthenticated
                ? "unauthenticated"
                : "unknown",
            ...(authenticated ? { type: "Google account" } : {}),
            ...(authenticated && authResult.success.accountLabel
              ? { email: authResult.success.accountLabel }
              : {}),
          },
          checkedAt,
          ...(accountUsage !== undefined
            ? {
                accountUsage,
                accountUsageReportedAt: checkedAt,
              }
            : {}),
          message: !input.enabled
            ? "Antigravity is disabled in Solla Code settings."
            : available
              ? "Uses your Antigravity CLI sign-in. Headless approvals follow CLI policy; Full access permits all tools."
              : installed
                ? "Antigravity is installed, but its CLI check failed. Refresh to try again."
                : "Install Antigravity, then sign in from this card.",
          availability: "available",
          showInteractionModeToggle: true,
          requiresNewThreadForModelChange: false,
          models: [
            ...groupAntigravityModels(models),
            ...input.config.customModels
              .filter(
                (slug) =>
                  !models.some(
                    (model) =>
                      splitAntigravityModel(model.slug).model === splitAntigravityModel(slug).model,
                  ),
              )
              .map((slug) => ({
                slug,
                name: slug,
                isCustom: true,
                isDefault: false,
                capabilities: null,
              })),
          ],
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
      },
    );
    const snapshotRef = yield* Ref.make(yield* probe());
    const changes = yield* Effect.acquireRelease(
      PubSub.unbounded<ServerProvider>(),
      PubSub.shutdown,
    );
    const refreshSnapshot = probe().pipe(
      Effect.tap((snapshot) => Ref.set(snapshotRef, snapshot)),
      Effect.tap((snapshot) => PubSub.publish(changes, snapshot)),
    );

    /**
     * Re-probe on the provider-health interval.
     *
     * Every other usage-reporting driver gets this from
     * `makeManagedServerProvider`; Antigravity hand-rolls its snapshot and so
     * had no periodic probe at all. Its `accountUsageReportedAt` is the
     * probe's own `checkedAt`, and `agy` publishes no in-turn usage events
     * either, so the reading only advanced when someone pressed Refresh --
     * and then aged past the client's 20-minute window and sat on "Stale"
     * indefinitely while the app ran. Reported with a card frozen at
     * "Last reported Sep 10, 12:32 PM" beside live countdowns.
     *
     * Gated on the same demand check the managed loop uses, so this does not
     * spend `agy` invocations on a host nobody is watching, and re-checks
     * quickly after a skip rather than losing a whole interval to it.
     */
    const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
    const serverSettings = yield* ServerSettingsService;
    const refreshOwedRef = yield* Ref.make(false);
    yield* Effect.forever(
      Effect.gen(function* () {
        const interval = yield* serverSettings.getSettings.pipe(
          Effect.map(
            (settings) =>
              resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
          ),
          Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
        );
        const configuredMs = Duration.toMillis(Duration.fromInputUnsafe(interval));
        if (configuredMs <= 0) {
          yield* Effect.sleep(Duration.seconds(60));
          return;
        }
        const owed = yield* Ref.get(refreshOwedRef);
        yield* Effect.sleep(
          owed && Duration.toMillis(DEFERRED_ANTIGRAVITY_RECHECK) < configuredMs
            ? DEFERRED_ANTIGRAVITY_RECHECK
            : Duration.fromInputUnsafe(interval),
        );
        const [genericDemand, instanceDemand] = yield* Effect.all([
          backgroundPolicy.shouldRunScopeWork({ type: "provider-status" }),
          backgroundPolicy.shouldRunScopeWork({
            type: "provider-status",
            instanceId: input.instanceId,
          }),
        ]);
        if (!genericDemand && !instanceDemand) {
          yield* Ref.set(refreshOwedRef, true);
          return;
        }
        yield* Ref.set(refreshOwedRef, false);
        yield* refreshSnapshot.pipe(Effect.asVoid);
      }).pipe(Effect.ignoreCause({ log: true })),
    ).pipe(Effect.forkScoped);

    const adapter = yield* makeAntigravityAdapter({
      instanceId: input.instanceId,
      binaryPath,
      environment,
      cwd: serverConfig.cwd,
    });
    return {
      instanceId: input.instanceId,
      driverKind: ANTIGRAVITY_DRIVER_KIND,
      continuationIdentity,
      displayName: input.displayName,
      accentColor: input.accentColor,
      enabled: input.enabled,
      adapter,
      accountAuth: makeAntigravityAccountAuth({ binaryPath, environment, cwd: serverConfig.cwd }),
      textGeneration: {
        generateCommitMessage: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateCommitMessage",
              detail: "Antigravity auxiliary generation is unavailable.",
            }),
          ),
        generatePrContent: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generatePrContent",
              detail: "Antigravity auxiliary generation is unavailable.",
            }),
          ),
        generateBranchName: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateBranchName",
              detail: "Antigravity auxiliary generation is unavailable.",
            }),
          ),
        generateThreadTitle: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateThreadTitle",
              detail: "Antigravity auxiliary generation is unavailable.",
            }),
          ),
        correctVoiceTranscript: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "correctVoiceTranscript",
              detail: "Antigravity auxiliary generation is unavailable.",
            }),
          ),
        generatePlanRefresh: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generatePlanRefresh",
              detail: "Antigravity auxiliary generation is unavailable.",
            }),
          ),
        generateVmAgentTaskPrompt: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateVmAgentTaskPrompt",
              detail: "Antigravity auxiliary generation is unavailable.",
            }),
          ),
      },
      snapshot: {
        maintenanceCapabilities: ANTIGRAVITY_MAINTENANCE.resolve({ binaryPath }),
        getSnapshot: Ref.get(snapshotRef),
        refresh: refreshSnapshot,
        streamChanges: Stream.fromPubSub(changes),
      },
    };
  }),
};
