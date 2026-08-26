import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  expandDeliveredMessageIds,
  deriveDeliveredMessageIds,
  derivePromotedQueuedMessageIds,
  messageDeliveryLabel,
  messageDeliveryState,
  shouldShowDeliveryIndicator,
  threadReportsDelivery,
} from "./messageDelivery";

function activity(kind: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id: `event-${kind}-${JSON.stringify(payload)}`,
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: null,
    createdAt: "2026-08-01T00:00:00.000Z",
  } as OrchestrationThreadActivity;
}

describe("deriveDeliveredMessageIds", () => {
  it("collects ids from delivery receipts", () => {
    const delivered = deriveDeliveredMessageIds([
      activity("message.delivered", { messageId: "m1" }),
      activity("message.delivered", { messageId: "m2" }),
    ]);
    expect([...delivered].toSorted()).toEqual(["m1", "m2"]);
  });

  it("ignores every other activity kind", () => {
    // The work log is dense with task/tool activity; only the receipt counts.
    const delivered = deriveDeliveredMessageIds([
      activity("task.started", { messageId: "m1" }),
      activity("tool.completed", { messageId: "m2" }),
    ]);
    expect(delivered.size).toBe(0);
  });

  it("skips receipts with a missing or unusable id", () => {
    const delivered = deriveDeliveredMessageIds([
      activity("message.delivered", {}),
      activity("message.delivered", { messageId: "" }),
      activity("message.delivered", { messageId: 42 }),
      activity("message.delivered", null),
    ]);
    expect(delivered.size).toBe(0);
  });

  it("is stable when the same message is reported twice", () => {
    const delivered = deriveDeliveredMessageIds([
      activity("message.delivered", { messageId: "m1" }),
      activity("message.delivered", { messageId: "m1" }),
    ]);
    expect(delivered.size).toBe(1);
  });
});

describe("derivePromotedQueuedMessageIds", () => {
  it("collects every exact message id from durable send-now receipts", () => {
    expect([
      ...derivePromotedQueuedMessageIds([
        activity("provider.queue.promoted", { messageIds: ["older", "newer"] }),
        activity("task.started", {}),
        activity("provider.queue.promoted", { messageIds: ["newest"] }),
      ]),
    ]).toEqual(["older", "newer", "newest"]);
  });

  it("ignores malformed queue promotion payloads", () => {
    expect(
      derivePromotedQueuedMessageIds([
        activity("provider.queue.promoted", {}),
        activity("provider.queue.promoted", { messageIds: [null, 42, ""] }),
      ]).size,
    ).toBe(0);
  });
});

describe("messageDeliveryState", () => {
  it("is pending while the row is only a local echo", () => {
    expect(messageDeliveryState({ isOptimistic: true, isDelivered: false })).toBe("pending");
  });

  it("is sent once persisted but before the provider takes it", () => {
    // This is the steering window the feature exists to make visible.
    expect(messageDeliveryState({ isOptimistic: false, isDelivered: false })).toBe("sent");
  });

  it("is read once the provider reports accepting it", () => {
    expect(messageDeliveryState({ isOptimistic: false, isDelivered: true })).toBe("read");
  });

  it("never claims read while still optimistic", () => {
    // A receipt cannot arrive before the server knows the message, so this
    // combination means confused inputs — pending is the safe reading.
    expect(messageDeliveryState({ isOptimistic: true, isDelivered: true })).toBe("pending");
  });
});

describe("threadReportsDelivery", () => {
  it("is false for providers that never send a receipt", () => {
    // Otherwise every message on those providers shows a permanent single
    // check, which reads as "nothing is getting through".
    expect(threadReportsDelivery(new Set())).toBe(false);
  });

  it("is true once any receipt has been seen", () => {
    expect(threadReportsDelivery(new Set(["m1"]))).toBe(true);
  });
});

describe("shouldShowDeliveryIndicator", () => {
  it("hides older messages that were never tracked", () => {
    // Everything predating the feature has no receipt. Rendering a single check
    // there would claim "sent but never read", which is worse than silence.
    expect(
      shouldShowDeliveryIndicator({
        isOptimistic: false,
        isDelivered: false,
        isNewestUserMessage: false,
        threadReportsDelivery: true,
      }),
    ).toBe(false);
  });

  it("shows the newest message while it could still be in flight", () => {
    expect(
      shouldShowDeliveryIndicator({
        isOptimistic: false,
        isDelivered: false,
        isNewestUserMessage: true,
        threadReportsDelivery: true,
      }),
    ).toBe(true);
  });

  it("shows the first queued message for providers with delivery receipts", () => {
    expect(
      shouldShowDeliveryIndicator({
        isOptimistic: false,
        isDelivered: false,
        isNewestUserMessage: true,
        providerReportsDelivery: true,
        threadReportsDelivery: false,
      }),
    ).toBe(true);
  });

  it("always shows a confirmed receipt, however old", () => {
    expect(
      shouldShowDeliveryIndicator({
        isOptimistic: false,
        isDelivered: true,
        isNewestUserMessage: false,
        threadReportsDelivery: false,
      }),
    ).toBe(true);
  });

  it("shows nothing at all against a server that never reports delivery", () => {
    // The remote-host case: the receipt is emitted by whichever server runs the
    // provider session, so an older server on the far end emits none. Without
    // this the newest message sits on a single check reading "waiting for the
    // CLI" forever, describing a stall that is not happening.
    expect(
      shouldShowDeliveryIndicator({
        isOptimistic: false,
        isDelivered: false,
        isNewestUserMessage: true,
        threadReportsDelivery: false,
      }),
    ).toBe(false);
  });

  it("shows a newest local echo even before provider receipts are available", () => {
    expect(
      shouldShowDeliveryIndicator({
        isOptimistic: true,
        isDelivered: false,
        isNewestUserMessage: true,
        threadReportsDelivery: false,
      }),
    ).toBe(true);
  });
});

describe("messageDeliveryLabel", () => {
  it("describes each state distinctly", () => {
    const labels = (["pending", "sent", "read"] as const).map((state) =>
      messageDeliveryLabel(state),
    );
    expect(new Set(labels).size).toBe(3);
    expect(messageDeliveryLabel("read")).toContain("CLI");
    expect(messageDeliveryLabel("sent", "Codex")).toBe("Queued for Codex");
    expect(messageDeliveryLabel("read", "Codex")).toBe("Received by Codex");
  });
});

describe("expandDeliveredMessageIds", () => {
  it("marks predecessors of a receipted message as delivered", () => {
    // The regression: the server coalesces messages sent while a turn is
    // running into one prompt tagged with only the newest id, so "m1" and "m2"
    // were delivered in that same prompt but never receipted, and sat on
    // "Queued for Claude" forever after the agent had answered them.
    const expanded = expandDeliveredMessageIds(["m1", "m2", "m3"], new Set(["m3"]));
    expect([...expanded].sort()).toEqual(["m1", "m2", "m3"]);
  });

  it("leaves messages sent after the newest receipt undelivered", () => {
    // "m3" is genuinely still in flight; claiming otherwise is the exact
    // dishonesty the indicator exists to avoid.
    const expanded = expandDeliveredMessageIds(["m1", "m2", "m3"], new Set(["m2"]));
    expect(expanded.has("m3")).toBe(false);
    expect(expanded.has("m1")).toBe(true);
  });

  it("returns the input untouched when nothing has been receipted", () => {
    const delivered = new Set<string>();
    expect(expandDeliveredMessageIds(["m1", "m2"], delivered)).toBe(delivered);
  });

  it("ignores receipts for ids that are not in the ordered list", () => {
    const delivered = new Set(["unknown"]);
    expect(expandDeliveredMessageIds(["m1", "m2"], delivered)).toBe(delivered);
  });

  it("is unchanged when every message is already receipted", () => {
    const expanded = expandDeliveredMessageIds(["m1", "m2"], new Set(["m1", "m2"]));
    expect([...expanded].sort()).toEqual(["m1", "m2"]);
  });
});
