import { OPENAI_LIVE_VOICES, XAI_REALTIME_VOICES } from "@t3tools/contracts";

/** A GPT-Live voice. */
export type GptLiveCallVoice = (typeof OPENAI_LIVE_VOICES)[number];
/** A Grok Voice voice. */
export type GrokCallVoice = (typeof XAI_REALTIME_VOICES)[number];
/** A voice an agent can speak with on calls, from either engine. */
export type AgentCallVoice = GptLiveCallVoice | GrokCallVoice;
/**
 * What runs a call: OpenAI's GPT-Live, or xAI's Grok Voice. The agent's voice
 * decides it, since each voice belongs to one engine.
 */
export type AgentCallEngine = "gpt-live" | "grok";

/** Every voice offered for calls: GPT-Live's, then Grok's. */
export const AGENT_CALL_VOICES: ReadonlyArray<AgentCallVoice> = [
  ...OPENAI_LIVE_VOICES,
  ...XAI_REALTIME_VOICES,
];

/** Grok's own descriptions cover its original five voices; the rest are just named. */
const GROK_VOICE_DETAILS: Readonly<Partial<Record<GrokCallVoice, string>>> = {
  eve: "Grok's default, an all-rounder",
  ara: "Warm and conversational",
  leo: "Confident and direct",
  rex: "Characterful and energetic",
  sal: "A distinctive conversational tone",
};

const titleCase = (voice: string) => voice.charAt(0).toUpperCase() + voice.slice(1);

/**
 * How each voice sounds, for pickers: GPT-Live's from OpenAI's voice table
 * (accent and presentation), Grok's from xAI's descriptions.
 */
export const AGENT_CALL_VOICE_DETAILS: Readonly<
  Record<AgentCallVoice, { readonly label: string; readonly detail: string }>
> = {
  ...(Object.fromEntries(
    XAI_REALTIME_VOICES.map((voice) => [
      voice,
      { label: titleCase(voice), detail: GROK_VOICE_DETAILS[voice] ?? "Grok Voice" },
    ]),
  ) as Record<GrokCallVoice, { readonly label: string; readonly detail: string }>),
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
const AUTOMATIC_VOICES: ReadonlyArray<GptLiveCallVoice> = [
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
  return value != null && (AGENT_CALL_VOICES as ReadonlyArray<string>).includes(value);
}

/** The engine a voice runs on. */
export function agentCallEngine(voice: AgentCallVoice): AgentCallEngine {
  return (XAI_REALTIME_VOICES as ReadonlyArray<string>).includes(voice) ? "grok" : "gpt-live";
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
}): GptLiveCallVoice {
  // Characters are unique per agent, so the first eleven agents never share a voice.
  const index = agent.avatarColor ?? idNumber(agent.vmAgentId);
  return AUTOMATIC_VOICES[index % AUTOMATIC_VOICES.length] ?? "marin";
}

/**
 * The voice an agent speaks with on calls: the one chosen for it, else the
 * one its character gives it, so each agent sounds like itself. A stored
 * voice neither engine lists any more falls back to the automatic one.
 */
export function agentCallVoice(agent: {
  readonly vmAgentId: string;
  readonly avatarColor?: number | null | undefined;
  readonly voice?: string | null | undefined;
}): AgentCallVoice {
  return isAgentCallVoice(agent.voice) ? agent.voice : automaticAgentCallVoice(agent);
}

/** The engine an agent's calls run on, from its voice. */
export function agentCallEngineFor(agent: {
  readonly vmAgentId: string;
  readonly avatarColor?: number | null | undefined;
  readonly voice?: string | null | undefined;
}): AgentCallEngine {
  return agentCallEngine(agentCallVoice(agent));
}

/**
 * The voice an agent speaks with on a call that runs on `engine`: its own
 * when that voice belongs to the engine, else the engine's default for it (a
 * device that started the call before the agent's voice changed).
 */
export function agentCallVoiceOn(
  agent: {
    readonly vmAgentId: string;
    readonly avatarColor?: number | null | undefined;
    readonly voice?: string | null | undefined;
  },
  engine: AgentCallEngine,
): AgentCallVoice {
  const voice = agentCallVoice(agent);
  if (agentCallEngine(voice) === engine) return voice;
  return engine === "grok" ? "eve" : automaticAgentCallVoice(agent);
}
