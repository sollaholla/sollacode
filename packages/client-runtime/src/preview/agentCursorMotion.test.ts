import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_CURSOR_GLIDE_MAX_MS,
  agentCursorGlideMs,
  minimumJerk,
  planAgentCursorGlide,
} from "./agentCursorMotion.ts";

const samples = (count: number) => Array.from({ length: count + 1 }, (_, index) => index / count);

describe("agentCursorMotion", () => {
  it("takes longer for longer reaches but never past the click lead", () => {
    expect(agentCursorGlideMs(0)).toBe(0);
    expect(agentCursorGlideMs(10)).toBeLessThan(agentCursorGlideMs(100));
    expect(agentCursorGlideMs(100)).toBeLessThan(agentCursorGlideMs(400));
    expect(agentCursorGlideMs(5_000)).toBe(AGENT_CURSOR_GLIDE_MAX_MS);
  });

  it("starts and settles slowly and is fastest mid-reach", () => {
    expect(minimumJerk(0)).toBe(0);
    expect(minimumJerk(1)).toBe(1);
    expect(minimumJerk(0.5)).toBeCloseTo(0.5);
    const early = minimumJerk(0.1) - minimumJerk(0);
    const middle = minimumJerk(0.55) - minimumJerk(0.45);
    const late = minimumJerk(1) - minimumJerk(0.9);
    expect(middle).toBeGreaterThan(early * 5);
    expect(middle).toBeGreaterThan(late * 5);
  });

  it("reaches from rest along a gentle upward bow, ending exactly on the target", () => {
    const glide = planAgentCursorGlide({ x: 100, y: 300 }, { x: 500, y: 300 }, { moving: false });
    expect(glide).not.toBeNull();
    expect(glide!.at(0)).toEqual({ x: 100, y: 300 });
    expect(glide!.at(1)).toEqual({ x: 500, y: 300 });
    const middle = glide!.at(0.5);
    expect(middle.x).toBeCloseTo(300);
    // Bowed toward the top of the screen, by a few pixels rather than a swoop.
    expect(middle.y).toBeLessThan(300);
    expect(300 - middle.y).toBeLessThanOrEqual(36);
  });

  it("never runs backwards along the reach", () => {
    const glide = planAgentCursorGlide({ x: 40, y: 400 }, { x: 640, y: 120 }, { moving: false })!;
    let previous = glide.at(0).x;
    for (const t of samples(50)) {
      const { x } = glide.at(t);
      expect(x).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = x;
    }
  });

  it("carries on from its current speed when a new point arrives mid-glide", () => {
    const glide = planAgentCursorGlide({ x: 0, y: 0 }, { x: 12, y: 0 }, { moving: true })!;
    // A drag step keeps moving straight and leaves quickly instead of easing in.
    expect(glide.at(0.5).y).toBe(0);
    expect(glide.at(0.1).x).toBeGreaterThan(12 * 0.2);
    expect(glide.at(1)).toEqual({ x: 12, y: 0 });
  });

  it("does nothing when the cursor is already on the point", () => {
    expect(planAgentCursorGlide({ x: 5, y: 5 }, { x: 5.4, y: 5.2 }, { moving: false })).toBeNull();
  });
});
