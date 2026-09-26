import { describe, expect, it } from "vite-plus/test";
import {
  deepCodeUsageWindows,
  formatDeepCodeCredit,
  parseDeepCodeBalance,
} from "./deepcodeUsage.ts";

const balance = {
  is_available: true,
  balance_infos: [
    {
      currency: "USD",
      total_balance: "12.3000",
      granted_balance: "2.3",
      topped_up_balance: "10.00",
    },
  ],
};
describe("Deep Code balance", () => {
  it("keeps exact credit amounts without inventing a percent or reset", () => {
    expect(parseDeepCodeBalance(balance)).toEqual(balance);
    expect(deepCodeUsageWindows(balance)[0]).toMatchObject({
      detail: "$12.3",
      usedPercent: null,
      resetAt: null,
      description: "$2.3 granted · $10 topped up",
    });
    expect(formatDeepCodeCredit("0.00000001", "CNY")).toBe("¥0.00000001");
  });
  it("separates missing, depleted, and multiple currency balances", () => {
    expect(deepCodeUsageWindows(null)).toEqual([]);
    expect(deepCodeUsageWindows({ is_available: false, balance_infos: [] })[0]?.detail).toBe(
      "Insufficient credit",
    );
    expect(
      deepCodeUsageWindows({
        ...balance,
        balance_infos: [...balance.balance_infos, { ...balance.balance_infos[0], currency: "CNY" }],
      }),
    ).toHaveLength(3);
  });
  it.each([
    {},
    { ...balance, is_available: "true" },
    { ...balance, balance_infos: [{ ...balance.balance_infos[0], total_balance: "NaN" }] },
    { ...balance, balance_infos: [balance.balance_infos[0], balance.balance_infos[0]] },
  ])("rejects malformed reports", (value) => {
    expect(parseDeepCodeBalance(value)).toBeNull();
  });
});
