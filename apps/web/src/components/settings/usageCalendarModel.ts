import { localDayKey, type UsageTotals } from "../../providerUsageLedger";

export type UsageCalendarLevel = 0 | 1 | 2 | 3 | 4;

export interface UsageCalendarCell {
  readonly day: string;
  readonly tokens: number;
  readonly turns: number;
  readonly costUsd: number | null;
  readonly level: UsageCalendarLevel;
  /** False for the leading days that pad the first week back to Sunday. */
  readonly inRange: boolean;
}

export interface UsageCalendarColumn {
  readonly weekStart: string;
  /** Seven cells, Sunday first. */
  readonly cells: ReadonlyArray<UsageCalendarCell>;
}

export interface UsageCalendarMonthLabel {
  readonly columnIndex: number;
  readonly label: string;
}

export interface UsageCalendar {
  readonly columns: ReadonlyArray<UsageCalendarColumn>;
  readonly monthLabels: ReadonlyArray<UsageCalendarMonthLabel>;
  /** Token counts at which a day moves from one level to the next. */
  readonly thresholds: ReadonlyArray<number>;
  readonly activeDays: number;
  readonly peakTokens: number;
}

const DAY_MS = 24 * 60 * 60_000;
const MONTH_FORMAT = new Intl.DateTimeFormat(undefined, { month: "short" });

function tokensOf(totals: UsageTotals): number {
  return (
    totals.inputTokens + totals.cachedInputTokens + totals.outputTokens + totals.reasoningTokens
  );
}

function localDate(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1);
}

/**
 * Level thresholds are the quartiles of the days that had any activity, so
 * the scale describes *this* account's habit rather than an absolute token
 * count: a quiet account still gets a full range, a busy one is not all-dark.
 */
export function usageCalendarThresholds(values: ReadonlyArray<number>): ReadonlyArray<number> {
  const sorted = values.filter((value) => value > 0).sort((left, right) => left - right);
  if (sorted.length === 0) return [];
  // Nearest-rank quartiles, so the busiest day always sits above the last
  // threshold and reaches the top level.
  const at = (fraction: number) =>
    sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)] ?? 0;
  return [at(0.25), at(0.5), at(0.75)];
}

export function usageCalendarLevel(
  tokens: number,
  thresholds: ReadonlyArray<number>,
): UsageCalendarLevel {
  if (tokens <= 0) return 0;
  let level = 1;
  for (const threshold of thresholds) if (tokens > threshold) level += 1;
  return Math.min(4, level) as UsageCalendarLevel;
}

/**
 * The last `weeks` weeks as columns of seven days, Sunday first, ending on
 * today's column — the GitHub contribution calendar, for tokens.
 */
export function buildUsageCalendar(input: {
  readonly byDay: ReadonlyMap<string, UsageTotals>;
  readonly nowMs: number;
  readonly weeks?: number;
}): UsageCalendar {
  const weeks = Math.max(1, input.weeks ?? 52);
  const today = localDate(localDayKey(input.nowMs));
  const firstDay = new Date(today);
  firstDay.setDate(today.getDate() - (weeks * 7 - 1));
  const rangeStartKey = localDayKey(firstDay.getTime());
  // Pad back to Sunday so every column is a whole week.
  const gridStart = new Date(firstDay);
  gridStart.setDate(firstDay.getDate() - firstDay.getDay());

  const inRangeTokens: number[] = [];
  for (const [day, totals] of input.byDay) {
    if (day >= rangeStartKey) inRangeTokens.push(tokensOf(totals));
  }
  const thresholds = usageCalendarThresholds(inRangeTokens);

  const columns: UsageCalendarColumn[] = [];
  const monthLabels: UsageCalendarMonthLabel[] = [];
  let activeDays = 0;
  let peakTokens = 0;
  let lastMonth = -1;
  const cursor = new Date(gridStart);
  while (cursor.getTime() <= today.getTime() + DAY_MS / 2) {
    const cells: UsageCalendarCell[] = [];
    const weekStart = localDayKey(cursor.getTime());
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const day = localDayKey(cursor.getTime());
      const inRange = day >= rangeStartKey && cursor.getTime() <= today.getTime() + DAY_MS / 2;
      const totals = inRange ? input.byDay.get(day) : undefined;
      const tokens = totals === undefined ? 0 : tokensOf(totals);
      if (inRange && tokens > 0) {
        activeDays += 1;
        peakTokens = Math.max(peakTokens, tokens);
      }
      if (inRange && cursor.getMonth() !== lastMonth) {
        // Label a month at the first column that holds one of its days,
        // unless that column already carries a label (a month that starts
        // mid-week shares the column with the previous month's tail).
        if (monthLabels.at(-1)?.columnIndex !== columns.length) {
          monthLabels.push({ columnIndex: columns.length, label: MONTH_FORMAT.format(cursor) });
        }
        lastMonth = cursor.getMonth();
      }
      cells.push({
        day,
        tokens,
        turns: totals?.turns ?? 0,
        costUsd: totals?.costUsd ?? null,
        level: inRange ? usageCalendarLevel(tokens, thresholds) : 0,
        inRange,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    columns.push({ weekStart, cells });
  }
  // A label squeezed into the very first column collides with the one for
  // the next month when the range starts in a month's last days.
  if (
    monthLabels.length >= 2 &&
    monthLabels[0]?.columnIndex === 0 &&
    (monthLabels[1]?.columnIndex ?? 0) < 3
  ) {
    monthLabels.shift();
  }
  return { columns, monthLabels, thresholds, activeDays, peakTokens };
}
