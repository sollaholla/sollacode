import {
  type OrchestratorRealtimeTransport,
  type OrchestratorVoiceProvider,
  OPENAI_REALTIME_CLIENT_SECRETS_URL,
  XAI_API_KEY_ENV,
  XAI_CLIENT_SECRET_TTL_SECONDS,
  XAI_REALTIME_CLIENT_SECRETS_URL,
  buildXaiRealtimeWebsocketUrl,
  orchestratorVoiceProviderCatalog,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  LEGACY_ORCHESTRATOR_API_KEY_SECRET_NAME,
  orchestratorApiKeySecretName,
} from "./OrchestratorSecretNames.ts";

const textDecoder = new TextDecoder();

export class OrchestratorApiKeyMissingError extends Schema.TaggedErrorClass<OrchestratorApiKeyMissingError>()(
  "OrchestratorApiKeyMissingError",
  {},
) {
  override get message(): string {
    return "No orchestrator API key is configured.";
  }
}

export class OrchestratorTokenMintError extends Schema.TaggedErrorClass<OrchestratorTokenMintError>()(
  "OrchestratorTokenMintError",
  {
    status: Schema.optional(Schema.Number),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Failed to mint an orchestrator realtime token: ${this.detail}`;
  }
}

/**
 * Reads the stored orchestrator key. Server-side only — this value must never
 * be returned over the wire; callers mint a short-lived client secret from it
 * instead.
 */
export const readOrchestratorApiKey = (provider: OrchestratorVoiceProvider) =>
  Effect.gen(function* () {
    const secretStore = yield* ServerSecretStore.ServerSecretStore;
    const read = (name: string) =>
      secretStore
        .get(name)
        .pipe(Effect.catchCause(() => Effect.succeed(Option.none<Uint8Array>())));
    const providerKey = yield* read(orchestratorApiKeySecretName(provider));
    // The fallback keeps token minting safe during a rolling upgrade if the
    // settings service has not yet copied the old single-slot secret.
    const stored = Option.isSome(providerKey)
      ? providerKey
      : yield* read(LEGACY_ORCHESTRATOR_API_KEY_SECRET_NAME);
    if (Option.isNone(stored)) {
      return Option.none<string>();
    }
    const value = textDecoder.decode(stored.value).trim();
    return value.length > 0 ? Option.some(value) : Option.none<string>();
  });

/** xAI's documented env var, used only when no stored orchestrator key exists. */
export const readXaiEnvApiKey = Effect.gen(function* () {
  const env = yield* HostProcessEnvironment;
  const value = env[XAI_API_KEY_ENV]?.trim();
  return value !== undefined && value.length > 0 ? Option.some(value) : Option.none<string>();
});

/**
 * Resolves the long-lived key for the selected voice backend.
 *
 * The stored orchestrator secret wins so Settings → Orchestrator stays the
 * source of truth. For Grok, `XAI_API_KEY` is accepted as a fallback so a
 * machine that already has the xAI CLI configured can start voice without
 * pasting the same key again.
 */
export const resolveOrchestratorApiKey = (provider: OrchestratorVoiceProvider) =>
  Effect.gen(function* () {
    const stored = yield* readOrchestratorApiKey(provider);
    if (Option.isSome(stored)) return stored;
    if (provider === "xai") return yield* readXaiEnvApiKey;
    return Option.none<string>();
  });

/**
 * The client-secret payload has moved between shapes across API revisions
 * (`{value}` at the top level vs nested under `client_secret`). Accepting both
 * keeps this from breaking on the next revision.
 */
const RealtimeClientSecretResponse = Schema.Struct({
  value: Schema.optional(Schema.String),
  expires_at: Schema.optional(Schema.Number),
  client_secret: Schema.optional(
    Schema.Struct({
      value: Schema.optional(Schema.String),
      expires_at: Schema.optional(Schema.Number),
    }),
  ),
});

export interface OrchestratorRealtimeToken {
  readonly value: string;
  readonly expiresAt: number | undefined;
  readonly model: string;
  /** The voice actually minted, which may not be the one that was asked for. */
  readonly voice: string;
  readonly provider: OrchestratorVoiceProvider;
  readonly transport: OrchestratorRealtimeTransport;
  /** WebSocket URL for Grok. Absent on the OpenAI WebRTC path. */
  readonly realtimeUrl?: string;
  /** Set when the requested voice was refused and this one was used instead. */
  readonly fellBackFrom?: string;
}

/**
 * The voice used when the configured OpenAI one is refused.
 *
 * "alloy" is the oldest and most widely supported name in the Realtime API, so
 * it is the safest thing to land on. A rejected voice is a configuration
 * problem, and failing the whole session over it means the user cannot talk to
 * the orchestrator at all — a worse outcome than being answered in a voice they
 * did not pick, which they can hear and change.
 */
export const FALLBACK_REALTIME_VOICE = "alloy";

/**
 * Whether a mint failure is the account being out of money.
 *
 * Worth singling out because it is the one failure the user can fix and the one
 * they cannot diagnose: everything keeps working — settings save, the key is
 * valid, the token even mints — right up until the session refuses to open. The
 * generic "could not start a voice session" sent them looking at the app.
 */
export function isQuotaExhausted(status: number | undefined, detail: string): boolean {
  if (status === 402) return true;
  return /insufficient_quota|credit_balance_exhausted|no credits remaining|exceeded your current quota|insufficient.?credits|doesn'?t have any credits|credits or licenses/i.test(
    detail,
  );
}

/**
 * Pulls a speakable billing reason out of a mint error body.
 *
 * xAI answers a team with no prepaid Voice access as HTTP 403 plus a JSON
 * `{error}` string that already says what to do. That used to be logged and
 * replaced with "Could not start a voice session", which sent people debugging
 * the app.
 */
export function describeMintFailure(detail: string): string | undefined {
  const trimmed = detail.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const error = record.error;
      if (typeof error === "string" && error.trim().length > 0) return error.trim();
      const message = record.message;
      if (typeof message === "string" && message.trim().length > 0) return message.trim();
    }
  } catch {
    // Not JSON — the raw body may still be readable.
  }
  return undefined;
}

/** Said to the user verbatim. Names the cause and where to fix it. */
export const QUOTA_EXHAUSTED_MESSAGE =
  "Your OpenAI account has no credits left, so voice cannot start. Add credits at platform.openai.com and try again — your key and settings are fine.";

export const XAI_QUOTA_EXHAUSTED_MESSAGE =
  "Your xAI account has no credits left, so Grok voice cannot start. Add credits at console.x.ai and try again — your key and settings are fine.";

export function quotaExhaustedMessage(provider: OrchestratorVoiceProvider): string {
  return provider === "xai" ? XAI_QUOTA_EXHAUSTED_MESSAGE : QUOTA_EXHAUSTED_MESSAGE;
}

export function isVoiceRejection(status: number | undefined, detail: string): boolean {
  if (status !== undefined && (status < 400 || status >= 500)) return false;
  return /voice/i.test(detail);
}

export function openaiClientSecretBody(input: {
  readonly model: string;
  readonly voice: string;
}): unknown {
  return {
    session: {
      type: "realtime",
      model: input.model,
      audio: { output: { voice: input.voice } },
    },
  };
}

/**
 * xAI's ephemeral-token endpoint documents `expires_after` only. Model and
 * voice are applied on the WebSocket (`?model=`) and `session.update`.
 */
export function xaiClientSecretBody(): unknown {
  return { expires_after: { seconds: XAI_CLIENT_SECRET_TTL_SECONDS } };
}

const mintClientSecret = (input: {
  readonly provider: OrchestratorVoiceProvider;
  readonly model: string;
  readonly voice: string;
  readonly url: string;
  readonly body: unknown;
}) =>
  Effect.gen(function* () {
    const apiKey = yield* resolveOrchestratorApiKey(input.provider);
    if (Option.isNone(apiKey)) {
      return yield* new OrchestratorApiKeyMissingError();
    }

    const client = yield* HttpClient.HttpClient;
    const request = yield* HttpClientRequest.post(input.url).pipe(
      HttpClientRequest.setHeader("authorization", `Bearer ${apiKey.value}`),
      HttpClientRequest.bodyJson(input.body),
      Effect.mapError(
        (cause) =>
          new OrchestratorTokenMintError({
            detail: cause instanceof Error ? cause.message : "could not encode request body",
          }),
      ),
    );

    const response = yield* client.execute(request).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestratorTokenMintError({
            detail: cause instanceof Error ? cause.message : "network request failed",
          }),
      ),
    );

    if (response.status < 200 || response.status >= 300) {
      const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      // Deliberately does not echo the request: it carries the Authorization header.
      return yield* new OrchestratorTokenMintError({
        status: response.status,
        detail: body.slice(0, 400) || `HTTP ${response.status}`,
      });
    }

    const payload = yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(RealtimeClientSecretResponse)),
      Effect.mapError(
        () => new OrchestratorTokenMintError({ detail: "response was not a client secret" }),
      ),
    );

    const value = payload.value ?? payload.client_secret?.value;
    if (value === undefined || value.length === 0) {
      return yield* new OrchestratorTokenMintError({
        detail: "response did not contain a client secret",
      });
    }

    const catalog = orchestratorVoiceProviderCatalog(input.provider);
    return {
      value,
      expiresAt: payload.expires_at ?? payload.client_secret?.expires_at,
      model: input.model,
      voice: input.voice,
      provider: input.provider,
      transport: catalog.capabilities.transport,
      ...(input.provider === "xai"
        ? { realtimeUrl: buildXaiRealtimeWebsocketUrl(input.model) }
        : {}),
    };
  });

const mintOpenAi = (input: { readonly model: string; readonly voice: string }) =>
  mintClientSecret({
    provider: "openai",
    model: input.model,
    voice: input.voice,
    url: OPENAI_REALTIME_CLIENT_SECRETS_URL,
    body: openaiClientSecretBody(input),
  });

const mintXai = (input: { readonly model: string; readonly voice: string }) =>
  mintClientSecret({
    provider: "xai",
    model: input.model,
    voice: input.voice,
    url: XAI_REALTIME_CLIENT_SECRETS_URL,
    body: xaiClientSecretBody(),
  });

/**
 * Exchanges the long-lived API key for an ephemeral client secret the browser
 * can use to open a realtime session. This is the whole reason the key is
 * server-held: the renderer never sees it, and a leaked ephemeral token
 * expires on its own.
 *
 * OpenAI binds voice at mint time, so a refused name is retried once on
 * {@link FALLBACK_REALTIME_VOICE}. Grok applies voice on `session.update`, so
 * a mint failure there is never a voice problem and is not retried.
 */
export const mintRealtimeToken = (input: {
  readonly provider?: OrchestratorVoiceProvider;
  readonly model: string;
  readonly voice: string;
}) => {
  const provider = input.provider ?? "openai";
  if (provider === "xai") {
    return mintXai({ model: input.model, voice: input.voice });
  }

  return mintOpenAi(input).pipe(
    Effect.catchIf(
      (error): error is OrchestratorTokenMintError =>
        error._tag === "OrchestratorTokenMintError" &&
        input.voice !== FALLBACK_REALTIME_VOICE &&
        isVoiceRejection(error.status, error.detail ?? ""),
      (error) =>
        Effect.logWarning("orchestrator voice refused; falling back", {
          requestedVoice: input.voice,
          fallbackVoice: FALLBACK_REALTIME_VOICE,
          detail: error.detail,
        }).pipe(
          Effect.andThen(
            mintOpenAi({ model: input.model, voice: FALLBACK_REALTIME_VOICE }).pipe(
              Effect.map((token) => ({ ...token, fellBackFrom: input.voice })),
            ),
          ),
        ),
    ),
  );
};
