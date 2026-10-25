import { describe, expect, it } from "vite-plus/test";

import { MARKER, readMarker, SCENE_VIEWPORT } from "./scenes.mjs";

import { markLatencies, summarize } from "./stats.ts";

describe("remote preview benchmark measurements", () => {
  it("charges superseded updates until a newer picture arrives", () => {
    expect(
      markLatencies({
        marks: [
          [1, 10],
          [2, 20],
          [3, 30],
        ],
        received: [{ at: 100, marker: 3 }],
        from: 0,
        until: 50,
      }),
    ).toEqual({ latencies: [90, 80, 70], missed: 0 });
  });

  it("reports missing updates instead of improving latency by discarding them", () => {
    expect(
      markLatencies({
        marks: [
          [1, 10],
          [2, 20],
          [3, 30],
        ],
        received: [
          { at: 15, marker: 1 },
          { at: 25, marker: null },
        ],
        from: 0,
        until: 50,
      }),
    ).toEqual({ latencies: [5], missed: 2 });
  });

  it("does not match stale pixels or observations preceding the source update", () => {
    expect(
      markLatencies({
        marks: [[2, 20]],
        received: [
          { at: 10, marker: 2 },
          { at: 25, marker: 1 },
          { at: 40, marker: 2 },
        ],
        from: 0,
        until: 50,
      }),
    ).toEqual({ latencies: [20], missed: 0 });
  });

  it("keeps an empty scene unmeasured rather than reporting zero latency", () => {
    expect(summarize([])).toEqual({
      count: 0,
      p50: null,
      p95: null,
      min: null,
      max: null,
      mean: null,
    });
    expect(summarize([1, 2, 100]).p95).toBe(100);
  });
});

describe("preview benchmark pixel marker", () => {
  it("rejects blank white and invalid images instead of counting them as successful idle captures", () => {
    expect(readMarker(() => 255, SCENE_VIEWPORT)).toBeNull();
    expect(readMarker(() => Number.NaN, SCENE_VIEWPORT)).toBeNull();
    expect(readMarker(() => 0, { width: 0, height: 0 })).toBeNull();
  });
  it("reads a nonzero marker with matching parity", () => {
    const value = 5;
    expect(
      readMarker((x: number) => {
        const cell = Math.floor((x - MARKER.left) / MARKER.cell);
        const bit = cell === MARKER.bits - 1 ? 0 : (value >> cell) & 1;
        return bit ? 0 : 255;
      }, SCENE_VIEWPORT),
    ).toBe(value);
  });
});
