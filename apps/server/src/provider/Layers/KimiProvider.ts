import {
  type KimiSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type { KimiAccountUsage } from "@t3tools/shared/kimiUsage";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  isKimiAuthRequiredFailure,
  KIMI_NOT_SIGNED_IN_MESSAGE,
  type KimiCatalogModel,
  kimiBinaryPath,
  makeKimiAcpRuntime,
  parseKimiDefaultModel,
  parseKimiProviderListJson,
} from "../acp/KimiAcpSupport.ts";
import { readKimiAccountUsage } from "../kimiUsage.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const KIMI_PRESENTATION = {
  displayName: "Kimi Code",
  showInteractionModeToggle: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const CATALOG_PROBE_TIMEOUT_MS = 10_000;
/** `initialize` + `authenticate` only; health checks never open a Kimi session. */
const KIMI_ACP_AUTH_CHECK_TIMEOUT_MS = 30_000;

/**
 * A thinking toggle, only for models that can actually turn thinking off.
 * Kimi's `always_thinking` models (every model it ships today) have nothing to
 * choose, and an effort level is not settable over ACP at all.
 */
function kimiModelCapabilities(model: KimiCatalogModel): ModelCapabilities {
  if (!model.capabilities.includes("thinking") || model.capabilities.includes("always_thinking")) {
    return EMPTY_CAPABILITIES;
  }
  return createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: "thinking",
        label: "Thinking",
        options: [
          { value: "on", label: "On", isDefault: true },
          { value: "off", label: "Off" },
        ],
      }),
    ],
  });
}

/**
 * The catalog as Solla models: Kimi's own default first and marked default, so
 * a new thread starts on the model the CLI would pick by itself.
 */
export function kimiModelsFromCatalog(
  catalog: ReadonlyArray<KimiCatalogModel>,
  defaultAlias: string | undefined,
  customModels: ReadonlyArray<string> = [],
): ReadonlyArray<ServerProviderModel> {
  const ordered = [
    ...catalog.filter((model) => model.alias === defaultAlias),
    ...catalog.filter((model) => model.alias !== defaultAlias),
  ];
  const builtIn = ordered.map(
    (model): ServerProviderModel => ({
      slug: model.alias,
      name: model.displayName,
      isCustom: false,
      ...(model.alias === defaultAlias ? { isDefault: true } : {}),
      capabilities: kimiModelCapabilities(model),
    }),
  );
  return providerModelsFromSettings(builtIn, customModels, EMPTY_CAPABILITIES);
}

export function buildInitialKimiProviderSnapshot(
  settings: KimiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: kimiModelsFromCatalog([], undefined, settings.customModels),
      probe: {
        installed: settings.enabled,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking Kimi Code CLI availability..."
          : "Kimi Code is disabled in Solla Code settings.",
      },
    });
  });
}

const runKimiCommand = (
  settings: KimiSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = kimiBinaryPath(settings);
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

const readKimiCatalog = (settings: KimiSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const [catalogOutput, summaryOutput] = yield* Effect.all(
      [
        runKimiCommand(settings, ["provider", "list", "--json"], environment),
        runKimiCommand(settings, ["provider", "list"], environment),
      ],
      { concurrency: "unbounded" },
    );
    return {
      models: catalogOutput.code === 0 ? parseKimiProviderListJson(catalogOutput.stdout) : [],
      defaultAlias:
        summaryOutput.code === 0 ? parseKimiDefaultModel(summaryOutput.stdout) : undefined,
    };
  });

const checkKimiSignedIn = (settings: KimiSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeKimiAcpRuntime({
      kimiSettings: settings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
      // A session would land in the person's own Kimi history on every check.
      createSession: false,
    });
    yield* acp.start();
  }).pipe(Effect.scoped);

export const checkKimiProviderStatus = Effect.fn("checkKimiProviderStatus")(function* (
  settings: KimiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const build = (input: {
    readonly models: ReadonlyArray<ServerProviderModel>;
    readonly probe: Parameters<typeof buildServerProvider>[0]["probe"];
    readonly enabled?: boolean;
    readonly accountUsage?: KimiAccountUsage | null;
  }) =>
    buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: input.enabled ?? settings.enabled,
      checkedAt,
      models: input.models,
      ...(input.accountUsage
        ? { accountUsage: input.accountUsage, accountUsageReportedAt: checkedAt }
        : {}),
      probe: input.probe,
    });
  const fallbackModels = kimiModelsFromCatalog([], undefined, settings.customModels);

  const versionResult = yield* runKimiCommand(settings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult)) {
    const missing = isCommandMissingCause(versionResult.failure);
    return build({
      models: fallbackModels,
      probe: {
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? "Kimi Code CLI (`kimi`) is not installed or not on PATH."
          : "Failed to run the Kimi Code CLI health check.",
      },
    });
  }
  if (Option.isNone(versionResult.success)) {
    return build({
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Kimi Code CLI is installed but timed out running `kimi --version`.",
      },
    });
  }
  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (!settings.enabled) {
    return build({
      enabled: false,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: "Kimi Code is disabled in Solla Code settings.",
      },
    });
  }
  if (versionOutput.code !== 0) {
    return build({
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Kimi Code CLI is installed but failed to run.",
      },
    });
  }

  const catalogResult = yield* readKimiCatalog(settings, environment).pipe(
    Effect.timeoutOption(CATALOG_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  const catalog =
    Result.isSuccess(catalogResult) && Option.isSome(catalogResult.success)
      ? catalogResult.success.value
      : { models: [], defaultAlias: undefined };
  const models = kimiModelsFromCatalog(catalog.models, catalog.defaultAlias, settings.customModels);

  const authExit = yield* checkKimiSignedIn(settings, environment).pipe(
    Effect.timeoutOption(KIMI_ACP_AUTH_CHECK_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(authExit)) {
    const signInNeeded = isKimiAuthRequiredFailure(authExit.cause);
    if (!signInNeeded) {
      yield* Effect.logWarning("Kimi ACP sign-in check failed.", {
        errorTag: causeErrorTag(authExit.cause),
      });
    }
    return build({
      models,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: signInNeeded ? "unauthenticated" : "unknown" },
        message: signInNeeded
          ? KIMI_NOT_SIGNED_IN_MESSAGE
          : "Kimi Code CLI is installed but `kimi acp` failed to start. Check server logs for details.",
      },
    });
  }
  if (Option.isNone(authExit.value)) {
    return build({
      models,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: `Kimi Code CLI is installed, but its ACP sign-in check timed out after ${KIMI_ACP_AUTH_CHECK_TIMEOUT_MS}ms.`,
      },
    });
  }
  // A lapsed token yields no reading rather than an "unavailable" status:
  // the client keeps showing the last one (aged into "stale"), and an
  // unavailable status would send the refresh loop chasing it every minute
  // while Kimi sits idle with nothing new to say.
  const accountUsage = yield* readKimiAccountUsage(environment);
  return build({
    models,
    accountUsage,
    probe: {
      installed: true,
      version,
      status: catalog.models.length > 0 ? "ready" : "warning",
      auth: { status: "authenticated" },
      ...(catalog.models.length > 0
        ? {}
        : {
            message:
              "Signed in, but Kimi Code lists no models. Check `kimi provider list` in a terminal.",
          }),
    },
  });
});

export const enrichKimiSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => input.publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Kimi version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
