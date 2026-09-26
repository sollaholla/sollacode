import {
  MuseSettings,
  TextGenerationError,
  type ModelCapabilities,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { ServerConfig } from "../../config.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { ProviderAdapterRequestError, ProviderDriverError } from "../Errors.ts";
import { providerModelsFromSettings, spawnAndCollect } from "../providerSnapshot.ts";
import { defaultProviderContinuationIdentity, type ProviderDriver } from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makeScriptInstalledProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import { makeMuseAdapter } from "../Layers/MuseAdapter.ts";
import { buildSelectOptionDescriptor } from "../providerSnapshot.ts";
import { MUSE_EFFORT_OPTIONS } from "../museProtocol.ts";
import { makeMuseAccountAuth, readMuseAuthStatus } from "../museAccountAuth.ts";
import {
  parseMuseVersion,
  type MuseModelCatalogEntry,
  MUSE_DEFAULT_BINARY,
  MUSE_DRIVER_KIND,
  MUSE_INSTALL_COMMAND,
  MUSE_PLAN_URL,
} from "../museProtocol.ts";

const decodeSettings = Schema.decodeSync(MuseSettings);

/**
 * Muse installs through its own launcher rather than a package manager, so the
 * vendor script is the only channel. Both scripts were fetched and read before
 * being wired here: each downloads a launcher into a user-local bin directory,
 * so neither needs elevation.
 */
const MUSE_MAINTENANCE = makeScriptInstalledProviderMaintenanceResolver({
  provider: MUSE_DRIVER_KIND,
  installScript: {
    lockKey: "muse-install",
    posix: { executable: "bash", args: ["-lc", MUSE_INSTALL_COMMAND] },
    windows: {
      executable: "powershell",
      args: ["-NoProfile", "-Command", "irm https://dev.meta.ai/install.ps1 | iex"],
    },
  },
});

const unavailableTextGeneration = (operation: string) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail: "Muse Code auxiliary generation is unavailable.",
    }),
  );

export type MuseDriverEnv =
  | ServerConfig
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | BackgroundPolicy.BackgroundPolicy
  | ServerSettingsService;

/**
 * What a Muse model lets the person choose.
 *
 * Only the reasoning tier: the rest of a Muse turn is decided by the account's
 * own catalog. See `MUSE_EFFORT_OPTIONS` for why these six and not the host's
 * full eight.
 */
const MUSE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    buildSelectOptionDescriptor({
      id: "effort",
      label: "Reasoning",
      options: [...MUSE_EFFORT_OPTIONS],
    }),
  ],
});

export const MuseDriver: ProviderDriver<MuseSettings, MuseDriverEnv> = {
  driverKind: MUSE_DRIVER_KIND,
  metadata: { displayName: "Muse Code", supportsMultipleInstances: true },
  configSchema: MuseSettings,
  defaultConfig: () => decodeSettings({}),
  create: Effect.fn("MuseDriver.create")(function* (input) {
    const serverConfig = yield* ServerConfig;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverSettings = yield* ServerSettingsService;
    const fs = yield* FileSystem.FileSystem;
    const environment = mergeProviderInstanceEnvironment(input.environment);
    const binaryPath = input.config.binaryPath || MUSE_DEFAULT_BINARY;
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: MUSE_DRIVER_KIND,
      instanceId: input.instanceId,
    });

    /**
     * Set once the adapter exists, because the catalog is served over the same
     * MSP host the adapter owns. The probe runs before and after that point, so
     * it asks only when there is something to ask.
     */
    let listModels:
      | (() => Effect.Effect<ReadonlyArray<MuseModelCatalogEntry>, ProviderAdapterRequestError>)
      | null = null;

    const probe = Effect.fn("MuseDriver.probe")(function* (): Effect.fn.Return<ServerProvider> {
      const versionResult = input.enabled
        ? yield* Effect.gen(function* () {
            const command = yield* resolveSpawnCommand(binaryPath, ["--version"], {
              env: environment,
            });
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
          })
        : undefined;
      const installed = versionResult?._tag === "Success";
      const versionReady = installed && versionResult.success.code === 0;
      const available = versionReady;
      const version = versionReady ? parseMuseVersion(versionResult.success.stdout) : null;
      // Credentials live in the CLI's own config; `muse login` writes them and
      // nothing here can create them, so the probe only reports whether they
      // exist.
      const authStatus = yield* readMuseAuthStatus({ environment, fs });
      const authenticated = authStatus.loggedIn;
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      // Muse's catalog is served by the signed-in account over MSP, so it is
      // read from the live host rather than baked into this build. A signed-out
      // account answers with an empty catalog, and that is reported as empty.
      const catalog =
        available && listModels !== null
          ? yield* listModels().pipe(
              Effect.timeout("10 seconds"),
              Effect.orElseSucceed((): ReadonlyArray<MuseModelCatalogEntry> => []),
            )
          : [];
      // Every model the account's catalog served. There used to be a filter
      // here on `isActive`, read as "the account may run this model" - it is
      // not that. It marks the session's selected model and only when
      // `model/list` is given a `sessionId`, which this probe does not pass,
      // so it was `false` on every row of every response and the filter
      // emptied the picker every time. Entitlement is not in this payload at
      // all; the host reports it per turn via `session/modelRouteUnserved`.
      const hasNoServedModels = authenticated && available && catalog.length === 0;
      const models = providerModelsFromSettings(
        catalog.map((entry) => ({
          slug: entry.modelId,
          name: entry.displayName ?? entry.modelId,
          isCustom: false,
          ...(entry.isDefault ? { isDefault: true } : {}),
          // Every Muse model takes a reasoning tier -- the CLI's own
          // `--reasoning-effort`, carried on each turn as MSP's
          // `reasoningEffort`. These came back `null`, so the account's models
          // reached the picker with no reasoning control at all and the tier
          // could only ever be whatever the host defaulted to.
          capabilities: MUSE_MODEL_CAPABILITIES,
        })),
        input.config.customModels,
        // A hand-typed Muse id runs through the same host and takes the same
        // tier, so it gets the same picker rather than none.
        MUSE_MODEL_CAPABILITIES,
      );
      return {
        instanceId: input.instanceId,
        driver: MUSE_DRIVER_KIND,
        displayName: input.displayName ?? "Muse Code",
        ...(input.accentColor ? { accentColor: input.accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
        badgeLabel: "MU",
        enabled: input.enabled,
        installed,
        version,
        status: !input.enabled ? "disabled" : available ? "ready" : "error",
        auth: {
          status: authenticated ? "authenticated" : installed ? "unauthenticated" : "unknown",
          ...(authenticated ? { type: "Meta account" } : {}),
          // The credential file carries the account's email. It was never read
          // before, so a signed-in card could say only *that* an account
          // existed, never which one - the thing you need when the question is
          // whether to switch.
          ...(authenticated && authStatus.accountLabel ? { email: authStatus.accountLabel } : {}),
          // No `signInCommand`: Muse now has a real `accountAuth` capability,
          // so the in-app switch-account flow runs `muse login` and shows the
          // Meta page itself rather than printing a command to retype.
        },
        // Only the states a person can act on. "Still probing" is not one of
        // them, so it stays absent and the picker keeps its plain empty text.
        ...(hasNoServedModels
          ? {
              modelAccess: {
                state: "no-plan" as const,
                detail:
                  "This Meta account served an empty Muse catalog, so it has no models to run.",
                url: MUSE_PLAN_URL,
              },
            }
          : available && !authenticated
            ? {
                modelAccess: {
                  state: "signed-out" as const,
                  detail: "Sign in to your Meta account to load Muse models.",
                },
              }
            : {}),
        checkedAt,
        // Auth state first, capability second. This was a flat "unsupported"
        // on every path, so a signed-out account was told it had no usage
        // rather than that it was signed out, and a signed-in account with
        // real credits read as an account with none. Neither sentence was
        // about the thing that was actually true.
        accountUsageStatus: !installed
          ? {
              state: "unavailable" as const,
              message: "Install Muse Code to read this account's status.",
            }
          : !authenticated
            ? {
                state: "unavailable" as const,
                message: "Sign in to your Meta account to read its Muse usage.",
              }
            : {
                state: "unsupported" as const,
                // Says where the number lives instead of implying there is
                // none. The account may well have credits; Muse just serves
                // them to its dashboard and not to the CLI or MSP - neither
                // `muse --help` nor the MSP method index exposes any
                // account-level credit, balance, or quota call.
                message:
                  "Muse bills by the token and reports no balance or running charge to the CLI: /status shows only the billing mode, /usage and /cost only this session's estimate. Solla Code prices each session's spend from Muse's catalog; the billed amount is in Meta Account Center.",
              },
        // One short line per state. The card already carries the Install
        // button and the copyable sign-in command, so repeating either here
        // just fills the row with text the person is already looking at.
        message: !input.enabled
          ? "Disabled in settings."
          : available
            ? authenticated
              ? hasNoServedModels
                ? "Signed in, but this account served no Muse models."
                : "Ready."
              : "Not signed in."
            : installed
              ? "Installed, but `muse --version` failed."
              : "Not installed.",
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

    const adapter = yield* makeMuseAdapter({
      instanceId: input.instanceId,
      binaryPath,
      environment,
      cwd: serverConfig.cwd,
      trustWorkspace: input.config.trustWorkspace,
      attachmentsDir: serverConfig.attachmentsDir,
    });
    listModels = () => adapter.listModels();
    const accountAuth = makeMuseAccountAuth({ binaryPath, environment });
    const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
      MUSE_MAINTENANCE,
      {
        binaryPath,
        env: environment,
      },
    );
    const snapshot = yield* makeManagedServerProvider({
      maintenanceCapabilities,
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers?.muse ?? null),
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers?.muse ?? null),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      initialSnapshot: () => probe(),
      refreshOnCreate: true,
      checkProvider: probe(),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: MUSE_DRIVER_KIND,
            instanceId: input.instanceId,
            detail: "Could not initialize the Muse Code provider.",
            cause,
          }),
      ),
    );
    return {
      instanceId: input.instanceId,
      driverKind: MUSE_DRIVER_KIND,
      continuationIdentity,
      displayName: input.displayName,
      accentColor: input.accentColor,
      enabled: input.enabled,
      adapter,
      accountAuth,
      textGeneration: {
        generateCommitMessage: () => unavailableTextGeneration("generateCommitMessage"),
        generatePrContent: () => unavailableTextGeneration("generatePrContent"),
        generateBranchName: () => unavailableTextGeneration("generateBranchName"),
        generateThreadTitle: () => unavailableTextGeneration("generateThreadTitle"),
        correctVoiceTranscript: () => unavailableTextGeneration("correctVoiceTranscript"),
        generatePlanRefresh: () => unavailableTextGeneration("generatePlanRefresh"),
        generateVmAgentTaskPrompt: () => unavailableTextGeneration("generateVmAgentTaskPrompt"),
      },
      snapshot,
    };
  }),
};
