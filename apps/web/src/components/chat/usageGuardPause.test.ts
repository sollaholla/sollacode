import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  findUsageGuardPauseNotice,
  formatCooldownDuration,
  formatUsageGuardResetsAt,
  isUsageGuardPauseActive,
} from "./usageGuardPause";

it("formats long cooldowns with useful time units", () => {
  expect(formatCooldownDuration(316 * 60 + 4)).toBe("5h 16m");
  expect(formatCooldownDuration(90000)).toBe("1d 1h 0m");
  expect(formatCooldownDuration(65)).toBe("1m 5s");
  expect(formatCooldownDuration(4)).toBe("4s");
});

function activity(
  kind: string,
  createdAt: string,
  payload: unknown = {},
): OrchestrationThreadActivity {
  return {
    id: EventId.make(`${kind}:${createdAt}`),
    tone: "info",
    kind,
    summary: `${kind} summary`,
    payload,
    turnId: null,
    createdAt,
  };
}

describe("findUsageGuardPauseNotice", () => {
  it("returns the newest pause with its payload", () => {
    const notice = findUsageGuardPauseNotice([
      activity("usage-guard.paused", "2026-09-05T20:00:00.000Z", { providerLabel: "Codex" }),
      activity("tool.completed", "2026-09-05T20:01:00.000Z"),
      activity("usage-guard.paused", "2026-09-05T20:02:00.000Z", {
        providerLabel: "Claude",
        estimatedPercent: 96.4,
        windowLabel: "5 hour",
        resetsAt: 1788663600000,
        tier: "pause",
        detail: "Claude is at ~96% of its 5 hour window.",
      }),
    ]);
    expect(notice).toMatchObject({
      providerLabel: "Claude",
      estimatedPercent: 96.4,
      windowLabel: "5 hour",
      resetsAt: 1788663600000,
      tier: "pause",
      backgroundBudget: null,
      activeThreads: null,
    });
  });

  it("ignores a hold left behind by a provider the thread no longer runs on", () => {
    // A Muse thread showed a Claude weekly hold from two days earlier as
    // "Waiting for usage room · resumes in 2h" (2026-09-12).
    const activities = [
      activity("usage-guard.paused", "2026-09-11T03:47:51.000Z", {
        providerLabel: "Claude",
        instanceId: "claudeAgent",
        tier: "optimize",
        retryAt: "2026-09-13T01:55:57.659Z",
      }),
    ];
    expect(findUsageGuardPauseNotice(activities, "muse")).toBeNull();
    expect(findUsageGuardPauseNotice(activities, "claudeAgent")).not.toBeNull();
    // Without a current instance, or on a notice that never said whose it
    // was, the hold is still shown.
    expect(findUsageGuardPauseNotice(activities)).not.toBeNull();
    expect(
      findUsageGuardPauseNotice(
        [activity("usage-guard.paused", "2026-09-11T03:47:51.000Z", { providerLabel: "Claude" })],
        "muse",
      ),
    ).not.toBeNull();
  });

  it("is cleared by a later resume", () => {
    expect(
      findUsageGuardPauseNotice([
        activity("usage-guard.paused", "2026-09-05T20:00:00.000Z"),
        activity("usage-guard.resumed", "2026-09-05T20:05:00.000Z"),
      ]),
    ).toBeNull();
    expect(
      findUsageGuardPauseNotice([
        activity("usage-guard.resumed", "2026-09-05T19:00:00.000Z"),
        activity("usage-guard.paused", "2026-09-05T20:00:00.000Z"),
      ]),
    ).not.toBeNull();
  });
});

describe("isUsageGuardPauseActive", () => {
  const notice = findUsageGuardPauseNotice([
    activity("usage-guard.paused", "2026-09-05T20:00:00.000Z"),
  ]);

  it("needs held pending work and no running turn", () => {
    expect(
      isUsageGuardPauseActive({
        notice,
        pendingWork: {
          kind: "active-turn-recovery",
          state: "sleeping",
          since: "2026-09-05T20:00:00.000Z",
        },
        isWorking: false,
      }),
    ).toBe(true);
    expect(isUsageGuardPauseActive({ notice, pendingWork: null, isWorking: false })).toBe(false);
    expect(
      isUsageGuardPauseActive({
        notice,
        pendingWork: { kind: "active-turn-recovery", state: "executing", since: "x" },
        isWorking: false,
      }),
    ).toBe(false);
    expect(
      isUsageGuardPauseActive({
        notice,
        pendingWork: { kind: "active-turn-recovery", state: "sleeping", since: "x" },
        isWorking: true,
      }),
    ).toBe(false);
  });
});

describe("formatUsageGuardResetsAt", () => {
  it("describes the time until the window resets", () => {
    const now = Date.parse("2026-09-05T20:00:00.000Z");
    expect(formatUsageGuardResetsAt(null, now)).toBeNull();
    expect(formatUsageGuardResetsAt(now - 1, now)).toBe("resets any moment now");
    expect(formatUsageGuardResetsAt(now + 25 * 60_000, now)).toBe("resets in 25 min");
    expect(formatUsageGuardResetsAt(now + 3 * 60 * 60_000, now)).toBe("resets in 3 h");
    expect(formatUsageGuardResetsAt(now + 5 * 24 * 60 * 60_000, now)).toBe("resets in 5 d");
  });
});
