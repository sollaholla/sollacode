import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveQueuedTurnPromotionOutcome } from "./queuedTurnPromotion.js";

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
