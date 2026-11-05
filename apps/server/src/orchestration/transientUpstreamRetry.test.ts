import { describe, expect, it } from "vite-plus/test";

import {
  MAX_TRANSIENT_UPSTREAM_RETRIES,
  shouldRetryTransientUpstream,
  transientUpstreamRetryDelayMs,
} from "./transientUpstreamRetry.ts";

describe("transient upstream retry policy", () => {
  it("covers a blip, then hands the thread back to the person", () => {
    expect(shouldRetryTransientUpstream(MAX_TRANSIENT_UPSTREAM_RETRIES - 1)).toBe(true);
    expect(shouldRetryTransientUpstream(MAX_TRANSIENT_UPSTREAM_RETRIES)).toBe(false);
  });

  it("backs off exponentially and caps at fifteen seconds", () => {
    expect([1, 2, 3, 4, 5].map(transientUpstreamRetryDelayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 15_000,
    ]);
    for (const attempt of [6, 15, 16, 40, 1_000, 100_000]) {
      expect(transientUpstreamRetryDelayMs(attempt)).toBe(15_000);
    }
    expect(transientUpstreamRetryDelayMs(0)).toBe(1_000);
  });
});
