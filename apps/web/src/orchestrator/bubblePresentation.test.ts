import { describe, expect, it } from "vite-plus/test";

import {
  BUBBLE_MAX_SCALE,
  computeBubbleGlow,
  computeBubbleScale,
  smoothBubbleScale,
} from "./bubblePresentation";

describe("computeBubbleScale", () => {
  it("rests at base size when idle or errored, whatever the levels claim", () => {
    expect(computeBubbleScale({ status: "idle", micLevel: 1, assistantLevel: 1 })).toBe(1);
    expect(computeBubbleScale({ status: "error", micLevel: 1, assistantLevel: 1 })).toBe(1);
  });

  it("grows more for the user's voice than for the orchestrator's", () => {
    const userSpeaking = computeBubbleScale({
      status: "listening",
      micLevel: 0.8,
      assistantLevel: 0,
    });
    const assistantSpeaking = computeBubbleScale({
      status: "speaking",
      micLevel: 0,
      assistantLevel: 0.8,
    });
    // The ask was literal: "changes size when it speaks and more when I speak".
    expect(userSpeaking).toBeGreaterThan(assistantSpeaking);
    expect(assistantSpeaking).toBeGreaterThan(1);
  });

  it("clamps at the window's safe maximum even when both sides shout", () => {
    expect(computeBubbleScale({ status: "speaking", micLevel: 1, assistantLevel: 1 })).toBe(
      BUBBLE_MAX_SCALE,
    );
  });

  it("shrugs off NaN and out-of-range levels", () => {
    expect(
      computeBubbleScale({ status: "listening", micLevel: Number.NaN, assistantLevel: -3 }),
    ).toBe(1);
  });
});

describe("computeBubbleGlow", () => {
  it("is dark when idle and follows the louder side otherwise", () => {
    expect(computeBubbleGlow({ status: "idle", micLevel: 1, assistantLevel: 1 })).toBe(0);
    expect(
      computeBubbleGlow({ status: "listening", micLevel: 0.9, assistantLevel: 0.2 }),
    ).toBeCloseTo(0.9);
  });
});

describe("smoothBubbleScale", () => {
  it("attacks faster than it releases so speech reads as motion", () => {
    const up = smoothBubbleScale(1, 2) - 1;
    const down = 2 - smoothBubbleScale(2, 1);
    expect(up).toBeGreaterThan(down);
  });

  it("converges toward the target from both sides", () => {
    expect(smoothBubbleScale(1, 2)).toBeGreaterThan(1);
    expect(smoothBubbleScale(1, 2)).toBeLessThan(2);
    expect(smoothBubbleScale(2, 1)).toBeLessThan(2);
    expect(smoothBubbleScale(2, 1)).toBeGreaterThan(1);
  });
});

describe("the working orb", () => {
  it("sits still rather than pulsing to a voice it is not listening to", () => {
    // While a tool call runs the orb reports "working"; publishing live levels
    // there would swell it to the user's voice at the moment it is telling
    // them it cannot hear them.
    const working = { status: "working", micLevel: 0, assistantLevel: 0 } as const;
    expect(computeBubbleScale(working)).toBe(1);
    expect(computeBubbleGlow(working)).toBe(0);
  });
});
