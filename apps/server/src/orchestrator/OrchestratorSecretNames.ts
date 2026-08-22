import type { OrchestratorVoiceProvider } from "@t3tools/contracts";

/** Secret name used by builds that stored both voice providers in one slot. */
export const LEGACY_ORCHESTRATOR_API_KEY_SECRET_NAME = "orchestrator-api-key";

export const ORCHESTRATOR_OPENAI_API_KEY_SECRET_NAME = "orchestrator-openai-api-key";
export const ORCHESTRATOR_XAI_API_KEY_SECRET_NAME = "orchestrator-xai-api-key";

export function orchestratorApiKeySecretName(provider: OrchestratorVoiceProvider): string {
  return provider === "xai"
    ? ORCHESTRATOR_XAI_API_KEY_SECRET_NAME
    : ORCHESTRATOR_OPENAI_API_KEY_SECRET_NAME;
}
