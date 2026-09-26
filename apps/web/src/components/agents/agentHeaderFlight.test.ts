import { describe, expect, it } from "vite-plus/test";

import {
  dragProgress,
  dragTransform,
  estimateCollapsedAvatarRect,
  flightTransform,
  releasedDragCollapses,
} from "./agentHeaderFlight";

// A phone: the card's avatar sits under the top bar at the left; the bar's
// trailing slot ends at the right edge.
const cardAvatar = { left: 28, top: 80, width: 40, height: 40 };
const slot = { left: 340, top: 24, width: 0, height: 0 };

describe("agent header flight", () => {
  it("lands the folded avatar left of the panel toggle, centred on the bar", () => {
    expect(estimateCollapsedAvatarRect(slot)).toEqual({ left: 272, top: 8, width: 32, height: 32 });
  });

  it("counts only movement up and to the right toward the bar", () => {
    const target = estimateCollapsedAvatarRect(slot);
    const toward = { dx: 240, dy: -76 };
    expect(dragProgress(toward.dx, toward.dy, cardAvatar, target)).toBeCloseTo(1);
    expect(dragProgress(toward.dx / 2, toward.dy / 2, cardAvatar, target)).toBeCloseTo(0.5);
    // Straight down, or back to the left, goes nowhere.
    expect(dragProgress(0, 120, cardAvatar, target)).toBe(0);
    expect(dragProgress(-80, 0, cardAvatar, target)).toBe(0);
    // Overshooting the bar is still just "there".
    expect(dragProgress(500, -150, cardAvatar, target)).toBe(1);
  });

  it("folds once a drag is a good way there, and sends a nudge back", () => {
    expect(releasedDragCollapses(0.1)).toBe(false);
    expect(releasedDragCollapses(0.3)).toBe(true);
    expect(releasedDragCollapses(0.9)).toBe(true);
  });

  it("shrinks the avatar onto its folded place", () => {
    const target = estimateCollapsedAvatarRect(slot);
    expect(flightTransform(cardAvatar, target)).toBe("translate(244px, -72px) scale(0.8)");
    expect(flightTransform(cardAvatar, cardAvatar)).toBe("translate(0px, 0px) scale(1)");
    expect(dragTransform(10, -5, 0.5, cardAvatar, target)).toBe("translate(10px, -5px) scale(0.9)");
  });
});
