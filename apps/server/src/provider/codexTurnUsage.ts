import type { ProviderTurnUsage } from "@t3tools/contracts";

/** A Codex thread's running token totals, in OpenAI's accounting. */
export interface CodexTokenTotals {
  /** Every prompt token, cached ones included. */
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteInputTokens?: number | undefined;
  /** Every completion token, reasoning included. */
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
}

const count = (value: number | undefined): number =>
  value !== undefined && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;

const minus = (after: CodexTokenTotals, before: CodexTokenTotals) => ({
  inputTokens: count(after.inputTokens) - count(before.inputTokens),
  cachedInputTokens: count(after.cachedInputTokens) - count(before.cachedInputTokens),
  cacheWriteInputTokens: count(after.cacheWriteInputTokens) - count(before.cacheWriteInputTokens),
  outputTokens: count(after.outputTokens) - count(before.outputTokens),
  reasoningOutputTokens: count(after.reasoningOutputTokens) - count(before.reasoningOutputTokens),
});

/**
 * Measures each Codex turn from its thread's running token totals.
 *
 * Every `thread/tokenUsage/updated` carries the thread's running `total` and
 * the request that just finished (`last`), tagged with its turn. The total
 * before a turn's first request is therefore `total - last` on that turn's
 * first notification, which measures a turn exactly even when it is the
 * first this process sees on a resumed thread whose total includes
 * everything before it.
 *
 * One tracker per provider session; turns are keyed by Codex thread and turn
 * so sub-agent threads never mix with their parent.
 */
export function makeCodexTurnUsageTracker() {
  const turns = new Map<string, { readonly before: CodexTokenTotals; latest: CodexTokenTotals }>();
  const key = (threadId: string, turnId: string) => `${threadId}\u0000${turnId}`;

  return {
    observe(input: {
      readonly threadId: string;
      readonly turnId: string;
      readonly total: CodexTokenTotals;
      readonly last: CodexTokenTotals;
    }): void {
      const entry = turns.get(key(input.threadId, input.turnId));
      if (entry !== undefined) {
        entry.latest = input.total;
        return;
      }
      const before = minus(input.total, input.last);
      turns.set(key(input.threadId, input.turnId), {
        before: {
          inputTokens: Math.max(0, before.inputTokens),
          cachedInputTokens: Math.max(0, before.cachedInputTokens),
          cacheWriteInputTokens: Math.max(0, before.cacheWriteInputTokens),
          outputTokens: Math.max(0, before.outputTokens),
          reasoningOutputTokens: Math.max(0, before.reasoningOutputTokens),
        },
        latest: input.total,
      });
    },

    /**
     * The usage of a turn that just ended, in the disjoint form the thread
     * summary sums; undefined when the turn reported nothing or its counters
     * went backwards.
     */
    complete(input: {
      readonly threadId: string;
      readonly turnId: string;
    }): ProviderTurnUsage | undefined {
      const entry = turns.get(key(input.threadId, input.turnId));
      turns.delete(key(input.threadId, input.turnId));
      if (entry === undefined) return undefined;
      const delta = minus(entry.latest, entry.before);
      if (Object.values(delta).some((value) => value < 0)) return undefined;
      const usage: ProviderTurnUsage = {
        // Cached reads and cache writes are part of OpenAI's prompt count.
        inputTokens: Math.max(
          0,
          delta.inputTokens - delta.cachedInputTokens - delta.cacheWriteInputTokens,
        ),
        cachedInputTokens: delta.cachedInputTokens,
        cacheWriteTokens: delta.cacheWriteInputTokens,
        outputTokens: delta.outputTokens,
        ...(delta.reasoningOutputTokens > 0
          ? { reasoningTokens: delta.reasoningOutputTokens }
          : {}),
      };
      const total =
        usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteTokens + usage.outputTokens;
      return total > 0 ? usage : undefined;
    },
  };
}
