/**
 * Voice backends the orchestrator can speak through.
 *
 * Distinct from coding-agent providers (the Grok CLI, Codex, …). Those run
 * threads. These mint a realtime speech session. `xai` is Grok Voice via the
 * official xAI Speech-to-Speech API.
 */
import * as Schema from "effect/Schema";

export const OrchestratorVoiceProvider = Schema.Literals(["openai", "xai"]);
export type OrchestratorVoiceProvider = typeof OrchestratorVoiceProvider.Type;
export const DEFAULT_ORCHESTRATOR_VOICE_PROVIDER: OrchestratorVoiceProvider = "openai";

export const OrchestratorRealtimeTransport = Schema.Literals(["webrtc", "websocket"]);
export type OrchestratorRealtimeTransport = typeof OrchestratorRealtimeTransport.Type;

export const XAI_API_KEY_ENV = "XAI_API_KEY";
export const XAI_REALTIME_CLIENT_SECRETS_URL = "https://api.x.ai/v1/realtime/client_secrets";
export const XAI_REALTIME_WEBSOCKET_URL = "wss://api.x.ai/v1/realtime";
export const OPENAI_REALTIME_CLIENT_SECRETS_URL =
  "https://api.openai.com/v1/realtime/client_secrets";
export const OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

export const DEFAULT_XAI_REALTIME_MODEL = "grok-voice-latest";
export const DEFAULT_XAI_REALTIME_VOICE = "eve";
export const FALLBACK_XAI_REALTIME_VOICE = "eve";

/** Seconds the xAI ephemeral client secret lives. Connecting is the only use. */
export const XAI_CLIENT_SECRET_TTL_SECONDS = 600;

export interface OrchestratorVoiceProviderCapabilities {
  readonly voice: true;
  readonly ephemeralClientSecrets: boolean;
  readonly serverVad: boolean;
  readonly functionTools: boolean;
  readonly reasoningEffort: boolean;
  readonly customVoices: boolean;
  readonly transport: OrchestratorRealtimeTransport;
}

export interface OrchestratorVoiceProviderCatalog {
  readonly id: OrchestratorVoiceProvider;
  readonly label: string;
  readonly description: string;
  readonly defaultModel: string;
  readonly defaultVoice: string;
  readonly fallbackVoice: string;
  readonly models: ReadonlyArray<string>;
  readonly voices: ReadonlyArray<string>;
  readonly capabilities: OrchestratorVoiceProviderCapabilities;
}

/**
 * Built-in Grok Voice models. `grok-voice-latest` is the alias xAI documents
 * for the current flagship; the versioned names pin a release.
 */
export const XAI_REALTIME_MODELS = [
  "grok-voice-latest",
  "grok-voice-think-fast-2.0",
  "grok-voice-think-fast-1.0",
] as const;

/**
 * Built-in voices from `GET /v1/tts/voices`. Custom 8-character voice IDs are
 * also accepted at session time and are not listed here.
 */
export const XAI_REALTIME_VOICES = [
  "ara",
  "eve",
  "leo",
  "rex",
  "sal",
  "carina",
  "luna",
  "orion",
  "helix",
  "atlas",
  "altair",
  "celeste",
  "cosmo",
  "helios",
  "iris",
  "kepler",
  "lumen",
  "lux",
  "perseus",
  "rigel",
  "sirius",
  "ursa",
  "zagan",
  "zenith",
  "castor",
  "naksh",
] as const;

export const OPENAI_REALTIME_MODELS = [
  "gpt-realtime-2.1",
  "gpt-realtime-2.1-mini",
  "gpt-realtime-2",
  "gpt-realtime-2-mini",
  "gpt-realtime",
  "gpt-realtime-mini",
] as const;

export const ORCHESTRATOR_VOICE_PROVIDERS: Record<
  OrchestratorVoiceProvider,
  OrchestratorVoiceProviderCatalog
> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    description: "OpenAI Realtime over WebRTC.",
    defaultModel: "gpt-realtime",
    defaultVoice: "marin",
    fallbackVoice: "alloy",
    models: OPENAI_REALTIME_MODELS,
    voices: [
      "marin",
      "alloy",
      "cedar",
      "verse",
      "coral",
      "sage",
      "shimmer",
      "echo",
      "ash",
      "ballad",
    ],
    capabilities: {
      voice: true,
      ephemeralClientSecrets: true,
      serverVad: true,
      functionTools: true,
      reasoningEffort: true,
      customVoices: false,
      transport: "webrtc",
    },
  },
  xai: {
    id: "xai",
    label: "Grok",
    description: "Grok Voice via the xAI Speech-to-Speech API.",
    defaultModel: DEFAULT_XAI_REALTIME_MODEL,
    defaultVoice: DEFAULT_XAI_REALTIME_VOICE,
    fallbackVoice: FALLBACK_XAI_REALTIME_VOICE,
    models: XAI_REALTIME_MODELS,
    voices: XAI_REALTIME_VOICES,
    capabilities: {
      voice: true,
      ephemeralClientSecrets: true,
      serverVad: true,
      functionTools: true,
      reasoningEffort: true,
      customVoices: true,
      transport: "websocket",
    },
  },
};

export function orchestratorVoiceProviderCatalog(
  provider: string,
): OrchestratorVoiceProviderCatalog {
  return provider === "xai"
    ? ORCHESTRATOR_VOICE_PROVIDERS.xai
    : ORCHESTRATOR_VOICE_PROVIDERS.openai;
}

export function isOrchestratorVoiceProvider(value: string): value is OrchestratorVoiceProvider {
  return value === "openai" || value === "xai";
}

/** xAI custom voices are an 8-character lowercase alphanumeric id. */
export function isXaiCustomVoiceId(voice: string): boolean {
  return /^[a-z0-9]{8}$/.test(voice);
}

export function isUsableOrchestratorVoice(
  provider: OrchestratorVoiceProvider,
  voice: string,
): boolean {
  const trimmed = voice.trim();
  if (trimmed.length === 0) return false;
  const catalog = ORCHESTRATOR_VOICE_PROVIDERS[provider];
  if (catalog.voices.includes(trimmed)) return true;
  if (provider === "xai") return isXaiCustomVoiceId(trimmed);
  // OpenAI accepts account-specific names the picker does not list.
  return true;
}

/**
 * When the user switches backend, keep a model/voice that still exists and
 * otherwise land on that backend's defaults. An OpenAI model name left on Grok
 * would fail at connect time.
 */
export function resolveOrchestratorVoiceSelection(input: {
  readonly provider: OrchestratorVoiceProvider;
  readonly model: string;
  readonly voice: string;
}): { readonly model: string; readonly voice: string } {
  const catalog = ORCHESTRATOR_VOICE_PROVIDERS[input.provider];
  const model = (catalog.models as ReadonlyArray<string>).includes(input.model)
    ? input.model
    : catalog.defaultModel;
  const voice = isUsableOrchestratorVoice(input.provider, input.voice)
    ? input.voice.trim()
    : catalog.defaultVoice;
  return { model, voice };
}

/**
 * xAI rejects bare `es` / `pt` language hints. Map the orchestrator's ISO-639-1
 * pin onto a regional BCP-47 code the Speech-to-Speech API accepts.
 */
export function xaiLanguageHint(language: string): string {
  const code = language.trim();
  if (code === "es") return "es-MX";
  if (code === "pt") return "pt-BR";
  if (code === "ar") return "ar-SA";
  return code;
}

export function buildXaiRealtimeWebsocketUrl(model: string): string {
  return `${XAI_REALTIME_WEBSOCKET_URL}?model=${encodeURIComponent(model)}`;
}

export function xaiClientSecretProtocol(token: string): string {
  return `xai-client-secret.${token}`;
}
