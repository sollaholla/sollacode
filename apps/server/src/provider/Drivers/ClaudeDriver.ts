/**
 * ClaudeDriver — `ProviderDriver` for the Claude Agent SDK runtime.
 *
 * Mirrors `CodexDriver`: a plain value whose `create()` returns one
 * `ProviderInstance` bundling `snapshot` / `adapter` / `textGeneration`
 * closures captured over the per-instance `ClaudeSettings`.
 *
 * Unlike Codex, the Claude snapshot probe may invoke a secondary probe
 * (`probeClaudeCapabilities`) to read Anthropic account + slash-command
 * metadata and account usage. That probe runs inside each configured instance
 * with its own environment so authenticated accounts cannot cross-contaminate.
 *
 * @module provider/Drivers/ClaudeDriver
 */
import { ClaudeSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeClaudeTextGeneration } from "../../textGeneration/ClaudeTextGeneration.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeClaudeAdapter } from "../Layers/ClaudeAdapter.ts";
import {
  checkClaudeProviderStatus,
  makePendingClaudeProvider,
  probeClaudeCapabilities,
} from "../Layers/ClaudeProvider.ts";
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
  enrichProviderSnapshotWithVersionAdvisory,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import {
  claimClaudeBankedReset,
  ClaudeBankedResetError,
  fetchClaudeBankedResets,
  makeClaudeBankedResetCache,
  readClaudeOAuthCredentials,
  withClaudeResetCredits,
} from "./ClaudeBankedResets.ts";
import { makeClaudeContinuationGroupKey, makeClaudeEnvironment } from "./ClaudeHome.ts";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const DRIVER_KIND = ProviderDriverKind.make("claudeAgent");

function isClaudeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.local/bin/claude") ||
    normalized.endsWith("/.local/bin/claude.exe") ||
    normalized.includes("/.local/share/claude/")
  );
}

const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@anthropic-ai/claude-code",
  homebrewFormula: "claude-code",
  nativeUpdate: {
    executable: "claude",
    args: ["update"],
    lockKey: "claude-native",
    isCommandPath: isClaudeNativeCommandPath,
  },
});

export type ClaudeDriverEnv =
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
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const ClaudeDriver: ProviderDriver<ClaudeSettings, ClaudeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Claude",
    supportsMultipleInstances: true,
  },
  configSchema: ClaudeSettings,
  defaultConfig: (): ClaudeSettings => decodeClaudeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { cwd } = yield* ServerConfig;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const fallbackContinuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const effectiveConfig = { ...config, enabled } satisfies ClaudeSettings;
      const accountEnvironment = yield* makeClaudeEnvironment(effectiveConfig, processEnv);
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });
      const continuationGroupKey = yield* makeClaudeContinuationGroupKey(effectiveConfig);
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey,
      });

      let cliVersion: string | null = null;
      let discoveredModels: ReadonlyArray<ServerProvider["models"][number]> = [];
      const adapterOptions = {
        supportsThinkingDisplay: () =>
          cliVersion !== null && compareSemverVersions(cliVersion, "2.1.280") >= 0,
        getModelCapabilities: (model: string | null | undefined) =>
          discoveredModels.find((entry) => entry.slug === model)?.capabilities ?? undefined,
        instanceId,
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      };
      const adapter = yield* makeClaudeAdapter(effectiveConfig, adapterOptions);
      const textGeneration = yield* makeClaudeTextGeneration(effectiveConfig, processEnv);

      const readCredentials = readClaudeOAuthCredentials(accountEnvironment).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      const bankedResets = yield* makeClaudeBankedResetCache(
        readCredentials.pipe(
          Effect.flatMap((credentials) =>
            credentials === null
              ? Effect.succeed({ status: "signedOut" } as const)
              : cliVersion === null
                ? Effect.succeed({ status: "failed" } as const)
                : fetchClaudeBankedResets(credentials.accessToken, cliVersion),
          ),
          Effect.provideService(HttpClient.HttpClient, httpClient),
        ),
      );

      const checkProvider = checkClaudeProviderStatus(
        effectiveConfig,
        () =>
          probeClaudeCapabilities(effectiveConfig, processEnv, cwd).pipe(
            Effect.map((capabilities) =>
              capabilities
                ? {
                    ...capabilities,
                    models: capabilities.models?.length ? capabilities.models : discoveredModels,
                  }
                : undefined,
            ),
            Effect.provideService(Path.Path, path),
          ),
        processEnv,
        cwd,
      ).pipe(
        Effect.tap((next) =>
          Effect.sync(() => {
            cliVersion = next.version;
          }),
        ),
        Effect.flatMap((next) =>
          // Only alongside real usage: the registry keeps the previous usage
          // when a check has none, and a bank-only envelope would replace it.
          next.status === "ready" &&
          next.auth.status === "authenticated" &&
          next.accountUsage !== undefined
            ? bankedResets.current.pipe(
                Effect.map((credits) => ({
                  ...next,
                  accountUsage: withClaudeResetCredits(next.accountUsage, credits),
                })),
              )
            : Effect.succeed(next),
        ),
        Effect.map((next) => {
          if (next.status === "ready") discoveredModels = next.models;
          // Retain the last model list during a transient probe failure, scoped
          // to this provider instance and discarded when its config changes.
          const models = new Map(discoveredModels.map((model) => [model.slug, model]));
          for (const model of next.models) models.set(model.slug, model);
          return stampIdentity({ ...next, models: [...models.values()] });
        }),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<ClaudeSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingClaudeProvider(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
          enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
          }).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Claude snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity: {
          ...fallbackContinuationIdentity,
          continuationKey: continuationGroupKey,
        },
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
        usageReset: {
          consume: ({ creditId, idempotencyKey }) =>
            Effect.gen(function* () {
              if (!creditId) {
                return yield* Effect.fail(
                  new ClaudeBankedResetError("Choose which Claude reset to use."),
                );
              }
              const credentials = yield* readCredentials;
              if (credentials === null) {
                return yield* Effect.fail(
                  new ClaudeBankedResetError(
                    "Claude's stored sign-in is missing or expired. Run a Claude turn, then retry.",
                  ),
                );
              }
              if (cliVersion === null) {
                return yield* Effect.fail(
                  new ClaudeBankedResetError(
                    "Claude's version is still being checked. Try again in a moment.",
                  ),
                );
              }
              const outcome = yield* claimClaudeBankedReset({
                credentials,
                cliVersion,
                grantId: creditId,
                requestId: idempotencyKey,
              });
              if (outcome === "reset") yield* bankedResets.spend(creditId);
              return outcome;
            }).pipe(
              Effect.provideService(HttpClient.HttpClient, httpClient),
              // Whatever happened, the bank changed or needs checking.
              Effect.ensuring(bankedResets.invalidate),
            ),
        },
        accountAuth: {
          binaryPath: effectiveConfig.binaryPath,
          environment: accountEnvironment,
          logoutArgs: ["auth", "logout"],
          loginArgs: ["auth", "login", "--claudeai"],
          statusArgs: ["auth", "status", "--json"],
          acceptsManualAuthCode: true,
          parseStatus: (stdout, stderr) => {
            try {
              const parsed = JSON.parse(stdout.trim()) as {
                readonly loggedIn?: boolean;
                readonly email?: string;
              };
              return {
                loggedIn: parsed.loggedIn === true,
                accountLabel: parsed.email?.trim() || null,
              };
            } catch {
              const output = `${stdout}\n${stderr}`;
              return {
                loggedIn: /logged\s+in/i.test(output) && !/not\s+logged\s+in/i.test(output),
                accountLabel: null,
              };
            }
          },
        },
      } satisfies ProviderInstance;
    }),
};
