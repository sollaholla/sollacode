import { describe, expect, it } from "@effect/vitest";
import { MessageId } from "@t3tools/contracts";

import { queuedTurnMessageIds } from "./thread-queued-turn-promotion";

describe("mobile queued turn promotion", () => {
  it("promotes every undelivered user follow-up from the active Grok turn", () => {
    const result = queuedTurnMessageIds({
      activeWorkStartedAt: "2026-08-26T12:00:00.000Z",
      messages: [
        {
          id: MessageId.make("older"),
          role: "user",
          text: "old",
          turnId: null,
          createdAt: "2026-08-26T11:59:00.000Z",
        },
        {
          id: MessageId.make("queued-1"),
          role: "user",
          text: "first",
          turnId: null,
          createdAt: "2026-08-26T12:01:00.000Z",
        },
        {
          id: MessageId.make("queued-2"),
          role: "user",
          text: "second",
          turnId: null,
          createdAt: "2026-08-26T12:02:00.000Z",
        },
      ] as never,
      activities: [],
    });

    expect(result).toEqual([MessageId.make("queued-1"), MessageId.make("queued-2")]);
  });

  it("excludes follow-ups already delivered or included in an earlier promotion", () => {
    expect(
      queuedTurnMessageIds({
        activeWorkStartedAt: null,
        messages: [
          {
            id: MessageId.make("delivered"),
            role: "user",
            text: "first",
            turnId: null,
            createdAt: "2026-08-26T12:01:00.000Z",
          },
          {
            id: MessageId.make("promoted"),
            role: "user",
            text: "second",
            turnId: null,
            createdAt: "2026-08-26T12:02:00.000Z",
          },
        ] as never,
        activities: [
          { kind: "message.delivered", payload: { messageId: "delivered" } },
          { kind: "provider.queue.promoted", payload: { messageIds: ["promoted"] } },
        ] as never,
      }),
    ).toEqual([]);
  });
});
