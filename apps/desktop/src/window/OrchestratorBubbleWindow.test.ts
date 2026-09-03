import { describe, expect, it } from "vite-plus/test";

import {
  resolveBubbleDragPosition,
  resolveInitialBubblePosition,
} from "./OrchestratorBubbleWindow.ts";

describe("orchestrator bubble window geometry", () => {
  it("follows the OS cursor from the grab offset", () => {
    expect(resolveBubbleDragPosition({ x: 500.7, y: 400.2 }, { x: 20, y: 30 })).toEqual({
      x: 481,
      y: 370,
    });
  });

  it("keeps a persisted spot whose orb already sits on a live display", () => {
    // Centre lands at (1044, 644): comfortably inside, so it is returned as-is.
    expect(
      resolveInitialBubblePosition({ x: 900, y: 500 }, [{ x: 0, y: 0, width: 1920, height: 1080 }]),
    ).toEqual({ x: 900, y: 500 });
  });

  it("nudges a spot whose orb would hang off the edge back on screen", () => {
    // Saved under the old 128px window, this sat fine; the wider window reads
    // the same top-left as a centre 80px lower, which would put the orb over
    // the bottom edge. Only the axis at fault moves.
    expect(
      resolveInitialBubblePosition({ x: 1700, y: 900 }, [
        { x: 0, y: 0, width: 1920, height: 1080 },
      ]),
    ).toEqual({ x: 1700, y: 880 });
  });

  it("drops a spot that is on no display at all", () => {
    expect(
      resolveInitialBubblePosition({ x: 4000, y: 900 }, [
        { x: 0, y: 0, width: 1920, height: 1080 },
      ]),
    ).toBeNull();
  });
});
