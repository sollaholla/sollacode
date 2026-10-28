import { agentAvatarTraits } from "@t3tools/client-runtime/state/agent-appearance";
import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_INTRO_CAST,
  AGENT_INTRO_STARTERS,
  AGENT_INTRO_WELCOME_CAST,
  agentIntroDefaultName,
  agentIntroPreviewMood,
} from "./agentIntro";

describe("agent intro", () => {
  it("offers one character per body shape, each with its own name", () => {
    const shapes = AGENT_INTRO_CAST.map((color) => agentAvatarTraits("intro", color).shape);
    expect(new Set(shapes).size).toBe(AGENT_INTRO_CAST.length);
    const names = AGENT_INTRO_CAST.map(agentIntroDefaultName);
    expect(new Set(names).size).toBe(names.length);
    expect(agentIntroDefaultName(0)).toBe("Mochi");
    for (const color of AGENT_INTRO_WELCOME_CAST) expect(AGENT_INTRO_CAST).toContain(color);
  });

  it("keeps starter purposes within the create contract", () => {
    for (const starter of AGENT_INTRO_STARTERS) {
      expect(starter.purpose.trim().length).toBeGreaterThan(0);
      expect(starter.purpose.length).toBeLessThanOrEqual(2_000);
    }
  });

  it("reacts to what the person is doing on the naming step", () => {
    const base = { name: "", purpose: "", typing: false, busy: false, failed: false };
    expect(agentIntroPreviewMood(base)).toBe("idle");
    expect(agentIntroPreviewMood({ ...base, typing: true })).toBe("waiting");
    expect(agentIntroPreviewMood({ ...base, name: "Scout", purpose: "Research" })).toBe("happy");
    expect(agentIntroPreviewMood({ ...base, name: "Scout", purpose: "x", busy: true })).toBe(
      "working",
    );
    expect(agentIntroPreviewMood({ ...base, failed: true })).toBe("blocked");
  });
});
