import type { OrchestrationThreadActivity } from "@t3tools/contracts";

export const QUEUED_TURN_PROMOTION_SUCCEEDED_ACTIVITY_KIND = "provider.queue.promoted";
export const QUEUED_TURN_PROMOTION_FAILED_ACTIVITY_KIND = "provider.queue.promote.failed";

export type QueuedTurnPromotionOutcome =
  | {
      readonly status: "succeeded";
      readonly messageIds: ReadonlyArray<string>;
    }
  | {
      readonly status: "failed";
      readonly detail: string;
    };

function payloadRecord(payload: unknown): Readonly<Record<string, unknown>> | null {
  return typeof payload === "object" && payload !== null
    ? (payload as Readonly<Record<string, unknown>>)
    : null;
}

/**
 * Finds the durable terminal activity for one exact queued-turn promotion.
 *
 * Persisting the client command is only admission; the provider work happens
 * later in the reactor. The command id therefore stays with the client lock
 * until a correlated success or failure reaches projection.
 */
export function resolveQueuedTurnPromotionOutcome(input: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly expectedMessageIds: ReadonlyArray<string>;
  readonly requestId: string;
}): QueuedTurnPromotionOutcome | null {
  for (let index = input.activities.length - 1; index >= 0; index -= 1) {
    const activity = input.activities[index];
    if (
      activity === undefined ||
      (activity.kind !== QUEUED_TURN_PROMOTION_SUCCEEDED_ACTIVITY_KIND &&
        activity.kind !== QUEUED_TURN_PROMOTION_FAILED_ACTIVITY_KIND)
    ) {
      continue;
    }
    const payload = payloadRecord(activity.payload);
    if (payload?.requestId !== input.requestId) continue;

    if (activity.kind === QUEUED_TURN_PROMOTION_FAILED_ACTIVITY_KIND) {
      return {
        status: "failed",
        detail:
          typeof payload.detail === "string" && payload.detail.trim().length > 0
            ? payload.detail
            : "Queued messages could not be sent immediately.",
      };
    }

    const messageIds = Array.isArray(payload.messageIds)
      ? payload.messageIds.filter(
          (messageId): messageId is string => typeof messageId === "string" && messageId.length > 0,
        )
      : [];
    const promoted = new Set(messageIds);
    if (input.expectedMessageIds.some((messageId) => !promoted.has(messageId))) {
      return {
        status: "failed",
        detail: "Grok confirmed only part of the queued message batch. Try sending it again.",
      };
    }
    return { status: "succeeded", messageIds };
  }
  return null;
}

/** Idle debounce before the client starts draining Grok's native follow-up queue. */
export const QUEUED_MESSAGE_AUTO_PROMOTE_DELAY_MS = 1_000;

export function queuedMessageAutoPromoteDelayMs(drainActive: boolean): number {
  return drainActive ? 0 : QUEUED_MESSAGE_AUTO_PROMOTE_DELAY_MS;
}

export function collectDeliveredMessageIds(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlySet<string> {
  const delivered = new Set<string>();
  for (const activity of activities) {
    if (activity.kind !== "message.delivered") continue;
    const payload = payloadRecord(activity.payload);
    const messageId = payload?.messageId;
    if (typeof messageId === "string" && messageId.length > 0) delivered.add(messageId);
  }
  return delivered;
}

/**
 * Next Grok follow-up to interject. Returns null while a promote is in flight
 * or the previous row still lacks its `message.delivered` read receipt —
 * sending the whole queued batch at once stalls Grok.
 */
export function nextQueuedMessageToPromote(input: {
  readonly queuedMessageIds: ReadonlyArray<string>;
  readonly deliveredMessageIds: ReadonlySet<string>;
  readonly promotionInFlight: boolean;
  readonly awaitingDeliveryMessageIds: ReadonlyArray<string>;
}): string | null {
  if (input.promotionInFlight) return null;
  for (const messageId of input.awaitingDeliveryMessageIds) {
    if (!input.deliveredMessageIds.has(messageId)) return null;
  }
  const awaiting = new Set(input.awaitingDeliveryMessageIds);
  for (const messageId of input.queuedMessageIds) {
    if (awaiting.has(messageId) || input.deliveredMessageIds.has(messageId)) continue;
    return messageId;
  }
  return null;
}
