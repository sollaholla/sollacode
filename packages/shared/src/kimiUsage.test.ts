import { describe, expect, it } from "vite-plus/test";
import {
  KIMI_USAGE_SOURCE,
  kimiAccountUsageFrom,
  kimiUsageWindows,
  parseKimiUsagesResponse,
} from "./kimiUsage.ts";

const NOW = Date.parse("2026-10-24T03:00:00.000Z");

/** Shaped like the `/usages` body kimi 0.28's own `/usage` reads. */
const usages = {
  usage: { limit: "1000", used: "250", resetTime: "2026-10-27T00:00:00.123456789Z" },
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: { limit: 200, remaining: 50, resetIn: 3600 },
    },
    {
      title: "Monthly",
      window: { duration: 2, timeUnit: "TIME_UNIT_FORTNIGHT" },
      detail: { limit: 10, used: 1 },
    },
    { window: { duration: 1, timeUnit: "TIME_UNIT_DAY" }, detail: { limit: 0, used: 0 } },
  ],
  boosterWallet: {
    balance: { type: "BOOSTER", amount: "2000000000", amountLeft: "1250000000" },
    monthlyChargeLimit: { currency: "USD" },
  },
};

describe("Kimi usage", () => {
  it("reads the weekly limit, rolling windows, and the booster balance", () => {
    expect(parseKimiUsagesResponse(usages, NOW)).toEqual({
      source: KIMI_USAGE_SOURCE,
      windows: [
        {
          key: "weekly",
          label: "Weekly",
          usedPercent: 25,
          resetsAt: "2026-10-27T00:00:00.123Z",
          windowDurationMs: 7 * 24 * 60 * 60_000,
        },
        {
          key: "300m",
          label: "5h limit",
          usedPercent: 75,
          resetsAt: "2026-10-24T04:00:00.000Z",
          windowDurationMs: 5 * 60 * 60_000,
        },
      ],
      extraUsage: { balanceCents: 1250, totalCents: 2000, currency: "USD" },
    });
  });

  it("drops windows in units it does not know and rows with no limit", () => {
    const parsed = parseKimiUsagesResponse({ limits: usages.limits.slice(1) }, NOW);
    expect(parsed).toBeNull();
  });

  it("returns nothing for a body that is not a usage report", () => {
    expect(parseKimiUsagesResponse("nope", NOW)).toBeNull();
    expect(parseKimiUsagesResponse({ usage: { used: 3 } }, NOW)).toBeNull();
    expect(kimiAccountUsageFrom({ source: "opencode-session", windows: [] })).toBeNull();
  });

  it("turns the stored envelope into usage bar rows", () => {
    const rows = kimiUsageWindows(parseKimiUsagesResponse(usages, NOW));
    expect(rows.map((row) => [row.key, row.usedPercent, row.resetAt])).toEqual([
      ["weekly", 25, Date.parse("2026-10-27T00:00:00.123Z")],
      ["300m", 75, Date.parse("2026-10-24T04:00:00.000Z")],
      ["extra-usage", null, null],
    ]);
    expect(rows[2]).toMatchObject({ detail: "$12.50 left" });
  });
});
