import { describe, expect, it } from "vite-plus/test";

import { agentAvatarHue, agentAvatarSvg, agentPresence } from "./agentAppearance.ts";

describe("agent appearance", () => {
  it("spaces persisted colors apart and keeps them when identities or registry membership change", () => {
    const hues = Array.from({ length: 12 }, (_, color) => agentAvatarHue("one", color));
    expect(new Set(hues).size).toBe(12);
    for (let color = 0; color < 12; color += 1) {
      expect(agentAvatarHue("renamed-or-migrated-id", color)).toBe(hues[color]);
      for (let other = 0; other < color; other += 1) {
        const gap = Math.abs(hues[color]! - hues[other]!);
        expect(Math.min(gap, 360 - gap)).toBeGreaterThan(15);
      }
    }
  });

  it("keeps color across offline/online changes and gives sequential identities different hues", () => {
    const ids = Array.from({ length: 256 }, (_, index) => `agent-${index}`);
    const hues = ids.map((id) => agentAvatarHue(id));
    expect(new Set(hues).size).toBe(ids.length);
    for (const id of ids) {
      const hue = agentAvatarHue(id);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
      expect(agentAvatarSvg(id, true)).toContain(`hsl(${hue.toFixed(3)},72%`);
      expect(agentAvatarSvg(id, false)).toContain(`hsl(${hue.toFixed(3)},24%`);
      expect(agentAvatarSvg(id, true)).toBe(agentAvatarSvg(id, true));
    }
  });

  it("does not place unusual or untrusted identifiers in SVG markup", () => {
    for (const id of ["", "😊-agent", '<script>alert("x")</script>']) {
      const svg = agentAvatarSvg(id, true);
      expect(svg).not.toMatch(/NaN|undefined|<script|<image|onload=/);
      expect(Number.isFinite(agentAvatarHue(id))).toBe(true);
    }
  });

  it("gives agents distinct bounded outlines that stay fixed across colors, presence and blinks", () => {
    const outlines = new Set<string>();
    const outline = (svg: string) => svg.match(/<clipPath id="body-clip"><path d="([^"]+)"/u)![1]!;
    for (let index = 0; index < 256; index += 1) {
      const id = `agent-${index}`;
      const svg = agentAvatarSvg(id, true);
      const path = outline(svg);
      outlines.add(path);
      expect(path).toBe(outline(agentAvatarSvg(id, false, 42, true)));
      expect(svg).toContain(`<path d="${path}" fill="url(#body)"/>`);
      expect(path).toMatch(/^M[\d. ]+(?:C[\d. ]+)+Z$/u);
      const coordinates = path.match(/[\d.]+/gu)!.map(Number);
      // Bound both the curve and its control points within a round silhouette;
      // clipping/pointed shapes cannot hide in an otherwise plausible SVG.
      for (let offset = 0; offset < coordinates.length; offset += 2) {
        const radius = Math.hypot(coordinates[offset]! - 40, coordinates[offset + 1]! - 39);
        expect(radius).toBeGreaterThan(27);
        expect(radius).toBeLessThan(35);
      }
    }
    expect(outlines.size).toBe(256);
  });

  it("uses gray/offline presence during all lifecycle transitions and disconnections", () => {
    for (const status of [
      "provisioning",
      "starting",
      "running",
      "stopping",
      "stopped",
      "failed",
    ] as const) {
      expect(agentPresence(status, false)).toEqual({
        online: false,
        label: "Offline",
        description: "Offline — Environment disconnected",
      });
      expect(agentPresence(status, true).online).toBe(status === "running");
    }
    expect(agentPresence("running", true).description).toBe(
      "Online — Ready for events and notifications",
    );
    expect(agentPresence("failed", true).description).toBe("Offline — Agent failed");
  });
});
