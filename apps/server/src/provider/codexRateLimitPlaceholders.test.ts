import { describe, expect, it } from "vite-plus/test";

import {
  isSyntheticCodexRateLimitWindow,
  stripSyntheticCodexRateLimits,
  stripSyntheticCodexRateLimitSnapshot,
} from "./codexRateLimitPlaceholders.ts";

const NOW_MS = 1_789_250_447_000;
const WEEK_MINS = 10_080;
// Exactly what a cold app-server answered on 2026-09-12: zero used, and a
// reset one week after the request itself.
const placeholderWeek = { usedPercent: 0, windowDurationMins: WEEK_MINS, resetsAt: 1_789_855_247 };
const realWeek = { usedPercent: 100, windowDurationMins: WEEK_MINS, resetsAt: 1_789_435_560 };

describe("isSyntheticCodexRateLimitWindow", () => {
  it("recognises the zero-used window whose reset is exactly one window from now", () => {
    expect(isSyntheticCodexRateLimitWindow(placeholderWeek, NOW_MS)).toBe(true);
    expect(
      isSyntheticCodexRateLimitWindow({ ...placeholderWeek, resetsAt: 1_789_855_300 }, NOW_MS),
    ).toBe(true);
  });

  it("keeps real readings, including a genuinely fresh window", () => {
    expect(isSyntheticCodexRateLimitWindow(realWeek, NOW_MS)).toBe(false);
    expect(isSyntheticCodexRateLimitWindow({ ...placeholderWeek, usedPercent: 1 }, NOW_MS)).toBe(
      false,
    );
    // Reset three hours into the week: 0% used but the reset no longer tracks the clock.
    expect(
      isSyntheticCodexRateLimitWindow(
        { usedPercent: 0, windowDurationMins: WEEK_MINS, resetsAt: 1_789_855_247 - 3 * 3600 },
        NOW_MS,
      ),
    ).toBe(false);
    expect(isSyntheticCodexRateLimitWindow({ usedPercent: 0, resetsAt: null }, NOW_MS)).toBe(false);
  });
});

describe("stripSyntheticCodexRateLimitSnapshot", () => {
  it("returns null when only stand-ins remain", () => {
    expect(
      stripSyntheticCodexRateLimitSnapshot(
        {
          limitId: "codex",
          primary: placeholderWeek,
          secondary: null,
          credits: { hasCredits: false, unlimited: false, balance: "0" },
        },
        NOW_MS,
      ),
    ).toBeNull();
  });

  it("drops the stand-in window but keeps a real sibling and other signals", () => {
    const stripped = stripSyntheticCodexRateLimitSnapshot(
      { primary: placeholderWeek, secondary: realWeek, rateLimitReachedType: "rate_limit_reached" },
      NOW_MS,
    );
    expect(stripped).toEqual({
      primary: null,
      secondary: realWeek,
      rateLimitReachedType: "rate_limit_reached",
    });
    expect(
      stripSyntheticCodexRateLimitSnapshot(
        { primary: placeholderWeek, credits: { hasCredits: true, unlimited: false } },
        NOW_MS,
      ),
    ).toEqual({ primary: null, secondary: null, credits: { hasCredits: true, unlimited: false } });
  });

  it("returns the same object when nothing needed stripping", () => {
    const snapshot = { primary: realWeek, secondary: null };
    expect(stripSyntheticCodexRateLimitSnapshot(snapshot, NOW_MS)).toBe(snapshot);
  });
});

describe("stripSyntheticCodexRateLimits", () => {
  it("nulls a wholly synthetic answer, reset credits included", () => {
    expect(
      stripSyntheticCodexRateLimits(
        {
          rateLimits: { limitId: "codex", primary: placeholderWeek, secondary: null },
          rateLimitsByLimitId: {
            codex: { limitId: "codex", primary: placeholderWeek, secondary: null },
            codex_bengalfox: {
              limitId: "codex_bengalfox",
              primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1_789_268_447 },
              secondary: placeholderWeek,
            },
          },
          rateLimitResetCredits: { availableCount: 0, credits: [] },
        },
        NOW_MS,
      ),
    ).toBeNull();
  });

  it("keeps an otherwise-empty answer that carries a redeemable reset credit", () => {
    const response = {
      rateLimits: { limitId: "codex", primary: placeholderWeek, secondary: null },
      rateLimitResetCredits: { availableCount: 1, credits: [] },
    };
    expect(stripSyntheticCodexRateLimits(response, NOW_MS)).toEqual({
      rateLimits: { limitId: "codex", primary: null, secondary: null },
      rateLimitResetCredits: { availableCount: 1, credits: [] },
    });
  });

  it("passes a real answer through untouched and prunes only the synthetic buckets", () => {
    const real = {
      rateLimits: { limitId: "codex", primary: realWeek, secondary: null },
      rateLimitsByLimitId: {
        codex: { limitId: "codex", primary: realWeek, secondary: null },
        codex_bengalfox: { limitId: "codex_bengalfox", primary: placeholderWeek, secondary: null },
      },
      rateLimitResetCredits: null,
    };
    expect(stripSyntheticCodexRateLimits(real, NOW_MS)).toEqual({
      ...real,
      rateLimitsByLimitId: { codex: real.rateLimitsByLimitId.codex },
    });
    const untouched = { rateLimits: { primary: realWeek }, rateLimitsByLimitId: null };
    expect(stripSyntheticCodexRateLimits(untouched, NOW_MS)).toBe(untouched);
  });
});
