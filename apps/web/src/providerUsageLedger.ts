import type { OrchestrationThreadActivity } from "@t3tools/contracts";

/**
 * Per-turn token usage as observed by this client. The server normalises every
 * provider's counters into `context-window.updated` activities whose `last*`
 * fields describe the turn that just finished; a turn's cost, when a provider
 * reports one, rides on a later activity for the same turn. Keying by turn id
 * (falling back to the activity id) makes re-observing a thread idempotent.
 */
export interface LedgerTurn {
  readonly driver: string;
  /** ISO timestamp of the activity that reported the tokens. */
  readonly at: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  /** Provider-reported cost in USD; null when the provider reported none. */
  readonly costUsd: number | null;
}

export interface ProviderUsageLedger {
  readonly version: 1;
  readonly turns: Readonly<Record<string, LedgerTurn>>;
}

export const EMPTY_PROVIDER_USAGE_LEDGER: ProviderUsageLedger = { version: 1, turns: {} };

/** Oldest turns are dropped past this so persisted state stays small. */
export const MAX_LEDGER_TURNS = 5_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function turnKey(driver: string, activity: OrchestrationThreadActivity): string {
  return `${driver}:${activity.turnId ?? `activity:${activity.id}`}`;
}

/**
 * Fold a thread's activities into the ledger for the provider that ran them.
 * Returns the same ledger instance when nothing changed so React effects and
 * persisted state stay quiet.
 */
export function recordActivitiesIntoLedger(
  ledger: ProviderUsageLedger,
  driver: string,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ProviderUsageLedger {
  let turns: Record<string, LedgerTurn> | null = null;
  const current = () => turns ?? (turns = { ...ledger.turns });
  for (const activity of activities) {
    const payload = asRecord(activity.payload);
    if (!payload) continue;
    const key = turnKey(driver, activity);
    if (activity.kind === "context-window.updated") {
      const next: LedgerTurn = {
        driver,
        at: activity.createdAt,
        inputTokens: asCount(payload.lastInputTokens),
        cachedInputTokens: asCount(payload.lastCachedInputTokens),
        outputTokens: asCount(payload.lastOutputTokens),
        reasoningTokens: asCount(payload.lastReasoningOutputTokens),
        costUsd: (turns ?? ledger.turns)[key]?.costUsd ?? null,
      };
      if (
        next.inputTokens + next.cachedInputTokens + next.outputTokens + next.reasoningTokens ===
        0
      ) {
        continue;
      }
      const previous = (turns ?? ledger.turns)[key];
      if (
        previous &&
        previous.inputTokens === next.inputTokens &&
        previous.cachedInputTokens === next.cachedInputTokens &&
        previous.outputTokens === next.outputTokens &&
        previous.reasoningTokens === next.reasoningTokens &&
        previous.at === next.at
      ) {
        continue;
      }
      current()[key] = next;
      continue;
    }
    const cost = payload.totalCostUsd;
    if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
      const previous = (turns ?? ledger.turns)[key];
      if (previous?.costUsd === cost) continue;
      current()[key] = previous
        ? { ...previous, costUsd: cost }
        : {
            driver,
            at: activity.createdAt,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            costUsd: cost,
          };
    }
  }
  if (turns === null) return ledger;
  const keys = Object.keys(turns);
  if (keys.length > MAX_LEDGER_TURNS) {
    const sorted = keys.sort((left, right) => turns![left]!.at.localeCompare(turns![right]!.at));
    for (const key of sorted.slice(0, keys.length - MAX_LEDGER_TURNS)) {
      delete turns[key];
    }
  }
  return { version: 1, turns };
}

export interface UsageTotals {
  readonly turns: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  /** Sum of reported costs; null when no turn in the range reported one. */
  readonly costUsd: number | null;
}

export interface UsageDayBucket extends UsageTotals {
  /** Local calendar day, YYYY-MM-DD. */
  readonly day: string;
}

export interface ProviderUsageDigest {
  readonly today: UsageTotals;
  readonly last7Days: UsageTotals;
  readonly last30Days: UsageTotals;
  readonly allTime: UsageTotals;
  /** Every calendar day of the last two weeks, newest first, zero-filled. */
  readonly recentDays: ReadonlyArray<UsageDayBucket>;
}

const EMPTY_TOTALS: UsageTotals = {
  turns: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  costUsd: null,
};

export function totalTokens(totals: UsageTotals): number {
  return (
    totals.inputTokens + totals.cachedInputTokens + totals.outputTokens + totals.reasoningTokens
  );
}

function localDayKey(ms: number): string {
  const date = new Date(ms);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function add(totals: UsageTotals, turn: LedgerTurn): UsageTotals {
  return {
    turns: totals.turns + 1,
    inputTokens: totals.inputTokens + turn.inputTokens,
    cachedInputTokens: totals.cachedInputTokens + turn.cachedInputTokens,
    outputTokens: totals.outputTokens + turn.outputTokens,
    reasoningTokens: totals.reasoningTokens + turn.reasoningTokens,
    costUsd: turn.costUsd === null ? totals.costUsd : (totals.costUsd ?? 0) + turn.costUsd,
  };
}

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Aggregate one provider's ledger into the ranges the usage panel shows. */
export function digestProviderUsage(
  ledger: ProviderUsageLedger,
  driver: string,
  nowMs: number = Date.now(),
): ProviderUsageDigest {
  let today = EMPTY_TOTALS;
  let last7Days = EMPTY_TOTALS;
  let last30Days = EMPTY_TOTALS;
  let allTime = EMPTY_TOTALS;
  const byDay = new Map<string, UsageTotals>();
  const todayKey = localDayKey(nowMs);
  for (const turn of Object.values(ledger.turns)) {
    if (turn.driver !== driver) continue;
    const atMs = Date.parse(turn.at);
    if (!Number.isFinite(atMs)) continue;
    allTime = add(allTime, turn);
    const ageMs = nowMs - atMs;
    if (ageMs <= 30 * DAY_MS) last30Days = add(last30Days, turn);
    if (ageMs <= 7 * DAY_MS) last7Days = add(last7Days, turn);
    const dayKey = localDayKey(atMs);
    if (dayKey === todayKey) today = add(today, turn);
    byDay.set(dayKey, add(byDay.get(dayKey) ?? EMPTY_TOTALS, turn));
  }
  const recentDays: UsageDayBucket[] = [];
  for (let offset = 0; offset < 14; offset += 1) {
    const day = localDayKey(nowMs - offset * DAY_MS);
    recentDays.push({ day, ...(byDay.get(day) ?? EMPTY_TOTALS) });
  }
  return { today, last7Days, last30Days, allTime, recentDays };
}
