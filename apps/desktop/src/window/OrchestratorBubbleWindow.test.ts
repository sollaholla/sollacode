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

  it("keeps a persisted spot that still intersects a live display", () => {
    expect(
      resolveInitialBubblePosition({ x: 1700, y: 900 }, [
        { x: 0, y: 0, width: 1920, height: 1080 },
      ]),
    ).toEqual({ x: 1700, y: 900 });
    expect(
      resolveInitialBubblePosition({ x: 4000, y: 900 }, [
        { x: 0, y: 0, width: 1920, height: 1080 },
      ]),
    ).toBeNull();
  });
});
