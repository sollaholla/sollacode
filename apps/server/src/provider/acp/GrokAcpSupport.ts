// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { type GrokSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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

/**
 * A silent token refresh answers in a second or two. Past this, Grok is
 * waiting for a person to finish signing in, and nobody is watching.
 */
const GROK_AUTHENTICATE_TIMEOUT = "20 seconds" as const;

/**
 * The auth method to send, chosen from what this Grok build advertises.
 *
 * Grok 1.0.41 advertises only `grok.com`. Sent the retired `cached_token` id,
 * it ignored `headless` and ran its browser login, so every background start
 * without a usable sign-in opened a Chrome tab at auth.x.ai (2026-10-11). Sent
 * an advertised id, `headless` holds and a stored session refreshes silently.
 * Without one, Grok falls back to its device-code login, which opens the
 * browser too, so `makeGrokAcpRuntime` only starts Grok on a stored sign-in.
 */
export function selectGrokAuthMethodId(
  initializeResult: Pick<EffectAcpSchema.InitializeResponse, "authMethods" | "_meta">,
  environment: NodeJS.ProcessEnv | undefined,
): string {
  const advertised = (initializeResult.authMethods ?? []).map((method) => method.id);
  const fallback = resolveGrokAuthMethodId(environment);
  if (advertised.length === 0 || advertised.includes(fallback)) return fallback;
  if (fallback === GROK_AUTH_METHOD_API_KEY) {
    const apiKeyMethod = advertised.find((id) => /api[._-]?key/i.test(id));
    if (apiKeyMethod !== undefined) return apiKeyMethod;
  }
  const preferred = initializeResult._meta?.["defaultAuthMethodId"];
  return typeof preferred === "string" && advertised.includes(preferred)
    ? preferred
    : advertised[0]!;
}

const isAcpTransportError = Schema.is(EffectAcpErrors.AcpTransportError);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);
const ACP_AUTH_REQUIRED_CODE = -32000;

export const GROK_NOT_SIGNED_IN_MESSAGE =
  "Grok CLI is not signed in. Run `grok login` and try again.";

/** Environment variables that sign Grok in without a person. */
const GROK_CREDENTIAL_ENV = [
  GROK_API_KEY_ENV,
  "GROK_CODE_XAI_API_KEY",
  "GROK_AUTH",
  "GROK_AUTH_PROVIDER_COMMAND",
  "GROK_AUTH_PROVIDER_ACCESS_TOKEN",
] as const;
const GROK_ENVIRONMENT_SIGN_IN = "environment";

export type GrokAuthFileStat = (
  filePath: string,
) => { readonly mtimeMs: number; readonly size: number } | undefined;

function statGrokAuthFile(filePath: string) {
  try {
    const stat = NodeFS.statSync(filePath);
    return stat.isFile() ? { mtimeMs: stat.mtimeMs, size: stat.size } : undefined;
  } catch {
    return undefined;
  }
}

/** Injectable so tests can describe a signed-in or signed-out Grok home. */
export const GrokAuthFileStat = Context.Reference<GrokAuthFileStat>(
  "server/provider/acp/GrokAuthFileStat",
  { defaultValue: () => statGrokAuthFile },
);

/**
 * The sign-in Grok can use without a person: credentials in its environment,
 * or a non-empty `auth.json` it can refresh, keyed by path, mtime and size so
 * a fresh `grok login` reads as a new sign-in. Null when there is none.
 */
export function findGrokStoredSignIn(
  environment: NodeJS.ProcessEnv,
  statFile: GrokAuthFileStat,
): string | null {
  if (GROK_CREDENTIAL_ENV.some((name) => environment[name]?.trim())) {
    return GROK_ENVIRONMENT_SIGN_IN;
  }
  const homes = [environment.HOME, environment.USERPROFILE].flatMap((home) =>
    home?.trim() ? [home.trim()] : [],
  );
  const grokHome = environment.GROK_HOME?.trim();
  const candidates = [
    environment.GROK_AUTH_PATH?.trim(),
    grokHome ? NodePath.join(grokHome, "auth.json") : undefined,
    ...(homes.length > 0 ? homes : [NodeOS.homedir()]).map((home) =>
      NodePath.join(home, ".grok", "auth.json"),
    ),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const stat = statFile(candidate);
    if (stat !== undefined && stat.size > 0) {
      return `${candidate}:${stat.mtimeMs}:${stat.size}`;
    }
  }
  return null;
}

/**
 * Stored sign-ins whose silent refresh failed and left Grok waiting for a
 * person. Grok is not started on them again until `auth.json` changes, so a
 * stale sign-in cannot open a browser tab on every status check.
 */
const grokSignInsAwaitingPerson = new Set<string>();

/**
 * Whether a Grok start failed at `authenticate`, by refusal or by waiting past
 * GROK_AUTHENTICATE_TIMEOUT, or was refused before starting for want of a
 * stored sign-in: either way the CLI needs `grok login`.
 */
export function isGrokAuthenticateFailure(cause: Cause.Cause<unknown>): boolean {
  const error = Option.getOrNull(Cause.findErrorOption(cause));
  return (
    ((isAcpTransportError(error) || isAcpRequestError(error)) && error.method === "authenticate") ||
    (isAcpRequestError(error) && error.code === ACP_AUTH_REQUIRED_CODE)
  );
}

function isGrokSignInWait(cause: Cause.Cause<unknown>): boolean {
  const error = Option.getOrNull(Cause.findErrorOption(cause));
  return (
    isAcpTransportError(error) && error.method === "authenticate" && error.operation === "call-rpc"
  );
}

export const makeGrokAcpRuntime = (
  input: GrokAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    // Without a stored sign-in, `authenticate` can only run Grok's browser or
    // device-code login: a sign-in tab nobody asked for.
    const signIn = findGrokStoredSignIn(
      { ...process.env, ...input.environment },
      yield* GrokAuthFileStat,
    );
    if (signIn === null || grokSignInsAwaitingPerson.has(signIn)) {
      return yield* EffectAcpErrors.AcpRequestError.authRequired(GROK_NOT_SIGNED_IN_MESSAGE);
    }
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildGrokAcpSpawnInput(input.grokSettings, input.cwd, input.environment),
        authMethodId: resolveGrokAuthMethodId(input.environment),
        resolveAuthMethodId: (initializeResult) =>
          selectGrokAuthMethodId(initializeResult, input.environment),
        authenticateMeta: input.authenticateMeta ?? { headless: true },
        authenticateTimeout: input.authenticateTimeout ?? GROK_AUTHENTICATE_TIMEOUT,
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
    return yield* makeXAiPromptCompletionRuntime({
      ...runtime,
      start: () =>
        runtime
          .start()
          .pipe(
            Effect.tapCause((cause) =>
              signIn !== GROK_ENVIRONMENT_SIGN_IN && isGrokSignInWait(cause)
                ? Effect.sync(() => grokSignInsAwaitingPerson.add(signIn))
                : Effect.void,
            ),
          ),
    });
  });

export function resolveGrokAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : "grok-build";
  return normalizeModelSlug(base, GROK_DRIVER_KIND) ?? "grok-build";
}

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

/**
 * Maps the model Solla wants onto one the Grok agent will accept. The agent
 * validates `session/set_model` against its live catalog and answers anything
 * else with JSON-RPC "Invalid params", so an id it does not advertise — the
 * generic `grok-build` slug, or a model xAI has since retired (grok-4.6 was
 * dropped from the catalog on 2026-09-23 and every thread still selecting it
 * failed its next turn) — falls back to the model the session is already on,
 * then the agent's advertised default. Only an empty list, which means the
 * agent told us nothing, lets the requested id through unchecked.
 */
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

/**
 * Drops a requested reasoning effort that `modelId` explicitly does not offer,
 * such as `xhigh` carried over from a model that had it. When the agent lists
 * no levels for the model, the effort is left for the agent to judge.
 */
export function resolveGrokAcpSessionEffort(input: {
  readonly modelId: string | undefined;
  readonly requestedEffort: string | undefined;
  readonly sessionSetupResult?:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse
    | undefined;
}): string | undefined {
  if (input.requestedEffort === undefined || input.modelId === undefined) {
    return input.requestedEffort;
  }
  const model = input.sessionSetupResult?.models?.availableModels.find(
    (candidate) => candidate.modelId.trim() === input.modelId,
  );
  const levels = grokReasoningEffortLevelsFromModelMeta(model?._meta);
  return levels.length === 0 || levels.some((level) => level.value === input.requestedEffort)
    ? input.requestedEffort
    : undefined;
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
  const resolvedModelId = requestedModelId ?? input.currentModelId;
  const requestedEffort = resolveGrokAcpSessionEffort({
    modelId: resolvedModelId,
    requestedEffort: input.requestedEffort,
    sessionSetupResult: input.sessionSetupResult,
  });
  const shouldApplyEffort =
    requestedEffort !== undefined && requestedEffort !== input.currentEffort;
  if (!shouldSwitchModel && !shouldApplyEffort) {
    return Effect.succeed({ modelId: resolvedModelId, reasoningEffort: input.currentEffort });
  }
  // Grok applies reasoning effort through `session/set_model` metadata: the
  // request re-selects the (possibly unchanged) model and carries the effort
  // in `_meta.reasoningEffort`, confirmed back via a `model_changed`
  // notification.
  if (shouldApplyEffort && resolvedModelId !== undefined) {
    return input.runtime
      .setSessionModel(resolvedModelId, { reasoningEffort: requestedEffort })
      .pipe(
        Effect.mapError(input.mapError),
        Effect.as({ modelId: resolvedModelId, reasoningEffort: requestedEffort }),
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
