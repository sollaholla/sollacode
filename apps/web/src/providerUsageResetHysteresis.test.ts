import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  activeResetCredits,
  dismissProviderUsageResetCredit,
  mergeProviderUsageEntry,
  PROVIDER_USAGE_RESET_CREDIT_GRACE_MS,
  providerUsageResetCreditKey,
  type PersistedProviderUsageEntry,
  type PersistedProviderUsageResetCredit,
} from "./providerUsageStore";

const ACCOUNT = "codex:account:someone";
const T0 = Date.parse("2026-09-04T12:00:00.000Z");

function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

function credit(
  overrides: Partial<PersistedProviderUsageResetCredit> = {},
): PersistedProviderUsageResetCredit {
  return {
    id: "credit-a",
    title: "Full reset",
    description: null,
    expiresAt: T0 + 86_400_000,
    ...overrides,
  };
}

function report(
  offsetMs: number,
  resetCredits: PersistedProviderUsageEntry["resetCredits"],
): PersistedProviderUsageEntry {
  return {
    accountKey: ACCOUNT,
    driver: ProviderDriverKind.make("codex"),
    windows: [],
    reportedAt: at(offsetMs),
    ...(resetCredits === undefined ? {} : { resetCredits }),
  };
}

function creditsOf(
  state: Readonly<Record<string, PersistedProviderUsageEntry>>,
): readonly PersistedProviderUsageResetCredit[] {
  return state[ACCOUNT]?.resetCredits?.credits ?? [];
}

function countOf(state: Readonly<Record<string, PersistedProviderUsageEntry>>): number {
  return state[ACCOUNT]?.resetCredits?.availableCount ?? 0;
}

describe("provider usage reset hysteresis", () => {
  it("keeps a credit the provider transiently stopped reporting", () => {
    const seen = mergeProviderUsageEntry({}, report(0, { availableCount: 1, credits: [credit()] }));
    const desynced = mergeProviderUsageEntry(seen, report(30_000, null));

    expect(creditsOf(desynced).map((entry) => entry.id)).toEqual(["credit-a"]);
    expect(countOf(desynced)).toBe(1);
  });

  it("drops a credit the provider has stopped reporting for longer than the grace", () => {
    const seen = mergeProviderUsageEntry({}, report(0, { availableCount: 1, credits: [credit()] }));
    const expired = mergeProviderUsageEntry(
      seen,
      report(PROVIDER_USAGE_RESET_CREDIT_GRACE_MS + 1_000, null),
    );

    expect(expired[ACCOUNT]?.resetCredits ?? null).toBeNull();
  });

  it("lets the available count go back down when the provider reports fewer", () => {
    const two = mergeProviderUsageEntry(
      {},
      report(0, {
        availableCount: 2,
        credits: [credit(), credit({ id: "credit-b" })],
      }),
    );
    expect(countOf(two)).toBe(2);

    const one = mergeProviderUsageEntry(
      two,
      report(PROVIDER_USAGE_RESET_CREDIT_GRACE_MS + 1_000, {
        availableCount: 1,
        credits: [credit({ id: "credit-b" })],
      }),
    );

    expect(creditsOf(one).map((entry) => entry.id)).toEqual(["credit-b"]);
    expect(countOf(one)).toBe(1);
  });

  it("does not ratchet the count up across refreshes that disagree", () => {
    const peak = mergeProviderUsageEntry(
      {},
      report(0, { availableCount: 3, credits: [credit({ id: null })] }),
    );
    expect(countOf(peak)).toBe(3);

    const settled = mergeProviderUsageEntry(
      peak,
      report(PROVIDER_USAGE_RESET_CREDIT_GRACE_MS + 1_000, {
        availableCount: 1,
        credits: [credit({ id: null })],
      }),
    );

    expect(countOf(settled)).toBe(1);
  });

  it("drops an expired credit even inside the grace window", () => {
    const seen = mergeProviderUsageEntry(
      {},
      report(0, {
        availableCount: 1,
        credits: [credit({ expiresAt: T0 + 10_000 })],
      }),
    );
    const afterExpiry = mergeProviderUsageEntry(seen, report(20_000, null));

    expect(afterExpiry[ACCOUNT]?.resetCredits ?? null).toBeNull();
  });

  it("hides an expired credit at read time without waiting for a report", () => {
    const resetCredits = { availableCount: 1, credits: [credit({ expiresAt: T0 + 10_000 })] };

    expect(activeResetCredits(resetCredits, T0 + 5_000)).toBe(resetCredits);
    expect(activeResetCredits(resetCredits, T0 + 20_000)).toBeNull();
  });

  it("ignores reset data from a report older than what is already known", () => {
    const current = mergeProviderUsageEntry(
      {},
      report(60_000, { availableCount: 1, credits: [credit()] }),
    );
    const late = mergeProviderUsageEntry(current, report(0, null));

    expect(creditsOf(late).map((entry) => entry.id)).toEqual(["credit-a"]);
  });

  it("leaves a report that carries no reset information alone", () => {
    const seen = mergeProviderUsageEntry({}, report(0, { availableCount: 1, credits: [credit()] }));
    const unrelated = mergeProviderUsageEntry(
      seen,
      report(PROVIDER_USAGE_RESET_CREDIT_GRACE_MS + 1_000, undefined),
    );

    expect(creditsOf(unrelated).map((entry) => entry.id)).toEqual(["credit-a"]);
  });

  it("keeps a dismissed credit dismissed when the provider reports it again", () => {
    const seen = mergeProviderUsageEntry({}, report(0, { availableCount: 1, credits: [credit()] }));
    const dismissed = dismissProviderUsageResetCredit(seen, ACCOUNT, credit());

    expect(dismissed[ACCOUNT]?.resetCredits ?? null).toBeNull();
    expect(dismissed[ACCOUNT]?.dismissedResetCreditKeys).toEqual([
      providerUsageResetCreditKey(credit()),
    ]);

    const reReported = mergeProviderUsageEntry(
      dismissed,
      report(30_000, { availableCount: 1, credits: [credit()] }),
    );
    expect(reReported[ACCOUNT]?.resetCredits ?? null).toBeNull();
  });

  it("does not age out the surviving credits when one is dismissed", () => {
    const seen = mergeProviderUsageEntry(
      {},
      report(0, { availableCount: 2, credits: [credit(), credit({ id: "credit-b" })] }),
    );
    const dismissed = dismissProviderUsageResetCredit(seen, ACCOUNT, credit());

    expect(creditsOf(dismissed).map((entry) => entry.id)).toEqual(["credit-b"]);
    expect(countOf(dismissed)).toBe(1);
  });
});
