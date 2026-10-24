import { EventId, RuntimeItemId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import { scanProposedPlanBlocks } from "@t3tools/shared/proposedPlans";

export interface CompletedProposedPlanBlock {
  readonly itemId: RuntimeItemId;
  readonly planMarkdown: string;
}

/**
 * One turn's `<proposed_plan>` blocks, each reported once, as it completes.
 *
 * For providers whose plans arrive as assistant text (Grok, Muse, Deep Code,
 * OpenCode, Antigravity): feed every assistant text delta of the turn and emit
 * `turn.proposed.completed` for what comes back. Each block is named by its
 * position in the turn, so a second block becomes a second plan instead of
 * replacing the first. Make a new tracker for every turn.
 */
export function makeProposedPlanBlockTracker() {
  let unread = "";
  let reported = 0;
  return {
    append(delta: string): ReadonlyArray<CompletedProposedPlanBlock> {
      unread += delta;
      // A block completes on its closing tag's ">"; nothing else can finish one.
      if (!delta.includes(">")) return [];
      const { plans, end } = scanProposedPlanBlocks(unread);
      if (end === 0) return [];
      unread = unread.slice(end);
      return plans.map((planMarkdown) => ({
        itemId: RuntimeItemId.make(`proposed-plan-${reported++}`),
        planMarkdown,
      }));
    },
  };
}

/**
 * Plan capture for an adapter that already emits its assistant text as
 * `content.delta` events: pass every event it emits through this, and emit
 * what comes back right after that event. Keeps one tracker per turn and drops
 * it when the turn completes or aborts.
 */
export function makeProposedPlanCapture() {
  const trackers = new Map<string, ReturnType<typeof makeProposedPlanBlockTracker>>();
  return (event: ProviderRuntimeEvent): ReadonlyArray<ProviderRuntimeEvent> => {
    if (event.turnId === undefined) return [];
    const key = `${event.threadId}:${event.turnId}`;
    if (event.type === "turn.completed" || event.type === "turn.aborted") {
      trackers.delete(key);
      return [];
    }
    if (event.type !== "content.delta" || event.payload.streamKind !== "assistant_text") return [];
    let tracker = trackers.get(key);
    if (tracker === undefined) {
      tracker = makeProposedPlanBlockTracker();
      trackers.set(key, tracker);
    }
    return tracker.append(event.payload.delta).map((block) => ({
      type: "turn.proposed.completed" as const,
      eventId: EventId.make(`${event.eventId}:${block.itemId}`),
      provider: event.provider,
      ...(event.providerInstanceId !== undefined
        ? { providerInstanceId: event.providerInstanceId }
        : {}),
      ...(event.historicalReplay ? { historicalReplay: true as const } : {}),
      threadId: event.threadId,
      createdAt: event.createdAt,
      turnId: event.turnId,
      itemId: block.itemId,
      payload: { planMarkdown: block.planMarkdown },
    }));
  };
}
