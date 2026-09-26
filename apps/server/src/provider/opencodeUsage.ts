import { NonNegativeInt, type ThreadTokenUsageSnapshot } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

const Tokens = Schema.Struct({
  input: NonNegativeInt,
  output: NonNegativeInt,
  reasoning: NonNegativeInt,
  cache: Schema.Struct({ read: NonNegativeInt, write: NonNegativeInt }),
  total: Schema.optional(NonNegativeInt),
});

const decodeTokens = Schema.decodeUnknownOption(Tokens);

const decodeSessionUsage = Schema.decodeUnknownOption(
  Schema.Struct({
    id: Schema.String.check(Schema.isMinLength(1)),
    cost: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
    time: Schema.Struct({ updated: NonNegativeInt }),
  }),
);

/** Native cumulative cost survives resume and compaction; missing cost is not zero. */
export function openCodeSessionUsage(raw: unknown) {
  const decoded = decodeSessionUsage(raw);
  if (Option.isNone(decoded)) return undefined;
  return {
    source: "opencode-session" as const,
    sessionId: decoded.value.id,
    sessionCost: decoded.value.cost,
    updatedAt: decoded.value.time.updated,
  };
}

/** OpenCode's Session.getUsage separates cache input and subtracts reasoning from visible output. */
export function openCodeTokenUsage(raw: unknown): ThreadTokenUsageSnapshot | undefined {
  const decoded = decodeTokens(raw);
  if (Option.isNone(decoded)) return undefined;
  const tokens = decoded.value;
  const inputTokens = tokens.input + tokens.cache.read + tokens.cache.write;
  const outputTokens = tokens.output + tokens.reasoning;
  const usedTokens = tokens.total && tokens.total > 0 ? tokens.total : inputTokens + outputTokens;
  if (!Number.isSafeInteger(usedTokens) || usedTokens === 0 || !Number.isSafeInteger(inputTokens))
    return undefined;
  return {
    usedTokens,
    inputTokens,
    cachedInputTokens: tokens.cache.read,
    outputTokens,
    reasoningOutputTokens: tokens.reasoning,
    lastUsedTokens: usedTokens,
    lastInputTokens: inputTokens,
    lastCachedInputTokens: tokens.cache.read,
    lastOutputTokens: outputTokens,
    lastReasoningOutputTokens: tokens.reasoning,
    compactsAutomatically: true,
  };
}
