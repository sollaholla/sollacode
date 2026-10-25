import { describe, expect, it } from "vite-plus/test";

import {
  createBitrateController,
  maxBitrateFor,
  resizeBitrateController,
  updateBitrate,
} from "./mediaBitrateController.ts";

const phoneSize = { width: 1_122, height: 702 };
const desktopSize = { width: 2_560, height: 1_600 };
const stats = (overrides: Partial<Parameters<typeof updateBitrate>[1]> = {}) => ({
  subscriber: "viewer",
  rttMs: 40,
  minRttMs: 40,
  queueMs: 40,
  deliveredBitsPerSecond: 0,
  dropped: 0,
  ...overrides,
});

describe("media bitrate controller", () => {
  it("scales its ceiling with the picture and starts conservatively", () => {
    expect(maxBitrateFor(phoneSize)).toBeLessThan(maxBitrateFor(desktopSize));
    const phone = createBitrateController(phoneSize);
    expect(phone.targetBitsPerSecond).toBe(phone.maxBitsPerSecond);
    const desktop = createBitrateController(desktopSize);
    expect(desktop.targetBitsPerSecond).toBe(4_000_000);
  });

  it("cuts to three quarters of what got through when queueing builds", () => {
    const start = createBitrateController(desktopSize);
    const next = updateBitrate(
      start,
      stats({ queueMs: 300, deliveredBitsPerSecond: 3_000_000 }),
      1_000,
    );
    expect(next.targetBitsPerSecond).toBe(2_250_000);
    // One cut per congestion event, not one per report.
    expect(
      updateBitrate(next, stats({ queueMs: 300, deliveredBitsPerSecond: 2_000_000 }), 1_200),
    ).toBe(next);
    expect(
      updateBitrate(next, stats({ queueMs: 300, deliveredBitsPerSecond: 2_000_000 }), 1_500)
        .targetBitsPerSecond,
    ).toBe(1_500_000);
  });

  it("treats a relay drop as congestion even without measured queueing", () => {
    const start = createBitrateController(desktopSize);
    const next = updateBitrate(start, stats({ dropped: 2 }), 1_000);
    expect(next.targetBitsPerSecond).toBe(3_000_000);
  });

  it("grows only when the path is clear and the stream actually uses its budget", () => {
    const start = createBitrateController(desktopSize);
    // Idle screen: nothing proves the link can carry more.
    expect(updateBitrate(start, stats({ deliveredBitsPerSecond: 100_000 }), 10_000)).toBe(start);
    const grown = updateBitrate(start, stats({ deliveredBitsPerSecond: 3_500_000 }), 10_000);
    expect(grown.targetBitsPerSecond).toBe(4_400_000);
    // Never past the ceiling.
    let state = grown;
    for (let step = 0; step < 50; step += 1) {
      state = updateBitrate(
        state,
        stats({ deliveredBitsPerSecond: state.targetBitsPerSecond }),
        10_000 + step * 250,
      );
    }
    expect(state.targetBitsPerSecond).toBe(state.maxBitsPerSecond);
  });

  it("waits after a cut before probing upward again", () => {
    const cut = updateBitrate(createBitrateController(desktopSize), stats({ dropped: 1 }), 1_000);
    const soon = updateBitrate(
      cut,
      stats({ deliveredBitsPerSecond: cut.targetBitsPerSecond }),
      1_500,
    );
    expect(soon).toBe(cut);
  });

  it("clamps the target when the picture shrinks", () => {
    const desktop = createBitrateController(desktopSize);
    const phone = resizeBitrateController(desktop, phoneSize);
    expect(phone.targetBitsPerSecond).toBeLessThanOrEqual(phone.maxBitsPerSecond);
  });
});
