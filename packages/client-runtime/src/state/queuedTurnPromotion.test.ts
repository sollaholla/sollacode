import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectDeliveredMessageIds,
  nextQueuedMessageToPromote,
  QUEUED_MESSAGE_AUTO_PROMOTE_DELAY_MS,
  queuedMessageAutoPromoteDelayMs,
  resolveQueuedTurnPromotionOutcome,
} from "./queuedTurnPromotion.js";

function activity(kind: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id: `event-${kind}`,
    tone: kind.endsWith("failed") ? "error" : "info",
    kind,
    summary: kind,
    payload,
    turnId: null,
    createdAt: "2026-08-27T00:00:00.000Z",
  } as OrchestrationThreadActivity;
}

describe("resolveQueuedTurnPromotionOutcome", () => {
  it("resolves only the exact correlated success", () => {
    expect(
      resolveQueuedTurnPromotionOutcome({
        requestId: "request-b",
        expectedMessageIds: ["message-b"],
        activities: [
          activity("provider.queue.promoted", {
            requestId: "request-a",
            messageIds: ["message-a"],
          }),
          activity("provider.queue.promoted", {
            requestId: "request-b",
            messageIds: ["message-b"],
          }),
        ],
      }),
    ).toEqual({ status: "succeeded", messageIds: ["message-b"] });
  });

  it("returns a retryable client failure for a correlated provider rejection", () => {
    expect(
      resolveQueuedTurnPromotionOutcome({
        requestId: "request-a",
        expectedMessageIds: ["message-a"],
        activities: [
          activity("provider.queue.promote.failed", {
            requestId: "request-a",
            detail: "The Grok session is no longer running.",
          }),
        ],
      }),
    ).toEqual({ status: "failed", detail: "The Grok session is no longer running." });
  });

  it("fails closed when a correlated success covers only part of the requested batch", () => {
    expect(
      resolveQueuedTurnPromotionOutcome({
        requestId: "request-a",
        expectedMessageIds: ["message-a", "message-b"],
        activities: [
          activity("provider.queue.promoted", {
            requestId: "request-a",
            messageIds: ["message-a"],
          }),
        ],
      }),
    ).toEqual({
      status: "failed",
      detail: "Grok confirmed only part of the queued message batch. Try sending it again.",
    });
  });
});

describe("nextQueuedMessageToPromote", () => {
  it("holds the next row until the previous read receipt lands", () => {
    expect(
      nextQueuedMessageToPromote({
        queuedMessageIds: ["message-a", "message-b"],
        deliveredMessageIds: new Set(),
        promotionInFlight: false,
        awaitingDeliveryMessageIds: [],
      }),
    ).toBe("message-a");
    expect(
      nextQueuedMessageToPromote({
        queuedMessageIds: ["message-a", "message-b"],
        deliveredMessageIds: new Set(),
        promotionInFlight: true,
        awaitingDeliveryMessageIds: ["message-a"],
      }),
    ).toBeNull();
    expect(
      nextQueuedMessageToPromote({
        queuedMessageIds: ["message-b"],
        deliveredMessageIds: new Set(),
        promotionInFlight: false,
        awaitingDeliveryMessageIds: ["message-a"],
      }),
    ).toBeNull();
    expect(
      nextQueuedMessageToPromote({
        queuedMessageIds: ["message-b"],
        deliveredMessageIds: new Set(["message-a"]),
        promotionInFlight: false,
        awaitingDeliveryMessageIds: ["message-a"],
      }),
    ).toBe("message-b");
  });

  it("debounces the first drain and sends later rows immediately", () => {
    expect(queuedMessageAutoPromoteDelayMs(false)).toBe(QUEUED_MESSAGE_AUTO_PROMOTE_DELAY_MS);
    expect(queuedMessageAutoPromoteDelayMs(true)).toBe(0);
    expect(QUEUED_MESSAGE_AUTO_PROMOTE_DELAY_MS).toBe(1_000);
  });

  it("collects exact message.delivered receipts", () => {
    expect(
      collectDeliveredMessageIds([
        activity("message.delivered", { messageId: "message-a" }),
        activity("provider.queue.promoted", { messageIds: ["message-b"] }),
        activity("message.delivered", { messageId: "" }),
      ]),
    ).toEqual(new Set(["message-a"]));
  });
});
