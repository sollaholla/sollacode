import { describe, expect, it } from "vite-plus/test";

import type { UsageTotals } from "../../providerUsageLedger";
import {
  buildUsageCalendar,
  usageCalendarLevel,
  usageCalendarThresholds,
} from "./usageCalendarModel";

function totals(tokens: number, turns = 1): UsageTotals {
  return {
    inputTokens: tokens,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    turns,
    costUsd: null,
  } as UsageTotals;
}

// A Wednesday, local time, mid-day.
const NOW = new Date(2026, 8, 9, 12, 0, 0).getTime();

describe("usageCalendarThresholds", () => {
  it("uses the quartiles of the active days only", () => {
    expect(usageCalendarThresholds([0, 0, 10, 20, 30, 40])).toEqual([10, 20, 30]);
    expect(usageCalendarThresholds([])).toEqual([]);
    expect(usageCalendarLevel(0, [10, 20, 30])).toBe(0);
    expect(usageCalendarLevel(10, [10, 20, 30])).toBe(1);
    expect(usageCalendarLevel(25, [10, 20, 30])).toBe(3);
    expect(usageCalendarLevel(35, [10, 20, 30])).toBe(4);
    expect(usageCalendarLevel(99, [10, 20, 30])).toBe(4);
  });
});

describe("buildUsageCalendar", () => {
  it("lays out whole weeks ending on today, Sunday first", () => {
    const calendar = buildUsageCalendar({ byDay: new Map(), nowMs: NOW, weeks: 4 });
    // 28 days back from a Wednesday lands on a Thursday; that week is padded
    // back to its Sunday, so four weeks of days need five whole-week columns.
    expect(calendar.columns).toHaveLength(5);
    const last = calendar.columns.at(-1)!;
    expect(last.cells.map((cell) => cell.day)).toEqual([
      "2026-09-06",
      "2026-09-07",
      "2026-09-08",
      "2026-09-09",
      "2026-09-10",
      "2026-09-11",
      "2026-09-12",
    ]);
    // Wednesday is today; Thursday onward is outside the range.
    expect(last.cells.map((cell) => cell.inRange)).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(calendar.columns[0]?.cells[0]?.day).toBe("2026-08-09");
    expect(calendar.columns[0]?.cells.map((cell) => cell.inRange)).toEqual([
      false,
      false,
      false,
      false,
      true,
      true,
      true,
    ]);
  });

  it("levels each day against the account's own habit and counts active days", () => {
    const byDay = new Map<string, UsageTotals>([
      ["2026-09-09", totals(400_000, 3)],
      ["2026-09-08", totals(100_000)],
      ["2026-09-01", totals(50_000)],
      ["2026-08-20", totals(10_000)],
      ["2020-01-01", totals(9_999_999)], // outside the range: ignored entirely
    ]);
    const calendar = buildUsageCalendar({ byDay, nowMs: NOW, weeks: 4 });
    expect(calendar.activeDays).toBe(4);
    expect(calendar.peakTokens).toBe(400_000);
    const cell = (day: string) =>
      calendar.columns.flatMap((column) => column.cells).find((entry) => entry.day === day)!;
    expect(cell("2026-09-09").level).toBe(4);
    expect(cell("2026-09-08").level).toBe(3);
    expect(cell("2026-08-20").level).toBe(1);
    expect(cell("2026-09-07").level).toBe(0);
    expect(cell("2026-09-09").turns).toBe(3);
  });

  it("labels each month at the first column holding one of its days", () => {
    const calendar = buildUsageCalendar({ byDay: new Map(), nowMs: NOW, weeks: 8 });
    const labels = calendar.monthLabels.map((month) => month.label);
    expect(labels).toEqual(["Aug", "Sep"]);
    const september = calendar.monthLabels.find((month) => month.label === "Sep")!;
    expect(
      calendar.columns[september.columnIndex]?.cells.some((cell) => cell.day === "2026-09-01"),
    ).toBe(true);
  });
});
