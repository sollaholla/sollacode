import { expect, it } from "vite-plus/test";
import { openCodeUsageWindows } from "./openCodeUsage.ts";

const usage = (sessionCost: unknown) => ({
  source: "opencode-session",
  sessionId: "one",
  sessionCost,
});

it("displays a session estimate including zero and sub-cent costs without a quota", () => {
  for (const [cost, detail] of [
    [0, "$0.00"],
    [0.001, "$<0.01"],
    [1.2345, "$1.23"],
  ] as const) {
    expect(openCodeUsageWindows(usage(cost))).toMatchObject([
      {
        key: "session-cost",
        label: "Session cost",
        usedPercent: null,
        resetAt: null,
        detail,
      },
    ]);
  }
});

it("does not turn malformed or unreported usage into free usage", () => {
  for (const cost of [undefined, "0", null, -1, NaN, Infinity])
    expect(openCodeUsageWindows(usage(cost))).toEqual([]);
  for (const raw of [
    null,
    {},
    { ...usage(2), source: "muse-spend" },
    { ...usage(2), sessionId: "" },
  ]) {
    expect(openCodeUsageWindows(raw)).toEqual([]);
  }
});
