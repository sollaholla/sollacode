import type { ComponentType } from "react";

import { COMPOSITION_META, type CompositionMeta } from "./compositions.meta";
import { CustomAgents } from "./scenes/CustomAgents";
import { ProviderFailover } from "./scenes/ProviderFailover";
import { TerminalWorkspaces } from "./scenes/TerminalWorkspaces";
import { ThreadArtifacts } from "./scenes/ThreadArtifacts";
import { VoiceOrchestrator } from "./scenes/VoiceOrchestrator";

const COMPONENTS: Record<string, ComponentType> = {
  "voice-orchestrator": VoiceOrchestrator,
  "custom-agents": CustomAgents,
  "terminal-workspaces": TerminalWorkspaces,
  "thread-artifacts": ThreadArtifacts,
  "provider-failover": ProviderFailover,
};

export interface Composition extends CompositionMeta {
  readonly component: ComponentType;
}

export const COMPOSITIONS: readonly Composition[] = COMPOSITION_META.map((meta) => {
  const component = COMPONENTS[meta.id];
  if (!component) throw new Error(`No component registered for composition "${meta.id}"`);
  return { ...meta, component };
});
