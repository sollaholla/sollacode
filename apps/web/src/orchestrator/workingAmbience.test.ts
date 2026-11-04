import { describe, expect, it } from "vite-plus/test";

import { ambienceBeats } from "./workingAmbience";

/** A repeatable stand-in for Math.random. */
const seeded = (seed: number) => () => {
  seed = (seed * 16_807) % 2_147_483_647;
  return (seed - 1) / 2_147_483_646;
};

describe("ambienceBeats", () => {
  it("plays short blips in close groups with pauses between, and a sweep now and then", () => {
    const beats = ambienceBeats(seeded(7));
    const taken = Array.from({ length: 400 }, () => beats.next().value);
    const blips = taken.filter((beat) => !beat.sweep);
    const sweeps = taken.filter((beat) => beat.sweep);

    expect(sweeps.length).toBeGreaterThan(0);
    for (const blip of blips) {
      expect(blip.length).toBeGreaterThanOrEqual(0.035);
      expect(blip.length).toBeLessThanOrEqual(0.07);
      expect(blip.frequency).toBeGreaterThan(1_000);
    }
    // Within a group blips sit close; between groups the pause is long.
    const gaps = taken.slice(1).map((beat) => beat.gap);
    expect(gaps.some((gap) => gap <= 0.16)).toBe(true);
    expect(gaps.some((gap) => gap >= 0.9)).toBe(true);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(2.6);
  });

  it("starts soon, so the person hears work begin", () => {
    expect(ambienceBeats(seeded(3)).next().value.gap).toBeLessThanOrEqual(0.6);
  });
});
