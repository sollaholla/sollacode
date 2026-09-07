import { describe, expect, it } from "vite-plus/test";
import {
  canResumeUsageGuardYield,
  shouldYieldUsageGuardTurn,
  usageGuardWorkStartedAtMs,
  usageGuardYieldReason,
} from "./usageGuardYield.ts";

describe("usage guard yielding", () => {
  it("yields only after consumption and outside tools, subagents, compaction and human input", () => {
    const input = {
      action: "pause",
      phase: "provider-running",
      awaitingHuman: false,
      observedTokens: 200,
      startingTokens: 100,
      elapsedMs: 120_000,
    };
    expect(shouldYieldUsageGuardTurn(input)).toBe(true);
    expect(shouldYieldUsageGuardTurn({ ...input, elapsedMs: 119_999 })).toBe(false);
    for (const phase of [
      undefined,
      "tool-running",
      "subagent-running",
      "context-compacting",
      "waiting-provider-interaction",
    ]) {
      expect(shouldYieldUsageGuardTurn({ ...input, phase })).toBe(false);
    }
    expect(shouldYieldUsageGuardTurn({ ...input, awaitingHuman: true })).toBe(false);
    expect(shouldYieldUsageGuardTurn({ ...input, observedTokens: 100 })).toBe(false);
    expect(shouldYieldUsageGuardTurn({ ...input, action: "allow" })).toBe(false);
  });
  it("does not interpret Stop or a different turn as a resumable cooldown", () => {
    expect(canResumeUsageGuardYield(usageGuardYieldReason("one"), "one")).toBe(true);
    expect(canResumeUsageGuardYield(usageGuardYieldReason("one"), "two")).toBe(false);
    expect(canResumeUsageGuardYield("thread.turn-interrupt-requested", "one")).toBe(false);
    expect(canResumeUsageGuardYield(null, "one")).toBe(false);
  });
});

describe("usageGuardWorkStartedAtMs", () => {
  const supervisor = Date.parse("2026-09-06T16:10:00Z");
  it("charges the turn for work done before the supervisor attached", () => {
    expect(
      usageGuardWorkStartedAtMs({
        supervisorStartedAtMs: supervisor,
        turnStartedAt: "2026-09-06T16:00:00Z",
        turnRequestedAt: "2026-09-06T15:59:00Z",
        sessionUpdatedAt: "2026-09-06T16:05:00Z",
      }),
    ).toBe(Date.parse("2026-09-06T16:00:00Z"));
  });
  it("never moves the clock later than the supervisor start", () => {
    expect(
      usageGuardWorkStartedAtMs({
        supervisorStartedAtMs: supervisor,
        turnStartedAt: "2026-09-06T16:20:00Z",
        turnRequestedAt: null,
        sessionUpdatedAt: null,
      }),
    ).toBe(supervisor);
  });
  it("falls back through requestedAt and the session, then to the supervisor", () => {
    expect(
      usageGuardWorkStartedAtMs({
        supervisorStartedAtMs: supervisor,
        turnStartedAt: null,
        turnRequestedAt: "2026-09-06T16:01:00Z",
        sessionUpdatedAt: "2026-09-06T16:02:00Z",
      }),
    ).toBe(Date.parse("2026-09-06T16:01:00Z"));
    expect(
      usageGuardWorkStartedAtMs({
        supervisorStartedAtMs: supervisor,
        turnStartedAt: undefined,
        turnRequestedAt: undefined,
        sessionUpdatedAt: "not a date",
      }),
    ).toBe(supervisor);
  });
});
