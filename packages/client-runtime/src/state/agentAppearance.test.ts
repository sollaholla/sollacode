import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_AVATAR_SHAPES,
  agentAvatarHue,
  agentAvatarSvg,
  agentAvatarTraits,
  agentPresence,
  type AgentAvatarMood,
} from "./agentAppearance.ts";

const MOODS: readonly AgentAvatarMood[] = [
  "idle",
  "working",
  "waiting",
  "blocked",
  "happy",
  "sleeping",
];

describe("agent appearance", () => {
  it("gives a person's first agents the whole cast before any shape repeats", () => {
    const first = Array.from({ length: AGENT_AVATAR_SHAPES.length }, (_, color) =>
      agentAvatarTraits("any", color),
    );
    expect(new Set(first.map((traits) => traits.shape)).size).toBe(AGENT_AVATAR_SHAPES.length);
    // Fourteen colors: the first fourteen agents never share one.
    const colors = Array.from({ length: 14 }, (_, color) => agentAvatarTraits("any", color).color);
    expect(new Set(colors).size).toBe(14);
    // Neighbours in a list don't wear the same accessory.
    for (let color = 1; color < 14; color += 1) {
      const previous = agentAvatarTraits("any", color - 1).accessory;
      const current = agentAvatarTraits("any", color).accessory;
      if (current !== "none") expect(current).not.toBe(previous);
    }
  });

  it("keeps a persisted look when the agent is renamed, migrated or goes offline", () => {
    for (let color = 0; color < 40; color += 1) {
      expect(agentAvatarTraits("renamed-or-migrated-id", color)).toEqual(
        agentAvatarTraits("one", color),
      );
      expect(agentAvatarHue("renamed-or-migrated-id", color)).toBe(agentAvatarHue("one", color));
    }
    const ids = Array.from({ length: 256 }, (_, index) => `agent-${index}`);
    expect(new Set(ids.map((id) => agentAvatarHue(id))).size).toBe(ids.length);
    for (const id of ids) {
      const hue = agentAvatarHue(id);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
      expect(agentAvatarSvg(id, true)).toBe(agentAvatarSvg(id, true));
    }
  });

  it("draws every shape, mood and presence as a self-contained, static SVG", () => {
    for (let color = 0; color < 60; color += 1) {
      for (const online of [true, false]) {
        for (const blinking of [false, true]) {
          for (const mood of MOODS) {
            const svg = agentAvatarSvg("agent", online, color, blinking, mood);
            expect(svg).toMatch(
              /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 80 80"/u,
            );
            expect(svg).not.toMatch(
              /NaN|undefined|Infinity|<filter|<text|<image|<foreignObject|<script|<animate|href=/u,
            );
            for (const [, id] of svg.matchAll(/url\(#(\w+)\)/gu)) {
              expect(svg).toContain(`id="${id}"`);
            }
            expect(svg.length).toBeLessThan(9_000);
          }
        }
      }
    }
  });

  it("shows moods only while online and keeps the body fixed across them", () => {
    const body = (svg: string) => svg.match(/<clipPath id="b">(.+?)<\/clipPath>/u)![1]!;
    for (let color = 0; color < AGENT_AVATAR_SHAPES.length; color += 1) {
      const idle = agentAvatarSvg("agent", true, color);
      const faces = new Set(MOODS.map((mood) => agentAvatarSvg("agent", true, color, false, mood)));
      expect(faces.size).toBe(MOODS.length);
      for (const mood of MOODS) {
        expect(body(agentAvatarSvg("agent", true, color, false, mood))).toBe(body(idle));
        // Offline agents sleep whatever they were doing.
        expect(agentAvatarSvg("agent", false, color, false, mood)).toBe(
          agentAvatarSvg("agent", false, color, false, "sleeping"),
        );
      }
      expect(agentAvatarSvg("agent", true, color, true)).not.toBe(idle);
    }
  });

  it("does not place unusual or untrusted identifiers in SVG markup", () => {
    for (const id of ["", "😊-agent", '<script>alert("x")</script>']) {
      const svg = agentAvatarSvg(id, true);
      expect(svg).not.toMatch(/NaN|undefined|<script|<image|onload=|alert/u);
      expect(Number.isFinite(agentAvatarHue(id))).toBe(true);
    }
  });

  it("retains lifecycle presence through connection interruptions", () => {
    for (const status of [
      "provisioning",
      "starting",
      "running",
      "stopping",
      "stopped",
      "failed",
    ] as const) {
      expect(agentPresence(status).online).toBe(status === "running");
    }
    expect(agentPresence("running").description).toBe(
      "Online — Ready for events and notifications",
    );
    expect(agentPresence("failed").description).toBe("Offline — Agent failed");
  });
});
