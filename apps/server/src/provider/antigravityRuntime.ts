import {
  ProviderDriverKind,
  RuntimeItemId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeEventBase,
  type ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";
import type { AntigravityEvent, AntigravityUsage } from "./antigravityProtocol.ts";

export const ANTIGRAVITY_DRIVER_KIND = ProviderDriverKind.make("antigravity");

/**
 * Context windows `agy` never reports, keyed by model-slug prefix.
 *
 * The stream carries per-call token counts but nothing about the window
 * those counts sit in, so without this the meter can only show a raw token
 * total with no percentage. Slugs embed an effort suffix
 * (`gemini-3.8-flash-low`), so match on the family prefix rather than the
 * whole slug. An unknown family yields no `maxTokens`, and the meter falls
 * back to counting tokens rather than guessing a limit.
 */
const ANTIGRAVITY_CONTEXT_WINDOWS: ReadonlyArray<readonly [prefix: string, tokens: number]> = [
  ["gemini-", 1_048_576],
  ["claude-", 200_000],
  ["gpt-oss-120b", 131_072],
];

export function antigravityContextWindowTokens(
  model: string | null | undefined,
): number | undefined {
  const slug = model?.trim().toLowerCase();
  if (!slug) return undefined;
  return ANTIGRAVITY_CONTEXT_WINDOWS.find(([prefix]) => slug.startsWith(prefix))?.[1];
}

/** Running token totals for one native conversation, carried across turns. */
export interface AntigravityUsageTally {
  /** Sum of every completed turn's `result.usage.total_tokens`. */
  readonly settledTokens: number;
  /** Sum of the step totals seen so far in the turn in flight. */
  readonly turnTokens: number;
  /** The most recent model call, whose prompt size is the live context. */
  readonly lastStep: AntigravityUsage | null;
}

export const EMPTY_ANTIGRAVITY_USAGE_TALLY: AntigravityUsageTally = {
  settledTokens: 0,
  turnTokens: 0,
  lastStep: null,
};

function usageTotal(usage: AntigravityUsage): number {
  const explicit = Math.round(usage.totalTokens);
  if (explicit > 0) return explicit;
  return Math.round(
    usage.inputTokens + usage.cacheReadTokens + usage.outputTokens + usage.thinkingTokens,
  );
}

function nonNegative(value: number): number {
  return Math.max(0, Math.round(value));
}

/**
 * Fold one usage-bearing frame into the tally and derive the meter snapshot.
 *
 * A `step_update` usage describes the model call that produced that step, so
 * its total is the size of the live context: prompt (fresh plus cache hits)
 * and completion. The `result` usage is the turn's aggregate — summing it on
 * top of the steps would double count, so it only settles the running total
 * and re-reports the last step's context. Frames with no tokens produce no
 * snapshot: the meter treats zero as "unknown", not "empty".
 */
export function foldAntigravityUsage(input: {
  readonly tally: AntigravityUsageTally;
  readonly kind: "step_update" | "result";
  readonly usage: AntigravityUsage;
  readonly model: string | null | undefined;
}): { readonly tally: AntigravityUsageTally; readonly snapshot: ThreadTokenUsageSnapshot | null } {
  const total = usageTotal(input.usage);
  const maxTokens = antigravityContextWindowTokens(input.model);
  const tally: AntigravityUsageTally =
    input.kind === "step_update"
      ? {
          settledTokens: input.tally.settledTokens,
          turnTokens: input.tally.turnTokens + total,
          lastStep: total > 0 ? input.usage : input.tally.lastStep,
        }
      : {
          settledTokens: input.tally.settledTokens + Math.max(total, input.tally.turnTokens),
          turnTokens: 0,
          lastStep: input.tally.lastStep ?? (total > 0 ? input.usage : null),
        };
  const context = tally.lastStep;
  if (context === null) return { tally, snapshot: null };
  const usedTokens = usageTotal(context);
  if (usedTokens <= 0) return { tally, snapshot: null };
  const totalProcessedTokens = tally.settledTokens + tally.turnTokens;
  const inputTokens = nonNegative(context.inputTokens);
  const cachedInputTokens = nonNegative(context.cacheReadTokens);
  const outputTokens = nonNegative(context.outputTokens);
  const reasoningOutputTokens = nonNegative(context.thinkingTokens);
  return {
    tally,
    snapshot: {
      usedTokens,
      ...(totalProcessedTokens > usedTokens ? { totalProcessedTokens } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens,
      lastUsedTokens: usedTokens,
      lastInputTokens: inputTokens,
      lastCachedInputTokens: cachedInputTokens,
      lastOutputTokens: outputTokens,
      lastReasoningOutputTokens: reasoningOutputTokens,
    },
  };
}

/** Map a native frame without replaying result.response over streamed text. */
export function mapAntigravityEvent(
  event: AntigravityEvent,
  base: ProviderRuntimeEventBase,
): ReadonlyArray<ProviderRuntimeEvent> {
  switch (event.kind) {
    case "init":
      return [
        {
          ...base,
          type: "session.started",
          payload: {
            ...(event.conversationId ? { resume: { conversationId: event.conversationId } } : {}),
            message: "Antigravity session started.",
          },
        },
      ];
    case "step_update": {
      const itemId = RuntimeItemId.make(`${base.turnId}:step:${event.stepIndex ?? "unknown"}`);
      if (event.stepType === "agent_response") {
        const events: ProviderRuntimeEvent[] = [];
        if (event.textDelta)
          events.push({
            ...base,
            itemId,
            type: "content.delta",
            payload: {
              streamKind: "assistant_text",
              delta: event.textDelta,
            },
          });
        if (event.state === "DONE")
          events.push({
            ...base,
            itemId,
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              status: "completed",
            },
          });
        return events;
      }
      if (event.stepType !== "tool") return [];
      const info = event.toolInfo;
      const detail =
        info?.errorMessage ?? (typeof info?.output === "string" ? info.output : undefined);
      return [
        {
          ...base,
          itemId,
          type: event.state === "DONE" ? "item.completed" : "item.updated",
          payload: {
            itemType: "dynamic_tool_call",
            status:
              info?.errorMessage || info?.errorType
                ? "failed"
                : event.state === "DONE"
                  ? "completed"
                  : "inProgress",
            title: info?.name ?? event.toolName ?? "Tool call",
            ...(detail?.trim() ? { detail: detail.slice(0, 16_384) } : {}),
            data: {
              name: info?.name ?? event.toolName,
              arguments: info?.parameters,
              output: typeof info?.output === "string" ? info.output.slice(0, 16_384) : undefined,
              subagents: event.subagents,
            },
          },
        },
      ];
    }
    case "result":
      if (event.status === "WAITING" || event.status === "RUNNING") return [];
      return [
        {
          ...base,
          type: "turn.completed",
          payload: {
            state:
              event.status === "SUCCESS"
                ? "completed"
                : event.status === "CANCELED" || event.status === "INTERRUPTED"
                  ? "interrupted"
                  : "failed",
            ...(event.error?.trim() ? { errorMessage: event.error } : {}),
            ...(event.usage ? { usage: event.usage } : {}),
          },
        },
      ];
    case "unknown":
    case "malformed":
      return [];
  }
}
