/**
 * What the voice orchestrator has cost.
 *
 * The numbers come from the Realtime API itself: every `response.done` carries
 * a `usage` block with the tokens that response actually consumed, split into
 * text and audio and marked for cache hits. That is authoritative for this
 * app's own spend, and needs no admin credentials — OpenAI's organisation usage
 * endpoints require an Admin key, which is not what is configured here.
 *
 * Token counts are therefore exact. Money is an *estimate*: it is those counts
 * multiplied by a rate table compiled by hand, and published rates change
 * without notice. Anything shown as a cost is labelled as an estimate for that
 * reason, and a model with no rate entry reports its tokens with no dollar
 * figure rather than a fabricated one.
 */

export interface RealtimeUsage {
  readonly inputTextTokens: number;
  readonly inputAudioTokens: number;
  readonly cachedTextTokens: number;
  readonly cachedAudioTokens: number;
  readonly outputTextTokens: number;
  readonly outputAudioTokens: number;
}

export const EMPTY_USAGE: RealtimeUsage = {
  inputTextTokens: 0,
  inputAudioTokens: 0,
  cachedTextTokens: 0,
  cachedAudioTokens: 0,
  outputTextTokens: 0,
  outputAudioTokens: 0,
};

export function addUsage(left: RealtimeUsage, right: RealtimeUsage): RealtimeUsage {
  return {
    inputTextTokens: left.inputTextTokens + right.inputTextTokens,
    inputAudioTokens: left.inputAudioTokens + right.inputAudioTokens,
    cachedTextTokens: left.cachedTextTokens + right.cachedTextTokens,
    cachedAudioTokens: left.cachedAudioTokens + right.cachedAudioTokens,
    outputTextTokens: left.outputTextTokens + right.outputTextTokens,
    outputAudioTokens: left.outputAudioTokens + right.outputAudioTokens,
  };
}

export function totalTokens(usage: RealtimeUsage): number {
  return (
    usage.inputTextTokens +
    usage.inputAudioTokens +
    usage.cachedTextTokens +
    usage.cachedAudioTokens +
    usage.outputTextTokens +
    usage.outputAudioTokens
  );
}

// ── Parsing ──────────────────────────────────────────────────────

function readNumber(source: unknown, key: string): number {
  if (typeof source !== "object" || source === null) return 0;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function readObject(source: unknown, key: string): unknown {
  if (typeof source !== "object" || source === null) return undefined;
  return (source as Record<string, unknown>)[key];
}

/**
 * Pulls the usage block out of a `response.done` payload.
 *
 * Defensive throughout: the field names have moved across API revisions, and a
 * usage block that fails to parse must cost the session nothing more than a
 * missing row in a settings table.
 */
export function parseRealtimeUsage(response: unknown): RealtimeUsage | null {
  const usage = readObject(response, "usage");
  if (usage === undefined || usage === null) return null;

  const inputDetails = readObject(usage, "input_token_details");
  const outputDetails = readObject(usage, "output_token_details");
  const cachedDetails = readObject(inputDetails, "cached_tokens_details");

  const cachedText = readNumber(cachedDetails, "text_tokens");
  const cachedAudio = readNumber(cachedDetails, "audio_tokens");
  // Older payloads report a flat `cached_tokens` with no split. Attribute it to
  // audio, which is what a speech session is overwhelmingly made of — and say
  // so here rather than silently pricing it as text, which is 80x cheaper.
  const flatCached = readNumber(inputDetails, "cached_tokens");
  const cachedAudioTokens =
    cachedAudio > 0 || cachedText > 0 ? cachedAudio : Math.max(0, flatCached);

  // The input totals include cached tokens; billing them again at full rate
  // would roughly double every estimate.
  const inputText = Math.max(0, readNumber(inputDetails, "text_tokens") - cachedText);
  const inputAudio = Math.max(0, readNumber(inputDetails, "audio_tokens") - cachedAudioTokens);

  const parsed: RealtimeUsage = {
    inputTextTokens: inputText,
    inputAudioTokens: inputAudio,
    cachedTextTokens: cachedText,
    cachedAudioTokens: cachedAudioTokens,
    outputTextTokens: readNumber(outputDetails, "text_tokens"),
    outputAudioTokens: readNumber(outputDetails, "audio_tokens"),
  };

  return totalTokens(parsed) > 0 ? parsed : null;
}

// ── Pricing ──────────────────────────────────────────────────────

export interface ModelRates {
  /** USD per 1M tokens. */
  readonly inputText: number;
  readonly inputAudio: number;
  readonly cachedText: number;
  readonly cachedAudio: number;
  readonly outputText: number;
  readonly outputAudio: number;
}

/**
 * Published rates, USD per 1M tokens, as of 2026-08.
 *
 * Longest matching prefix wins, so "gpt-realtime-2.1-mini" picks the mini row
 * rather than the flagship. These are a hand-maintained snapshot: OpenAI
 * changes them without notice, which is exactly why every figure derived from
 * them is presented as an estimate.
 */
export const MODEL_RATES: ReadonlyArray<readonly [string, ModelRates]> = [
  [
    "gpt-realtime-2-mini",
    {
      inputText: 0.6,
      inputAudio: 10,
      cachedText: 0.06,
      cachedAudio: 0.3,
      outputText: 2.4,
      outputAudio: 20,
    },
  ],
  [
    "gpt-realtime-2.1-mini",
    {
      inputText: 0.6,
      inputAudio: 10,
      cachedText: 0.06,
      cachedAudio: 0.3,
      outputText: 2.4,
      outputAudio: 20,
    },
  ],
  [
    "gpt-realtime-2",
    {
      inputText: 4,
      inputAudio: 32,
      cachedText: 0.4,
      cachedAudio: 0.4,
      outputText: 24,
      outputAudio: 64,
    },
  ],
];

export function ratesForModel(model: string): ModelRates | null {
  const normalized = model.trim().toLowerCase();
  let best: { readonly prefix: string; readonly rates: ModelRates } | null = null;
  for (const [prefix, rates] of MODEL_RATES) {
    if (!normalized.startsWith(prefix)) continue;
    if (best === null || prefix.length > best.prefix.length) best = { prefix, rates };
  }
  return best?.rates ?? null;
}

/** Estimated USD, or null when no rate is known for the model. */
export function estimateCostUsd(model: string, usage: RealtimeUsage): number | null {
  const rates = ratesForModel(model);
  if (rates === null) return null;
  const perMillion =
    usage.inputTextTokens * rates.inputText +
    usage.inputAudioTokens * rates.inputAudio +
    usage.cachedTextTokens * rates.cachedText +
    usage.cachedAudioTokens * rates.cachedAudio +
    usage.outputTextTokens * rates.outputText +
    usage.outputAudioTokens * rates.outputAudio;
  return perMillion / 1_000_000;
}

// ── Daily and monthly rollups ────────────────────────────────────

export interface UsageDay {
  /** Local calendar day, `YYYY-MM-DD`. */
  readonly date: string;
  readonly model: string;
  readonly usage: RealtimeUsage;
  readonly sessions: number;
}

/** Local, not UTC: "today" has to mean the user's today. */
export function localDayKey(at: Date): string {
  const year = at.getFullYear();
  const month = `${at.getMonth() + 1}`.padStart(2, "0");
  const day = `${at.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function monthKeyOf(dayKey: string): string {
  return dayKey.slice(0, 7);
}

/**
 * Folds one response's usage into the stored days.
 *
 * Rows are kept per (day, model) so a model change mid-month is priced with the
 * rates that actually applied, rather than the whole month being repriced at
 * whatever model happens to be configured when the table is rendered.
 */
export function recordUsage(
  days: ReadonlyArray<UsageDay>,
  entry: { readonly date: string; readonly model: string; readonly usage: RealtimeUsage },
): ReadonlyArray<UsageDay> {
  const index = days.findIndex((day) => day.date === entry.date && day.model === entry.model);
  if (index === -1) {
    return [...days, { ...entry, sessions: 1 }];
  }
  const existing = days[index];
  if (existing === undefined) return days;
  const next = [...days];
  next[index] = {
    ...existing,
    usage: addUsage(existing.usage, entry.usage),
    sessions: existing.sessions + 1,
  };
  return next;
}

export interface UsageBucket {
  readonly key: string;
  readonly usage: RealtimeUsage;
  /** Null when any model in the bucket has no known rate. */
  readonly costUsd: number | null;
  readonly models: ReadonlyArray<string>;
}

function bucketBy(
  days: ReadonlyArray<UsageDay>,
  keyOf: (day: UsageDay) => string,
): ReadonlyArray<UsageBucket> {
  const buckets = new Map<
    string,
    { usage: RealtimeUsage; cost: number | null; models: Set<string> }
  >();
  for (const day of days) {
    const key = keyOf(day);
    const bucket = buckets.get(key) ?? { usage: EMPTY_USAGE, cost: 0, models: new Set<string>() };
    const cost = estimateCostUsd(day.model, day.usage);
    buckets.set(key, {
      usage: addUsage(bucket.usage, day.usage),
      // One unpriced model makes the whole bucket's total unknown; showing a
      // partial sum as if it were the total would understate the bill.
      cost: bucket.cost === null || cost === null ? null : bucket.cost + cost,
      models: bucket.models.add(day.model),
    });
  }
  return [...buckets.entries()]
    .map(([key, value]) => ({
      key,
      usage: value.usage,
      costUsd: value.cost,
      models: [...value.models].sort(),
    }))
    .sort((left, right) => right.key.localeCompare(left.key));
}

/** Newest day first. */
export function dailyBuckets(days: ReadonlyArray<UsageDay>): ReadonlyArray<UsageBucket> {
  return bucketBy(days, (day) => day.date);
}

/** Newest month first. */
export function monthlyBuckets(days: ReadonlyArray<UsageDay>): ReadonlyArray<UsageBucket> {
  return bucketBy(days, (day) => monthKeyOf(day.date));
}

export function totalBucket(days: ReadonlyArray<UsageDay>): UsageBucket {
  const [all] = bucketBy(days, () => "all");
  return all ?? { key: "all", usage: EMPTY_USAGE, costUsd: 0, models: [] };
}

/** Days older than this are dropped, so the store cannot grow without bound. */
export const USAGE_RETENTION_DAYS = 180;

export function pruneUsage(days: ReadonlyArray<UsageDay>, now: Date): ReadonlyArray<UsageDay> {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - USAGE_RETENTION_DAYS);
  const cutoffKey = localDayKey(cutoff);
  return days.filter((day) => day.date >= cutoffKey);
}

// ── Formatting ───────────────────────────────────────────────────

export function formatUsd(value: number | null): string {
  if (value === null) return "—";
  if (value === 0) return "$0.00";
  // Sessions cost fractions of a cent; rounding those to $0.00 makes the table
  // look broken on a light day.
  if (value < 0.01) return `<$0.01`;
  return `$${value.toFixed(2)}`;
}

export function formatTokens(value: number): string {
  if (value < 1_000) return `${value}`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

/**
 * Audio tokens are duration-encoded — user audio at 1 token per 100ms, assistant
 * audio at 1 token per 50ms — so a spoken-minutes figure is more meaningful to
 * most people than a token count.
 */
export function estimateVoiceMinutes(usage: RealtimeUsage): number {
  const heardSeconds = (usage.inputAudioTokens + usage.cachedAudioTokens) / 10;
  const spokenSeconds = usage.outputAudioTokens / 20;
  return (heardSeconds + spokenSeconds) / 60;
}
