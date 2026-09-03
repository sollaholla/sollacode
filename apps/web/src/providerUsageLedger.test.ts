import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_PROVIDER_USAGE_LEDGER,
  digestProviderUsage,
  recordActivitiesIntoLedger,
  totalTokens,
} from "./providerUsageLedger";

const NOW = Date.parse("2026-09-03T12:00:00.000Z");

function activity(
  id: string,
  kind: string,
  turnId: string | null,
  createdAt: string,
  payload: Record<string, unknown>,
) {
  return {
    id,
    tone: "neutral",
    kind,
    summary: kind,
    payload,
    turnId,
    createdAt,
  } as never;
}

describe("providerUsageLedger", () => {
  it("records a turn's last-token counters once, keyed by turn", () => {
    const first = activity("a1", "context-window.updated", "turn-1", "2026-09-03T11:00:00.000Z", {
      usedTokens: 10_000,
      lastInputTokens: 800,
      lastCachedInputTokens: 200,
      lastOutputTokens: 150,
    });
    const once = recordActivitiesIntoLedger(EMPTY_PROVIDER_USAGE_LEDGER, "claudeAgent", [first]);
    const twice = recordActivitiesIntoLedger(once, "claudeAgent", [first, first]);
    expect(twice).toBe(once);
    const digest = digestProviderUsage(twice, "claudeAgent", NOW);
    expect(digest.today.turns).toBe(1);
    expect(totalTokens(digest.today)).toBe(1_150);
    expect(digest.today.costUsd).toBeNull();
  });

  it("attaches provider-reported cost to the same turn", () => {
    const ledger = recordActivitiesIntoLedger(EMPTY_PROVIDER_USAGE_LEDGER, "claudeAgent", [
      activity("a1", "context-window.updated", "turn-1", "2026-09-03T11:00:00.000Z", {
        lastInputTokens: 100,
        lastOutputTokens: 50,
      }),
      activity("a2", "turn.completed", "turn-1", "2026-09-03T11:00:05.000Z", {
        state: "completed",
        totalCostUsd: 0.42,
      }),
    ]);
    const digest = digestProviderUsage(ledger, "claudeAgent", NOW);
    expect(digest.today.turns).toBe(1);
    expect(digest.today.costUsd).toBeCloseTo(0.42);
  });

  it("keeps providers apart and buckets by range", () => {
    const ledger = recordActivitiesIntoLedger(
      recordActivitiesIntoLedger(EMPTY_PROVIDER_USAGE_LEDGER, "codex", [
        activity("c1", "context-window.updated", "turn-c", "2026-08-20T11:00:00.000Z", {
          lastInputTokens: 5_000,
        }),
      ]),
      "claudeAgent",
      [
        activity("a1", "context-window.updated", "turn-a", "2026-09-01T11:00:00.000Z", {
          lastInputTokens: 1_000,
        }),
      ],
    );
    const claude = digestProviderUsage(ledger, "claudeAgent", NOW);
    expect(claude.today.turns).toBe(0);
    expect(claude.last7Days.turns).toBe(1);
    expect(claude.allTime.inputTokens).toBe(1_000);
    expect(claude.recentDays).toHaveLength(14);
    const codex = digestProviderUsage(ledger, "codex", NOW);
    expect(codex.last7Days.turns).toBe(0);
    expect(codex.last30Days.inputTokens).toBe(5_000);
  });

  it("ignores updates that carry no per-turn counters", () => {
    const ledger = recordActivitiesIntoLedger(EMPTY_PROVIDER_USAGE_LEDGER, "grok", [
      activity("g1", "context-window.updated", "turn-g", "2026-09-03T11:00:00.000Z", {
        usedTokens: 42,
      }),
    ]);
    expect(ledger).toBe(EMPTY_PROVIDER_USAGE_LEDGER);
  });
});
