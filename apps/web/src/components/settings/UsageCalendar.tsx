import { useMemo } from "react";

import { cn } from "../../lib/utils";
import { formatTokens } from "../../orchestrator/usageTracking";
import type { UsageTotals } from "../../providerUsageLedger";
import { buildUsageCalendar, type UsageCalendarLevel } from "./usageCalendarModel";

const CELL = 10;
const GAP = 2;
const COLUMN = CELL + GAP;

/**
 * Sequential gold, one hue light->dark, anchored the other way round in dark
 * mode so "more" is the brighter step on a black surface. Level 0 is the
 * surface's own ink at low alpha, not a colour, so an empty day reads as
 * empty and not as the lightest amount.
 */
const LEVEL_CLASS: Record<UsageCalendarLevel, string> = {
  0: "bg-foreground/8",
  1: "bg-gold-300 dark:bg-gold-700",
  2: "bg-gold-400 dark:bg-gold-600",
  3: "bg-gold-500 dark:bg-gold-500",
  4: "bg-gold-700 dark:bg-gold-300",
};

const WEEKDAY_LABELS: ReadonlyArray<readonly [row: number, label: string]> = [
  [1, "Mon"],
  [3, "Wed"],
  [5, "Fri"],
];

const DAY_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});

function formatDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) return day;
  return DAY_FORMAT.format(new Date(year, month - 1, date));
}

/**
 * A year of days as a calendar of cells, darker the more tokens the day
 * spent — the contribution graph, for usage. Reads the same per-day totals
 * as the table below it, so a cell and its row always agree.
 */
export function UsageCalendar({
  byDay,
  nowMs,
  weeks = 52,
  label,
}: {
  readonly byDay: ReadonlyMap<string, UsageTotals>;
  readonly nowMs: number;
  readonly weeks?: number;
  readonly label: string;
}) {
  const calendar = useMemo(
    () => buildUsageCalendar({ byDay, nowMs, weeks }),
    [byDay, nowMs, weeks],
  );
  const width = calendar.columns.length * COLUMN - GAP;
  return (
    <div className="space-y-1.5" data-testid="usage-calendar">
      <div className="flex items-baseline justify-between gap-3 text-[11px] text-muted-foreground">
        <span>
          <span className="font-medium text-foreground">{calendar.activeDays}</span> active{" "}
          {calendar.activeDays === 1 ? "day" : "days"} in the last{" "}
          {weeks === 52 ? "year" : `${weeks} weeks`}
          {calendar.peakTokens > 0 ? ` · busiest ${formatTokens(calendar.peakTokens)} tokens` : ""}
        </span>
        <span className="flex items-center gap-1" aria-hidden>
          Less
          {([0, 1, 2, 3, 4] as const).map((level) => (
            <span
              key={level}
              className={cn("inline-block rounded-[2px]", LEVEL_CLASS[level])}
              style={{ width: CELL, height: CELL }}
            />
          ))}
          More
        </span>
      </div>
      <div className="overflow-x-auto pb-1" dir="ltr">
        <div
          className="flex gap-1.5 text-[10px] text-muted-foreground"
          role="img"
          aria-label={`${label} tokens per day, last ${weeks} weeks: ${calendar.activeDays} active days`}
          style={{ minWidth: width + 30 }}
        >
          <div className="relative shrink-0" style={{ width: 24, paddingTop: 14 }}>
            {WEEKDAY_LABELS.map(([row, text]) => (
              <span
                key={text}
                className="absolute left-0 leading-none"
                style={{ top: 14 + row * COLUMN + 1 }}
              >
                {text}
              </span>
            ))}
            <div style={{ height: 7 * COLUMN - GAP }} />
          </div>
          <div className="shrink-0">
            <div className="relative h-[14px]" style={{ width }}>
              {calendar.monthLabels.map((month) => (
                <span
                  key={`${month.columnIndex}-${month.label}`}
                  className="absolute top-0 leading-none"
                  style={{ left: month.columnIndex * COLUMN }}
                >
                  {month.label}
                </span>
              ))}
            </div>
            <div className="flex" style={{ gap: GAP }}>
              {calendar.columns.map((column) => (
                <div key={column.weekStart} className="flex flex-col" style={{ gap: GAP }}>
                  {column.cells.map((cell) => (
                    <div
                      key={cell.day}
                      data-level={cell.inRange ? cell.level : undefined}
                      title={
                        cell.inRange
                          ? cell.tokens === 0
                            ? `${formatDay(cell.day)} · no activity`
                            : `${formatDay(cell.day)} · ${formatTokens(cell.tokens)} tokens · ${cell.turns} ${cell.turns === 1 ? "turn" : "turns"}`
                          : undefined
                      }
                      className={cn(
                        "rounded-[2px]",
                        cell.inRange ? LEVEL_CLASS[cell.level] : "bg-transparent",
                      )}
                      style={{ width: CELL, height: CELL }}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
