import { describe, expect, it } from "vite-plus/test";

import {
  MAX_TRANSIENT_UPSTREAM_RETRIES,
  shouldRetryTransientUpstream,
  transientUpstreamRetryDelayMs,
} from "./transientUpstreamRetry.ts";

describe("transient upstream retry policy", () => {
  it("never gives up", () => {
    expect(MAX_TRANSIENT_UPSTREAM_RETRIES).toBe(Number.POSITIVE_INFINITY);
    for (const attempt of [1, 5, 15, 16, 40, 1_000, 100_000]) {
      expect(shouldRetryTransientUpstream(attempt)).toBe(true);
    }
  });

  it("backs off exponentially and caps at fifteen seconds forever", () => {
    expect([1, 2, 3, 4, 5].map(transientUpstreamRetryDelayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 15_000,
    ]);
    for (const attempt of [6, 15, 16, 40, 1_000, 100_000]) {
      expect(transientUpstreamRetryDelayMs(attempt)).toBe(15_000);
    }
    expect(transientUpstreamRetryDelayMs(0)).toBe(1_000);
  });
});
