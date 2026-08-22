import {
  type GrokSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { SessionModelState } from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Schema from "effect/Schema";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { makeGrokAcpRuntime, resolveGrokAcpBaseModelId } from "../acp/GrokAcpSupport.ts";
import { GROK_BILLING_METHOD, parseGrokSubscription } from "../acp/GrokUsage.ts";

const GROK_PRESENTATION = {
  displayName: "Grok",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
/** Initialize + authenticate only. `session/new` is not part of this budget. */
const GROK_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 30_000;

const GROK_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "grok-build",
    name: "Grok Build",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function buildInitialGrokProviderSnapshot(
  grokSettings: GrokSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = grokModelsFromSettings(grokSettings.customModels);

    if (!grokSettings.enabled) {
      return buildServerProvider({
        presentation: GROK_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Grok is disabled in Solla Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Grok CLI availability...",
      },
    });
  });
}

function grokModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = GROK_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

interface GrokReasoningEffortLevel {
  readonly value: string;
  readonly label: string;
  readonly isDefault: boolean;
}

/**
 * Reads the reasoning-effort levels Grok advertises per model in ACP model
 * metadata (`_meta.reasoningEfforts`), which back the composer's effort
 * dropdown and are applied via `session/set_model` metadata.
 */
export function grokReasoningEffortLevelsFromModelMeta(
  meta: Record<string, unknown> | null | undefined,
): ReadonlyArray<GrokReasoningEffortLevel> {
  if (!meta || meta["supportsReasoningEffort"] !== true) {
    return [];
  }
  const rawEfforts = meta["reasoningEfforts"];
  if (!Array.isArray(rawEfforts)) {
    return [];
  }
  const seen = new Set<string>();
  const levels: Array<GrokReasoningEffortLevel> = [];
  for (const entry of rawEfforts) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const value =
      typeof record["value"] === "string" && record["value"].trim()
        ? record["value"].trim()
        : typeof record["id"] === "string"
          ? record["id"].trim()
          : "";
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    levels.push({
      value,
      label:
        typeof record["label"] === "string" && record["label"].trim()
          ? record["label"].trim()
          : value,
      isDefault: record["default"] === true,
    });
  }
  return levels;
}

function grokModelCapabilitiesFromMeta(
  meta: Record<string, unknown> | null | undefined,
): ModelCapabilities {
  const effortLevels = grokReasoningEffortLevelsFromModelMeta(meta);
  if (effortLevels.length === 0) {
    return EMPTY_CAPABILITIES;
  }
  return createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: "effort",
        label: "Reasoning",
        options: effortLevels.map((level) => ({
          value: level.value,
          label: level.label,
          ...(level.isDefault ? { isDefault: true } : {}),
        })),
      }),
    ],
  });
}

function buildGrokDiscoveredModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  return modelState.availableModels
    .map((model): ServerProviderModel | undefined => {
      const slug = resolveGrokAcpBaseModelId(model.modelId);
      if (!slug || seen.has(slug)) {
        return undefined;
      }
      seen.add(slug);
      return {
        slug,
        name: model.name.trim() || slug,
        isCustom: false,
        capabilities: grokModelCapabilitiesFromMeta(model._meta),
      };
    })
    .filter((model): model is ServerProviderModel => model !== undefined);
}

const decodeSessionModelState = Schema.decodeUnknownEffect(SessionModelState);

/**
 * Grok advertises its model catalog — including the per-model
 * reasoning-effort metadata behind the composer's effort dropdown — in the
 * `initialize` response `_meta.modelState`, mirroring ACP's
 * `SessionModelState`. Health checks never call `session/new`
 * (`createSession: false` below), so this is the only model source available
 * during discovery.
 */
export function grokModelStateFromInitializeMeta(
  meta: Record<string, unknown> | null | undefined,
): Effect.Effect<EffectAcpSchema.SessionModelState | undefined> {
  const rawModelState = meta?.["modelState"];
  if (rawModelState === undefined || rawModelState === null) {
    return Effect.succeed(undefined);
  }
  return decodeSessionModelState(rawModelState).pipe(
    Effect.catch(() =>
      Effect.as(
        Effect.logWarning("Grok initialize _meta.modelState did not match SessionModelState."),
        undefined,
      ),
    ),
  );
}

type GrokAcpDiscovery = {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly accountUsage?: unknown;
  readonly subscription?: ReturnType<typeof parseGrokSubscription>;
};

const discoverGrokModelsViaAcp = (
  grokSettings: GrokSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeGrokAcpRuntime({
      grokSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
      // Health checks must not call session/new. Grok waits for the user's
      // configured MCP servers there (npx plugins included), which routinely
      // exceeds the probe budget and used to mark a working CLI as broken.
      createSession: false,
    });
    const started = yield* acp.start();
    const subscription = parseGrokSubscription(started.authenticateResult);
    const billing = yield* acp.request(GROK_BILLING_METHOD, {}).pipe(Effect.option);
    const accountUsage = Option.isSome(billing) ? billing.value : undefined;
    const modelState =
      (yield* grokModelStateFromInitializeMeta(started.initializeResult._meta)) ??
      started.sessionSetupResult.models;
    const discovery: GrokAcpDiscovery = {
      models: buildGrokDiscoveredModelsFromSessionModelState(modelState),
      ...(subscription ? { subscription } : {}),
      ...(accountUsage !== undefined ? { accountUsage } : {}),
    };
    return discovery;
  }).pipe(Effect.scoped);

const runGrokVersionCommand = (
  grokSettings: GrokSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = grokSettings.binaryPath || "grok";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkGrokProviderStatus = Effect.fn("checkGrokProviderStatus")(function* (
  grokSettings: GrokSettings,
  environment: NodeJS.ProcessEnv = process.env,
  options?: { readonly acpDiscoveryTimeoutMs?: number },
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const acpDiscoveryTimeoutMs =
    options?.acpDiscoveryTimeoutMs ?? GROK_ACP_MODEL_DISCOVERY_TIMEOUT_MS;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = grokModelsFromSettings(grokSettings.customModels);

  if (!grokSettings.enabled) {
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Grok is disabled in Solla Code settings.",
      },
    });
  }

  const versionResult = yield* runGrokVersionCommand(grokSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Grok CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Grok CLI (`grok`) is not installed or not on PATH."
          : "Failed to execute Grok CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Grok CLI is installed but timed out while running `grok --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Grok CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Grok CLI is installed but failed to run.",
      },
    });
  }

  const discoveryExit = yield* discoverGrokModelsViaAcp(grokSettings, environment).pipe(
    Effect.timeoutOption(acpDiscoveryTimeoutMs),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("Grok ACP model discovery failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Grok CLI is installed but ACP startup failed. Check server logs for details.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    yield* Effect.logWarning(
      `Grok ACP model discovery timed out after ${acpDiscoveryTimeoutMs}ms.`,
    );
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: `Grok CLI is installed. ACP handshake timed out after ${acpDiscoveryTimeoutMs}ms; using built-in models.`,
      },
    });
  }
  const discovery = discoveryExit.value.value;
  const discoveredModels = discovery.models;
  const models =
    discoveredModels.length > 0
      ? grokModelsFromSettings(grokSettings.customModels, discoveredModels)
      : fallbackModels;
  const subscription = discovery.subscription;
  // Billing is grok.com-auth only. If that probe succeeded, the account is
  // signed in even when check_subscription is missing — otherwise the usage
  // bar refuses to record the snapshot.
  const authenticated =
    subscription?.authenticated === true || discovery.accountUsage !== undefined;

  return buildServerProvider({
    presentation: GROK_PRESENTATION,
    enabled: grokSettings.enabled,
    checkedAt,
    models,
    ...(discovery.accountUsage !== undefined
      ? {
          accountUsage: discovery.accountUsage,
          accountUsageReportedAt: checkedAt,
        }
      : {}),
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: authenticated
        ? {
            status: "authenticated",
            ...(subscription?.email ? { email: subscription.email } : {}),
            ...(subscription?.subscriptionTier ? { label: subscription.subscriptionTier } : {}),
          }
        : { status: "unknown" },
    },
  });
});

export const enrichGrokSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Grok version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
