import { beforeEach, describe, expect, it } from "@effect/vitest";
import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";

import { scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";
import {
  clearQueuedTurnPromotionRequest,
  markQueuedTurnPromotionAwaitingProjection,
  orderedQueuedTurnPromotionMessageIds,
  queuedTurnMessageIds,
  queuedTurnPromotionOutcome,
  queuedTurnPromotionRequestsAtom,
  requestQueuedTurnPromotion,
} from "./thread-queued-turn-promotion";

beforeEach(() => {
  appAtomRegistry.set(queuedTurnPromotionRequestsAtom, {});
});

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

  it("orders and deduplicates mixed local and server queues by creation time", () => {
    expect(
      orderedQueuedTurnPromotionMessageIds({
        serverQueuedMessageIds: [MessageId.make("server-older"), MessageId.make("projected-local")],
        serverMessages: [
          {
            id: MessageId.make("server-older"),
            role: "user",
            text: "already queued first",
            turnId: null,
            createdAt: "2026-08-26T12:01:00.000Z",
          },
          {
            id: MessageId.make("projected-local"),
            role: "user",
            text: "visible in both stores",
            turnId: null,
            createdAt: "2026-08-26T12:02:00.000Z",
          },
        ] as never,
        localMessages: [
          {
            messageId: MessageId.make("local-newer"),
            createdAt: "2026-08-26T12:03:00.000Z",
          },
          {
            messageId: MessageId.make("projected-local"),
            createdAt: "2026-08-26T12:02:00.000Z",
          },
        ],
      }),
    ).toEqual([
      MessageId.make("server-older"),
      MessageId.make("projected-local"),
      MessageId.make("local-newer"),
    ]);
  });

  it("keeps one request locked until its queue projection settles", () => {
    const request = {
      commandId: CommandId.make("promotion-1"),
      environmentId: EnvironmentId.make("environment-1"),
      messageIds: [MessageId.make("message-1")],
      serverProjectionRequiredMessageIds: [],
      threadId: ThreadId.make("thread-1"),
    };
    const threadKey = scopedThreadKey(request.environmentId, request.threadId);

    requestQueuedTurnPromotion(request);
    requestQueuedTurnPromotion(request);
    expect(appAtomRegistry.get(queuedTurnPromotionRequestsAtom)[threadKey]?.phase).toBe(
      "requested",
    );

    markQueuedTurnPromotionAwaitingProjection(request);
    requestQueuedTurnPromotion(request);
    expect(appAtomRegistry.get(queuedTurnPromotionRequestsAtom)[threadKey]?.phase).toBe(
      "awaiting-projection",
    );

    clearQueuedTurnPromotionRequest(request);
    expect(appAtomRegistry.get(queuedTurnPromotionRequestsAtom)).toEqual({});
  });

  it("tracks independent thread promotions separately", () => {
    const first = {
      commandId: CommandId.make("promotion-1"),
      environmentId: EnvironmentId.make("environment-1"),
      messageIds: [MessageId.make("message-1")],
      serverProjectionRequiredMessageIds: [],
      threadId: ThreadId.make("thread-1"),
    };
    const second = {
      commandId: CommandId.make("promotion-2"),
      environmentId: EnvironmentId.make("environment-1"),
      messageIds: [MessageId.make("message-2")],
      serverProjectionRequiredMessageIds: [],
      threadId: ThreadId.make("thread-2"),
    };

    requestQueuedTurnPromotion(first);
    requestQueuedTurnPromotion(second);
    markQueuedTurnPromotionAwaitingProjection(first);

    expect(appAtomRegistry.get(queuedTurnPromotionRequestsAtom)).toMatchObject({
      [scopedThreadKey(first.environmentId, first.threadId)]: {
        phase: "awaiting-projection",
      },
      [scopedThreadKey(second.environmentId, second.threadId)]: { phase: "requested" },
    });
  });

  it("settles the accepted batch even when a newer queued message is already visible", () => {
    expect(
      queuedTurnPromotionOutcome({
        state: {
          commandId: CommandId.make("promotion-1"),
          environmentId: EnvironmentId.make("environment-1"),
          threadId: ThreadId.make("thread-1"),
          messageIds: [MessageId.make("promoted-1"), MessageId.make("promoted-2")],
          serverProjectionRequiredMessageIds: [
            MessageId.make("promoted-1"),
            MessageId.make("promoted-2"),
          ],
          phase: "awaiting-projection",
        },
        projectedMessageIds: [MessageId.make("promoted-1"), MessageId.make("promoted-2")],
        activities: [
          {
            kind: "provider.queue.promoted",
            payload: {
              requestId: "promotion-1",
              messageIds: ["promoted-1", "promoted-2"],
            },
          },
        ] as never,
      }),
    ).toEqual({ status: "succeeded", messageIds: ["promoted-1", "promoted-2"] });
  });

  it("ignores a terminal projection for another promotion request", () => {
    expect(
      queuedTurnPromotionOutcome({
        state: {
          commandId: CommandId.make("promotion-1"),
          environmentId: EnvironmentId.make("environment-1"),
          threadId: ThreadId.make("thread-1"),
          messageIds: [MessageId.make("promoted-1"), MessageId.make("promoted-2")],
          serverProjectionRequiredMessageIds: [],
          phase: "awaiting-projection",
        },
        projectedMessageIds: [],
        activities: [
          {
            kind: "provider.queue.promote.failed",
            payload: { requestId: "promotion-2", detail: "other request failed" },
          },
        ] as never,
      }),
    ).toBeNull();
  });

  it("surfaces the correlated provider failure so the batch can retry", () => {
    expect(
      queuedTurnPromotionOutcome({
        state: {
          commandId: CommandId.make("promotion-1"),
          environmentId: EnvironmentId.make("environment-1"),
          threadId: ThreadId.make("thread-1"),
          messageIds: [MessageId.make("promoted-1")],
          serverProjectionRequiredMessageIds: [],
          phase: "awaiting-projection",
        },
        projectedMessageIds: [],
        activities: [
          {
            kind: "provider.queue.promote.failed",
            payload: { requestId: "promotion-1", detail: "session stopped" },
          },
        ] as never,
      }),
    ).toEqual({ status: "failed", detail: "session stopped" });
  });

  it("does not settle a local batch before those messages reach the server projection", () => {
    const state = {
      commandId: CommandId.make("promotion-1"),
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
      messageIds: [MessageId.make("local-message")],
      serverProjectionRequiredMessageIds: [MessageId.make("local-message")],
      phase: "awaiting-projection" as const,
    };

    expect(
      queuedTurnPromotionOutcome({
        state,
        projectedMessageIds: [],
        activities: [
          {
            kind: "provider.queue.promoted",
            payload: { requestId: "promotion-1", messageIds: ["local-message"] },
          },
        ] as never,
      }),
    ).toBeNull();
    expect(
      queuedTurnPromotionOutcome({
        state,
        projectedMessageIds: [MessageId.make("local-message")],
        activities: [
          {
            kind: "provider.queue.promoted",
            payload: { requestId: "promotion-1", messageIds: ["local-message"] },
          },
        ] as never,
      }),
    ).toEqual({ status: "succeeded", messageIds: ["local-message"] });
  });
});
