import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_ORCHESTRATOR_VOICE_PROVIDER,
  ORCHESTRATOR_VOICE_PROVIDERS,
  buildXaiRealtimeWebsocketUrl,
  isOrchestratorVoiceProvider,
  isUsableOrchestratorVoice,
  isXaiCustomVoiceId,
  resolveOrchestratorVoiceSelection,
  xaiClientSecretProtocol,
  xaiLanguageHint,
} from "./orchestratorVoice.ts";

describe("orchestrator voice providers", () => {
  it("defaults to OpenAI so existing settings stay valid", () => {
    expect(DEFAULT_ORCHESTRATOR_VOICE_PROVIDER).toBe("openai");
    expect(isOrchestratorVoiceProvider("openai")).toBe(true);
    expect(isOrchestratorVoiceProvider("xai")).toBe(true);
    expect(isOrchestratorVoiceProvider("grok")).toBe(false);
  });

  it("advertises voice as a capability on every registered backend", () => {
    for (const catalog of Object.values(ORCHESTRATOR_VOICE_PROVIDERS)) {
      expect(catalog.capabilities.voice).toBe(true);
      expect(catalog.capabilities.ephemeralClientSecrets).toBe(true);
      expect(catalog.models.length).toBeGreaterThan(0);
      expect(catalog.voices.length).toBeGreaterThan(0);
    }
  });

  it("uses WebSocket for Grok and WebRTC for OpenAI", () => {
    expect(ORCHESTRATOR_VOICE_PROVIDERS.xai.capabilities.transport).toBe("websocket");
    expect(ORCHESTRATOR_VOICE_PROVIDERS.openai.capabilities.transport).toBe("webrtc");
  });
});

describe("resolveOrchestratorVoiceSelection", () => {
  it("keeps a Grok model and voice that the catalog knows", () => {
    expect(
      resolveOrchestratorVoiceSelection({
        provider: "xai",
        model: "grok-voice-think-fast-2.0",
        voice: "ara",
      }),
    ).toEqual({ model: "grok-voice-think-fast-2.0", voice: "ara" });
  });

  it("replaces an OpenAI model when switching to Grok", () => {
    expect(
      resolveOrchestratorVoiceSelection({
        provider: "xai",
        model: "gpt-realtime",
        voice: "marin",
      }),
    ).toEqual({
      model: ORCHESTRATOR_VOICE_PROVIDERS.xai.defaultModel,
      voice: ORCHESTRATOR_VOICE_PROVIDERS.xai.defaultVoice,
    });
  });

  it("accepts an xAI custom voice id", () => {
    expect(isXaiCustomVoiceId("nlbqfwie")).toBe(true);
    expect(isUsableOrchestratorVoice("xai", "nlbqfwie")).toBe(true);
    expect(
      resolveOrchestratorVoiceSelection({
        provider: "xai",
        model: "grok-voice-latest",
        voice: "nlbqfwie",
      }).voice,
    ).toBe("nlbqfwie");
  });
});

describe("xAI language hints", () => {
  it("expands Spanish and Portuguese to a regional variant the API accepts", () => {
    expect(xaiLanguageHint("es")).toBe("es-MX");
    expect(xaiLanguageHint("pt")).toBe("pt-BR");
    expect(xaiLanguageHint("ar")).toBe("ar-SA");
    expect(xaiLanguageHint("en")).toBe("en");
    expect(xaiLanguageHint("ja")).toBe("ja");
  });
});

describe("xAI connection helpers", () => {
  it("puts the model on the WebSocket query string", () => {
    expect(buildXaiRealtimeWebsocketUrl("grok-voice-latest")).toBe(
      "wss://api.x.ai/v1/realtime?model=grok-voice-latest",
    );
  });

  it("prefixes the ephemeral token for browser WebSocket auth", () => {
    expect(xaiClientSecretProtocol("secret-1")).toBe("xai-client-secret.secret-1");
  });
});
