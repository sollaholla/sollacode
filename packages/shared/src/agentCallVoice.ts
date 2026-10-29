import { OPENAI_LIVE_VOICES } from "@t3tools/contracts";

/** A GPT-Live voice an agent can speak with on calls. */
export type AgentCallVoice = (typeof OPENAI_LIVE_VOICES)[number];

/**
 * How each voice sounds, from OpenAI's GPT-Live voice table, for pickers:
 * the accent it speaks with, and its presentation.
 */
export const AGENT_CALL_VOICE_DETAILS: Readonly<
  Record<AgentCallVoice, { readonly label: string; readonly detail: string }>
> = {
  marin: { label: "Marin", detail: "The GPT-Live default" },
  quartz: { label: "Quartz", detail: "Australian, feminine" },
  ripple: { label: "Ripple", detail: "Australian, masculine" },
  vesper: { label: "Vesper", detail: "British, masculine" },
  willow: { label: "Willow", detail: "Irish, feminine" },
  stone: { label: "Stone", detail: "Irish, masculine" },
  gleam: { label: "Gleam", detail: "North American, feminine" },
  meridian: { label: "Meridian", detail: "North American, masculine" },
  bossa: { label: "Bossa", detail: "Brazilian Portuguese, feminine" },
  tempo: { label: "Tempo", detail: "Brazilian Portuguese, masculine" },
  beacon: { label: "Beacon", detail: "Filipino English, masculine" },
  delta: { label: "Delta", detail: "Southern U.S., feminine" },
  cinder: { label: "Cinder", detail: "Southern U.S., masculine" },
};

/**
 * The English voices an agent without a chosen voice is given, ordered so
 * that agents created one after another alternate in accent and
 * presentation, starting with the GPT-Live default.
 */
const AUTOMATIC_VOICES: ReadonlyArray<AgentCallVoice> = [
  "marin",
  "meridian",
  "willow",
  "vesper",
  "gleam",
  "ripple",
  "delta",
  "stone",
  "quartz",
  "cinder",
  "beacon",
];

export function isAgentCallVoice(value: string | null | undefined): value is AgentCallVoice {
  return value != null && (OPENAI_LIVE_VOICES as ReadonlyArray<string>).includes(value);
}

/** A stable number for an id, for agents from before characters were stored. */
function idNumber(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** The voice an agent is given when none was chosen for it. */
export function automaticAgentCallVoice(agent: {
  readonly vmAgentId: string;
  readonly avatarColor?: number | null | undefined;
}): AgentCallVoice {
  // Characters are unique per agent, so the first eleven agents never share a voice.
  const index = agent.avatarColor ?? idNumber(agent.vmAgentId);
  return AUTOMATIC_VOICES[index % AUTOMATIC_VOICES.length] ?? "marin";
}

/**
 * The voice an agent speaks with on calls: the one chosen for it, else the
 * one its character gives it, so each agent sounds like itself. A stored
 * voice GPT-Live no longer lists falls back to the automatic one.
 */
export function agentCallVoice(agent: {
  readonly vmAgentId: string;
  readonly avatarColor?: number | null | undefined;
  readonly voice?: string | null | undefined;
}): AgentCallVoice {
  return isAgentCallVoice(agent.voice) ? agent.voice : automaticAgentCallVoice(agent);
}
