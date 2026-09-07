import type { ThreadTokenUsageSnapshot } from "@t3tools/contracts";

/** Credits per million tokens [input, cached input, output], audited 2026-09-06:
 * https://learn.chatgpt.com/docs/pricing#token-rates
 * These are Codex credits, not API dollars. Unknown models (Codex-Spark, which
 * has its own limit and no published rate) have no invented rate. Keys are
 * matched exactly first, then as a lower-case substring of the slug, so
 * "gpt-5.6-daybreak-blue" finds "daybreak-blue".
 */
const CODEX_CREDIT_RATES: Readonly<Record<string, readonly [number, number, number]>> = {
  "gpt-6-astra": [250, 25, 1250],
  "daybreak-red": [312.5, 31.25, 1875],
  "gpt-5.5": [125, 12.5, 750],
  "gpt-5.6-sol": [100, 10, 500],
  "daybreak-blue": [100, 10, 500],
  "gpt-5.4-mini": [18.75, 1.875, 113],
  "gpt-5.4": [62.5, 6.25, 375],
  "gpt-5.6-terra": [50, 5, 300],
  "gpt-5.6-luna": [5, 0.5, 30],
};

export function codexCreditRate(
  model: string | null,
): readonly [number, number, number] | undefined {
  if (model === null) return undefined;
  const exact = CODEX_CREDIT_RATES[model];
  if (exact) return exact;
  const slug = model.toLowerCase();
  // Longer keys first so "gpt-5.4-mini" wins over "gpt-5.4".
  for (const key of Object.keys(CODEX_CREDIT_RATES).sort((a, b) => b.length - a.length)) {
    if (slug.includes(key)) return CODEX_CREDIT_RATES[key];
  }
  return undefined;
}
export interface CreditUsage {
  readonly input: number;
  readonly cached: number;
  readonly output: number;
}
export interface UsageGuardCredits {
  readonly balance: number | null;
  readonly capacity: number;
  readonly unlimited: boolean;
  readonly spentAtReport: number;
}
export interface CreditLedger {
  readonly spent: number;
  readonly processedByThread?: Readonly<Record<string, number>>;
  readonly turns: Readonly<Record<string, number>>;
  readonly threads: Readonly<Record<string, CreditUsage>>;
  readonly calls: readonly { readonly atMs: number; readonly credits: number }[];
}
export const emptyCreditLedger = (): CreditLedger => ({
  spent: 0,
  turns: {},
  threads: {},
  calls: [],
});
const record = (value: unknown): Readonly<Record<string, unknown>> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

export function readCodexCredits(
  raw: unknown,
  spent: number,
  previous?: UsageGuardCredits | null,
): UsageGuardCredits | null {
  const envelope = record(raw);
  const snapshot = record(envelope?.rateLimits) ?? envelope;
  const credits = record(snapshot?.credits);
  if (!credits) return null;
  const rawBalance = credits.balance;
  const balance =
    typeof rawBalance === "number"
      ? rawBalance
      : typeof rawBalance === "string" && rawBalance.trim()
        ? Number(rawBalance)
        : NaN;
  return {
    balance:
      credits.hasCredits === false ? 0 : Number.isFinite(balance) && balance >= 0 ? balance : null,
    capacity: Math.max(previous?.capacity ?? 0, Number.isFinite(balance) ? balance : 0),
    unlimited: credits.unlimited === true,
    spentAtReport: spent,
  };
}

export function codexCreditCost(
  model: string | null,
  usage: CreditUsage,
  fast = false,
): number | null {
  const rate = codexCreditRate(model);
  if (!rate) return null;
  // Astra's documented fast multiplier is 2.5. Other fast rates are not inferred.
  if (fast && model !== "gpt-6-astra") return null;
  return (
    ((Math.max(0, usage.input - usage.cached) * rate[0] +
      usage.cached * rate[1] +
      usage.output * rate[2]) /
      1_000_000) *
    (fast ? 2.5 : 1)
  );
}

/** Cumulative counters deduplicate repeated usage events and include cache/output costs. */
export function recordCreditTokens(
  ledger: CreditLedger,
  input: {
    readonly threadKey: string;
    readonly model: string | null;
    readonly usage: ThreadTokenUsageSnapshot;
    readonly nowMs: number;
    readonly fast?: boolean | undefined;
  },
): CreditLedger {
  const usage = input.usage;
  if (usage.inputTokens === undefined || usage.outputTokens === undefined) return ledger;
  const current = {
    input: usage.inputTokens,
    cached: Math.min(usage.inputTokens, usage.cachedInputTokens ?? 0),
    output: usage.outputTokens,
  };
  const previous = ledger.threads[input.threadKey];
  const continues =
    previous &&
    current.input >= previous.input &&
    current.output >= previous.output &&
    current.cached >= previous.cached;
  const cumulativeDelta = continues
    ? {
        input: current.input - previous.input,
        cached: current.cached - previous.cached,
        output: current.output - previous.output,
      }
    : {
        input: usage.lastInputTokens ?? 0,
        cached: usage.lastCachedInputTokens ?? 0,
        output: usage.lastOutputTokens ?? 0,
      };
  // Codex's input/output fields describe `last`, not `total`. The processed
  // counter identifies a new call even when its context size is unchanged.
  const processed = usage.totalProcessedTokens;
  const delta =
    processed === undefined
      ? cumulativeDelta
      : ledger.processedByThread?.[input.threadKey] === processed
        ? { input: 0, cached: 0, output: 0 }
        : {
            input: usage.lastInputTokens ?? current.input,
            cached: usage.lastCachedInputTokens ?? current.cached,
            output: usage.lastOutputTokens ?? current.output,
          };
  const credits = codexCreditCost(input.model, delta, input.fast);
  const lastCost = codexCreditCost(
    input.model,
    {
      input: usage.lastInputTokens ?? delta.input,
      cached: usage.lastCachedInputTokens ?? delta.cached,
      output: usage.lastOutputTokens ?? delta.output,
    },
    input.fast,
  );
  const key = `${input.model ?? "unknown"}:${input.fast ? "fast" : "standard"}`;
  return {
    spent: ledger.spent + (credits ?? 0),
    processedByThread:
      processed === undefined
        ? (ledger.processedByThread ?? {})
        : Object.fromEntries([
            ...Object.entries(ledger.processedByThread ?? {})
              .filter(([key]) => key !== input.threadKey)
              .slice(-511),
            [input.threadKey, processed],
          ]),
    turns:
      credits !== null && credits > 0 && lastCost !== null
        ? {
            ...ledger.turns,
            [key]:
              ledger.turns[key] === undefined
                ? lastCost
                : ledger.turns[key]! * 0.7 + lastCost * 0.3,
          }
        : ledger.turns,
    threads: Object.fromEntries([
      ...Object.entries(ledger.threads)
        .filter(([key]) => key !== input.threadKey)
        .slice(-511),
      [input.threadKey, current],
    ]),
    calls:
      credits !== null && credits > 0
        ? [...ledger.calls, { atMs: input.nowMs, credits }].slice(-64)
        : ledger.calls,
  };
}

export function creditTurnCost(
  ledger: CreditLedger,
  model: string | null,
  fast: boolean,
): number | null {
  return (
    ledger.turns[`${model ?? "unknown"}:${fast ? "fast" : "standard"}`] ??
    // Before observing a call, budget 150k uncached input and 15k output tokens.
    codexCreditCost(model, { input: 150_000, cached: 0, output: 15_000 }, fast)
  );
}

/** Calendar-day pacing follows the environment's local time, including DST. */
export function creditBudgetDay(nowMs: number) {
  // Local-midnight arithmetic needs the platform Date; Effect's DateTime has no
  // zone-aware "start of day" for the process's own zone.
  // @effect-diagnostics-next-line globalDate:off
  const start = new Date(nowMs);
  start.setHours(0, 0, 0, 0);
  // @effect-diagnostics-next-line globalDate:off
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { startsAt: start.getTime(), endsAt: end.getTime() };
}
