import type { ProviderTurnUsage } from "@t3tools/contracts";

/** One model's token counts, as the Claude CLI reports them. */
interface ClaudeModelTotals {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
}

/**
 * A Claude session's usage as of its last result.
 *
 * Each result reports `modelUsage` and `total_cost_usd` accumulated over the
 * whole CLI session, sub-agents included, so a turn's usage is how far they
 * grew since the previous result. The result's own `usage` covers only the
 * turn's main loop, leaving out sub-agents, which are often most of a
 * workflow's spend.
 */
export interface ClaudeUsageLedger {
  readonly models: Readonly<Record<string, ClaudeModelTotals>>;
  readonly costUsd: number | undefined;
}

/** A fresh session starts from nothing; a resumed one may not (its counters can carry over). */
export const EMPTY_CLAUDE_USAGE_LEDGER: ClaudeUsageLedger = { models: {}, costUsd: 0 };

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function readModelUsage(value: unknown): Record<string, ClaudeModelTotals> | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const models: Record<string, ClaudeModelTotals> = {};
  for (const [model, raw] of Object.entries(record)) {
    const usage = asRecord(raw);
    if (usage === undefined || model.trim().length === 0) continue;
    models[model] = {
      inputTokens: count(usage.inputTokens),
      cachedInputTokens: count(usage.cacheReadInputTokens),
      cacheWriteTokens: count(usage.cacheCreationInputTokens),
      outputTokens: count(usage.outputTokens),
    };
  }
  return Object.keys(models).length > 0 ? models : undefined;
}

const totalOf = (usage: ClaudeModelTotals): number =>
  usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteTokens + usage.outputTokens;

function withModel(
  usage: ClaudeModelTotals,
  model: string | undefined,
): ProviderTurnUsage | undefined {
  if (totalOf(usage) === 0) return undefined;
  return { ...usage, ...(model?.trim() ? { model: model.trim() } : {}) };
}

/** The turn's main loop alone: all there is when the session baseline is unknown. */
function mainLoopUsage(value: unknown, model: string | undefined): ProviderTurnUsage | undefined {
  const usage = asRecord(value);
  if (usage === undefined) return undefined;
  return withModel(
    {
      inputTokens: count(usage.input_tokens),
      cachedInputTokens: count(usage.cache_read_input_tokens),
      cacheWriteTokens: count(usage.cache_creation_input_tokens),
      outputTokens: count(usage.output_tokens),
    },
    model,
  );
}

/**
 * What a Claude turn consumed, and the ledger to measure the next one from.
 *
 * `ledger` is undefined when the session's starting point is unknown, as
 * after a resume, where the CLI may restore earlier totals. That turn falls
 * back to its main loop, and every later turn is measured exactly. A counter
 * that went backwards means a different session than the one measured, and
 * gets the same treatment.
 */
export function claudeTurnUsage(input: {
  readonly ledger: ClaudeUsageLedger | undefined;
  readonly result:
    | {
        readonly usage?: unknown;
        readonly modelUsage?: unknown;
        readonly total_cost_usd?: unknown;
      }
    | undefined;
  /** The session's model, used when the turn's own breakdown names none. */
  readonly model: string | undefined;
}): {
  readonly usage: ProviderTurnUsage | undefined;
  readonly ledger: ClaudeUsageLedger | undefined;
} {
  const { result } = input;
  if (result === undefined) return { usage: undefined, ledger: input.ledger };
  const models = readModelUsage(result.modelUsage);
  if (models === undefined) {
    return { usage: mainLoopUsage(result.usage, input.model), ledger: input.ledger };
  }
  const cost =
    typeof result.total_cost_usd === "number" &&
    Number.isFinite(result.total_cost_usd) &&
    result.total_cost_usd >= 0
      ? result.total_cost_usd
      : undefined;
  const ledger: ClaudeUsageLedger = { models, costUsd: cost };
  const previous = input.ledger;
  const fallback = { usage: mainLoopUsage(result.usage, input.model), ledger };
  if (previous === undefined) return fallback;
  if (Object.keys(previous.models).some((model) => !(model in models))) return fallback;

  const turn = { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  let dominant: { readonly model: string; readonly tokens: number } | undefined;
  for (const [model, totals] of Object.entries(models)) {
    const before = previous.models[model];
    const delta: ClaudeModelTotals = {
      inputTokens: totals.inputTokens - (before?.inputTokens ?? 0),
      cachedInputTokens: totals.cachedInputTokens - (before?.cachedInputTokens ?? 0),
      cacheWriteTokens: totals.cacheWriteTokens - (before?.cacheWriteTokens ?? 0),
      outputTokens: totals.outputTokens - (before?.outputTokens ?? 0),
    };
    if (Object.values(delta).some((value) => value < 0)) return fallback;
    turn.inputTokens += delta.inputTokens;
    turn.cachedInputTokens += delta.cachedInputTokens;
    turn.cacheWriteTokens += delta.cacheWriteTokens;
    turn.outputTokens += delta.outputTokens;
    const tokens = totalOf(delta);
    if (tokens > 0 && (dominant === undefined || tokens > dominant.tokens)) {
      dominant = { model, tokens };
    }
  }
  const usage = withModel(turn, dominant?.model ?? input.model);
  if (usage === undefined) return { usage: undefined, ledger };
  const costUsd =
    cost !== undefined && previous.costUsd !== undefined && cost >= previous.costUsd
      ? Math.round((cost - previous.costUsd) * 1e6) / 1e6
      : undefined;
  return {
    usage: costUsd !== undefined && costUsd > 0 ? { ...usage, costUsd } : usage,
    ledger,
  };
}
