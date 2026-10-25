import { describe, expect, it } from "vitest";
import { measureStaleness, measureUpdates, stats } from "./stats.ts";

describe("streaming benchmark statistics", () => {
  it("charges skipped updates their wait for the next visible state", () => {
    expect(
      measureUpdates({
        changes: [
          [1, 100],
          [2, 200],
          [3, 300],
          [4, 400],
        ],
        displayed: [[3, 310]],
        from: 100,
        until: 400,
        observedUntil: 500,
      }),
    ).toEqual({
      latencies: [210, 110, 10],
      exactLatencies: [10],
      updates: 4,
      superseded: 2,
      missed: 1,
    });
  });
  it("does not count observations outside the measurement window", () => {
    expect(
      measureUpdates({
        changes: [
          [1, 0],
          [2, 100],
          [3, 200],
        ],
        displayed: [
          [2, 90],
          [3, 400],
        ],
        from: 100,
        until: 150,
        observedUntil: 300,
      }),
    ).toMatchObject({ updates: 1, missed: 1, latencies: [] });
  });
  it("includes a frozen viewer in time-sampled outstanding-update age", () => {
    expect(
      measureStaleness({
        changes: [
          [0, 0],
          [1, 100],
          [2, 200],
        ],
        displayed: [[0, 50]],
        from: 0,
        until: 300,
        stepMs: 50,
      }),
    ).toEqual({ ages: [0, 0, 50, 100, 150], blackoutSamples: 1, sampleIntervalMs: 50 });
  });
  it("a static page that is already visible has no outstanding update age", () => {
    expect(
      measureStaleness({ changes: [[0, 0]], displayed: [[0, 10]], from: 100, until: 200 }),
    ).toEqual({ ages: [0, 0], blackoutSamples: 0, sampleIntervalMs: 50 });
  });
  it("uses nearest-rank percentiles and represents empty samples explicitly", () => {
    expect(stats([])).toBeNull();
    expect(stats([40, 30, 20, 10])).toEqual({ count: 4, p50: 20, p95: 40, mean: 25, max: 40 });
  });
});
