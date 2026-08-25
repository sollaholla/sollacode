import { type GrokSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { normalizeModelSlug } from "@t3tools/shared/model";

import { extractModelConfigId } from "./AcpRuntimeModel.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { makeXAiPromptCompletionRuntime } from "./XAiAcpExtension.ts";

const GROK_API_KEY_ENV = "XAI_API_KEY";
const GROK_OAUTH2_REFERRER_ENV = "GROK_OAUTH2_REFERRER";
const T3_CODE_OAUTH_REFERRER = "t3code";
/** Bound MCP plugin startup so `session/new` cannot hang the GUI forever. */
const GROK_MCP_STARTUP_TIMEOUT_SECS = "8";
const GROK_MCP_TIMEOUT_MS = "8000";
const GROK_ACP_FORCE_KILL_AFTER = "2 seconds" as const;
const GROK_AUTH_METHOD_API_KEY = "xai.api_key";
const GROK_AUTH_METHOD_CACHED_TOKEN = "cached_token";
const GROK_DRIVER_KIND = ProviderDriverKind.make("grok");

type GrokAcpRuntimeGrokSettings = Pick<GrokSettings, "binaryPath">;

interface GrokAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly grokSettings: GrokAcpRuntimeGrokSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

function grokAcpSpawnEnv(environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...environment,
    ...(environment?.[GROK_OAUTH2_REFERRER_ENV]
      ? {}
      : { [GROK_OAUTH2_REFERRER_ENV]: T3_CODE_OAUTH_REFERRER }),
    // Default MCP plugin startup is 30s per server. Hung npx plugins make
    // ACP `session/new` look like Grok never started, while the TTY CLI still
    // comes up. Callers can override either env var.
    ...(environment?.GROK_MCP_STARTUP_TIMEOUT_SECS ? {} : { GROK_MCP_STARTUP_TIMEOUT_SECS }),
    ...(environment?.MCP_TIMEOUT ? {} : { MCP_TIMEOUT: GROK_MCP_TIMEOUT_MS }),
  };
}

export function buildGrokAcpSpawnInput(
  grokSettings: GrokAcpRuntimeGrokSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: grokSettings?.binaryPath || "grok",
    args: ["agent", "stdio"],
    cwd,
    env: grokAcpSpawnEnv(environment),
    forceKillAfter: GROK_ACP_FORCE_KILL_AFTER,
  };
}

function grokAcpMcpServerTransport(server: EffectAcpSchema.McpServer): "http" | "sse" | "stdio" {
  return "type" in server ? server.type : "stdio";
}

export function filterGrokAcpMcpServers(
  servers: ReadonlyArray<EffectAcpSchema.McpServer>,
  agentCapabilities: EffectAcpSchema.AgentCapabilities | undefined,
): ReadonlyArray<EffectAcpSchema.McpServer> {
  return servers.filter((server) => {
    const transport = grokAcpMcpServerTransport(server);
    if (transport === "stdio") {
      return true;
    }
    return agentCapabilities?.mcpCapabilities?.[transport] === true;
  });
}

function resolveGrokAuthMethodId(environment: NodeJS.ProcessEnv | undefined): string {
  return environment?.[GROK_API_KEY_ENV]?.trim()
    ? GROK_AUTH_METHOD_API_KEY
    : GROK_AUTH_METHOD_CACHED_TOKEN;
}

export const makeGrokAcpRuntime = (
  input: GrokAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildGrokAcpSpawnInput(input.grokSettings, input.cwd, input.environment),
        authMethodId: resolveGrokAuthMethodId(input.environment),
        authenticateMeta: input.authenticateMeta ?? { headless: true },
        filterMcpServers: input.filterMcpServers ?? filterGrokAcpMcpServers,
        // Grok's TTY CLI often needs a second confirm (Enter / Esc while
        // already cancelling) before the turn actually stops. Repeat the ACP
        // cancel after Grok has had a chance to enter that state so Stop in the
        // GUI matches that gesture instead of sending two same-tick duplicates.
        extraCancelNotifications: 1,
        extraCancelNotificationDelay: "50 millis",
        cancelNotificationMeta: { cancelTrigger: "esc" },
        sessionCreateTimeout: "45 seconds",
        // Grok queues concurrent session/prompt requests itself and runs them
        // at the next turn boundary. Serializing them client-side left
        // mid-turn user messages stuck inside this process, marked delivered
        // but never handed to the CLI.
        concurrentPrompts: true,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
    return yield* makeXAiPromptCompletionRuntime(runtime);
  });

export function resolveGrokAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : "grok-build";
  return normalizeModelSlug(base, GROK_DRIVER_KIND) ?? "grok-build";
}

const GROK_GENERIC_ACP_MODEL_IDS = new Set(["grok-build"]);

export function currentGrokModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function advertisedGrokAcpModelIds(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse
    | undefined,
): ReadonlyArray<string> {
  return (sessionSetupResult?.models?.availableModels ?? [])
    .map((model) => model.modelId.trim())
    .filter((modelId) => modelId.length > 0);
}

export function resolveGrokAcpSessionModelId(input: {
  readonly requestedModelId: string | undefined;
  readonly currentModelId: string | undefined;
  readonly sessionSetupResult?:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse;
}): string | undefined {
  const requested = input.requestedModelId;
  if (requested === undefined) {
    return undefined;
  }
  const available = advertisedGrokAcpModelIds(input.sessionSetupResult);
  if (available.length === 0 || available.includes(requested)) {
    return requested;
  }
  if (!GROK_GENERIC_ACP_MODEL_IDS.has(requested)) {
    return requested;
  }
  const current = input.currentModelId?.trim() || undefined;
  if (current && available.includes(current)) {
    return current;
  }
  const advertisedCurrent = input.sessionSetupResult
    ? currentGrokModelIdFromSessionSetup(input.sessionSetupResult)
    : undefined;
  if (advertisedCurrent && available.includes(advertisedCurrent)) {
    return advertisedCurrent;
  }
  return available[0];
}

export interface GrokAcpModelSelectionState {
  readonly modelId: string | undefined;
  readonly reasoningEffort: string | undefined;
}

export function applyGrokAcpModelSelection<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "setSessionModel" | "setConfigOption"
  >;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  /** Last reasoning effort applied to this session, if any. */
  readonly currentEffort?: string | undefined;
  /** Reasoning effort selected for this turn ("effort" model option). */
  readonly requestedEffort?: string | undefined;
  readonly sessionSetupResult?:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<GrokAcpModelSelectionState, E> {
  const requestedModelId = resolveGrokAcpSessionModelId(input);
  const shouldSwitchModel =
    requestedModelId !== undefined && requestedModelId !== input.currentModelId;
  const shouldApplyEffort =
    input.requestedEffort !== undefined && input.requestedEffort !== input.currentEffort;
  const resolvedModelId = requestedModelId ?? input.currentModelId;
  if (!shouldSwitchModel && !shouldApplyEffort) {
    return Effect.succeed({ modelId: resolvedModelId, reasoningEffort: input.currentEffort });
  }
  // Grok applies reasoning effort through `session/set_model` metadata: the
  // request re-selects the (possibly unchanged) model and carries the effort
  // in `_meta.reasoningEffort`, confirmed back via a `model_changed`
  // notification.
  if (shouldApplyEffort && resolvedModelId !== undefined) {
    return input.runtime
      .setSessionModel(resolvedModelId, { reasoningEffort: input.requestedEffort })
      .pipe(
        Effect.mapError(input.mapError),
        Effect.as({ modelId: resolvedModelId, reasoningEffort: input.requestedEffort }),
      );
  }
  if (!shouldSwitchModel) {
    return Effect.succeed({ modelId: resolvedModelId, reasoningEffort: input.currentEffort });
  }
  const modelConfigId = input.sessionSetupResult
    ? extractModelConfigId(input.sessionSetupResult)
    : undefined;
  if (modelConfigId !== undefined) {
    return input.runtime
      .setConfigOption(modelConfigId, requestedModelId)
      .pipe(
        Effect.mapError(input.mapError),
        Effect.as({ modelId: requestedModelId, reasoningEffort: input.currentEffort }),
      );
  }
  return input.runtime
    .setSessionModel(requestedModelId)
    .pipe(
      Effect.mapError(input.mapError),
      Effect.as({ modelId: requestedModelId, reasoningEffort: input.currentEffort }),
    );
}
