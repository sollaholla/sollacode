import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_ORBS,
  ORCHESTRATOR_ORB,
  agentAvatarHue,
  agentMoodBadgeSvg,
  agentOrb,
  agentPresence,
} from "./agentAppearance.ts";

describe("agent orbs", () => {
  it("gives a person's first agents every orb before any repeats", () => {
    const picked = AGENT_ORBS.map((_, index) => agentOrb("any", index).name);
    expect(new Set(picked).size).toBe(AGENT_ORBS.length);
    expect(agentOrb("any", AGENT_ORBS.length).name).toBe(picked[0]);
  });

  it("keeps a stored orb when the agent's id changes, and a stable one without", () => {
    expect(agentOrb("one", 3)).toEqual(agentOrb("two", 3));
    expect(agentOrb("same-id")).toEqual(agentOrb("same-id"));
    expect(agentOrb("same-id", null)).toEqual(agentOrb("same-id", -1));
  });

  it("keeps the orchestrator's orb for the orchestrator", () => {
    expect(AGENT_ORBS.map((orb) => orb.name as string)).not.toContain(ORCHESTRATOR_ORB);
  });

  it("gives every orb a color to tint a call with", () => {
    for (const orb of AGENT_ORBS) expect(orb.color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("spaces motion seeds by stored color, and hashes without one", () => {
    expect(agentAvatarHue("a", 1)).toBe(agentAvatarHue("b", 1));
    expect(agentAvatarHue("a")).not.toBe(agentAvatarHue("b"));
  });

  it("retains lifecycle presence through connection interruptions", () => {
    for (const status of ["running", "stopped", "failed"] as const) {
      expect(agentPresence(status).online).toBe(status === "running");
    }
    expect(agentPresence("failed").description).toBe("Offline — Agent failed");
  });
});

describe("what each mood says", () => {
  it("marks finished work with a green check", () => {
    expect(agentMoodBadgeSvg("happy", true)).toContain("#16a34a");
  });

  it("has no mark at rest or while talking", () => {
    expect(agentMoodBadgeSvg("idle", true)).toBeNull();
    expect(agentMoodBadgeSvg("speaking", true)).toBeNull();
  });

  it("sleeps offline whatever the mood says", () => {
    expect(agentMoodBadgeSvg("working", false)).toBe(agentMoodBadgeSvg("sleeping", true));
  });

  it("draws a self-contained image", () => {
    for (const mood of ["working", "waiting", "blocked", "happy", "sleeping"] as const) {
      const svg = agentMoodBadgeSvg(mood, true);
      expect(svg).toMatch(/^<svg xmlns=.*<\/svg>$/s);
      expect(svg).not.toMatch(/undefined|NaN|<script|<image/);
    }
  });
});
