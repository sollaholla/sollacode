import { OPENAI_LIVE_VOICES } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_CALL_VOICE_DETAILS,
  agentCallVoice,
  automaticAgentCallVoice,
  isAgentCallVoice,
} from "./agentCallVoice.ts";

describe("agentCallVoice", () => {
  it("gives the first eleven characters eleven different English voices, the first the default", () => {
    const voices = Array.from({ length: 11 }, (_, avatarColor) =>
      automaticAgentCallVoice({ vmAgentId: `agent-${avatarColor}`, avatarColor }),
    );
    expect(voices[0]).toBe("marin");
    expect(new Set(voices).size).toBe(11);
    // Portuguese voices are only ever chosen, never handed out.
    expect(voices).not.toContain("bossa");
    expect(voices).not.toContain("tempo");
  });

  it("alternates presentation between neighbouring characters", () => {
    expect(automaticAgentCallVoice({ vmAgentId: "a", avatarColor: 1 })).toBe("meridian");
    expect(automaticAgentCallVoice({ vmAgentId: "b", avatarColor: 2 })).toBe("willow");
    expect(automaticAgentCallVoice({ vmAgentId: "c", avatarColor: 3 })).toBe("vesper");
  });

  it("keeps an agent from before characters were stored on one voice", () => {
    const first = automaticAgentCallVoice({ vmAgentId: "agent-old", avatarColor: null });
    expect(automaticAgentCallVoice({ vmAgentId: "agent-old" })).toBe(first);
    expect(isAgentCallVoice(first)).toBe(true);
  });

  it("speaks with the chosen voice, and falls back when GPT-Live no longer lists it", () => {
    expect(agentCallVoice({ vmAgentId: "a", avatarColor: 0, voice: "cinder" })).toBe("cinder");
    expect(agentCallVoice({ vmAgentId: "a", avatarColor: 0, voice: "bossa" })).toBe("bossa");
    expect(agentCallVoice({ vmAgentId: "a", avatarColor: 2, voice: "alloy" })).toBe("willow");
    expect(agentCallVoice({ vmAgentId: "a", avatarColor: 2, voice: null })).toBe("willow");
  });

  it("describes every voice GPT-Live offers", () => {
    for (const voice of OPENAI_LIVE_VOICES) {
      expect(AGENT_CALL_VOICE_DETAILS[voice].label.toLowerCase()).toBe(voice);
    }
  });
});
