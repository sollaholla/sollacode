import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  expireStaleQueuedMessagePromotion,
  QUEUED_MESSAGE_PROMOTION_STALE_MS,
  runQueuedMessagePromotion,
  settleQueuedMessagePromotion,
  type QueuedMessagePromotionPhases,
} from "../ChatView.logic";

function promotionActivity(input: {
  readonly kind?: "provider.queue.promoted" | "provider.queue.promote.failed";
  readonly requestId: string;
  readonly messageIds?: ReadonlyArray<string>;
  readonly detail?: string;
}): OrchestrationThreadActivity {
  const kind = input.kind ?? "provider.queue.promoted";
  return {
    id: `event-${input.requestId}`,
    tone: kind.endsWith("failed") ? "error" : "info",
    kind,
    summary: kind,
    payload: {
      requestId: input.requestId,
      ...(input.messageIds ? { messageIds: input.messageIds } : {}),
      ...(input.detail ? { detail: input.detail } : {}),
    },
    turnId: null,
    createdAt: "2026-08-27T00:00:00.000Z",
  } as OrchestrationThreadActivity;
}

describe("queued-message promotion lifecycle", () => {
  it("admits one promotion while the command is in flight", async () => {
    let releasePromotion: (() => void) | undefined;
    const promote = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          releasePromotion = () => resolve(true);
        }),
    );
    const setPhases = vi.fn();
    const onStart = vi.fn();
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const phasesRef: { current: QueuedMessagePromotionPhases } = { current: {} };

    const first = runQueuedMessagePromotion({
      phasesRef,
      setPhases,
      threadKey: "thread-a",
      messageIds: ["message-a"],
      requestId: "request-a",
      promote,
      onStart,
      onSuccess,
      onError,
    });
    const duplicate = await runQueuedMessagePromotion({
      phasesRef,
      setPhases,
      threadKey: "thread-a",
      messageIds: ["message-a"],
      requestId: "request-a",
      promote,
      onStart,
      onSuccess,
      onError,
    });

    expect(duplicate).toBe(false);
    expect(promote).toHaveBeenCalledTimes(1);
    expect(setPhases).toHaveBeenCalledTimes(1);
    expect(setPhases).toHaveBeenCalledWith({
      "thread-a": expect.objectContaining({
        phase: "requesting",
        messageIds: ["message-a"],
        requestId: "request-a",
      }),
    });
    expect(
      settleQueuedMessagePromotion({
        phasesRef,
        setPhases,
        threadKey: "thread-a",
        activities: [promotionActivity({ requestId: "request-a", messageIds: ["message-a"] })],
      }),
    ).toBeNull();
    expect(phasesRef.current).toEqual({
      "thread-a": expect.objectContaining({
        phase: "requesting",
        messageIds: ["message-a"],
        requestId: "request-a",
      }),
    });

    releasePromotion?.();
    await expect(first).resolves.toBe(true);
    expect(setPhases.mock.calls).toEqual([
      [
        {
          "thread-a": expect.objectContaining({
            phase: "requesting",
            messageIds: ["message-a"],
            requestId: "request-a",
          }),
        },
      ],
      [
        {
          "thread-a": expect.objectContaining({
            phase: "awaiting-projection",
            messageIds: ["message-a"],
            requestId: "request-a",
          }),
        },
      ],
    ]);
    expect(phasesRef.current).toEqual({
      "thread-a": expect.objectContaining({
        phase: "awaiting-projection",
        messageIds: ["message-a"],
        requestId: "request-a",
      }),
    });
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps the promotion single-flight until the correlated terminal projection", async () => {
    const promote = vi.fn().mockResolvedValue(true);
    const setPhases = vi.fn();
    const onStart = vi.fn();
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const phasesRef: { current: QueuedMessagePromotionPhases } = { current: {} };
    const input = {
      phasesRef,
      setPhases,
      threadKey: "thread-a",
      messageIds: ["message-a"],
      requestId: "request-a",
      promote,
      onStart,
      onSuccess,
      onError,
    };

    await expect(runQueuedMessagePromotion(input)).resolves.toBe(true);
    expect(phasesRef.current).toEqual({
      "thread-a": expect.objectContaining({
        phase: "awaiting-projection",
        messageIds: ["message-a"],
        requestId: "request-a",
      }),
    });

    await expect(runQueuedMessagePromotion(input)).resolves.toBe(false);
    expect(promote).toHaveBeenCalledTimes(1);

    expect(
      settleQueuedMessagePromotion({
        phasesRef,
        setPhases,
        threadKey: "thread-a",
        activities: [promotionActivity({ requestId: "request-a", messageIds: ["message-a"] })],
      }),
    ).toEqual({ status: "succeeded", messageIds: ["message-a"] });
    expect(phasesRef.current).toEqual({});
    await expect(runQueuedMessagePromotion(input)).resolves.toBe(true);
    expect(promote).toHaveBeenCalledTimes(2);
  });

  it("clears a failed attempt's stale error at retry start and successful acceptance", async () => {
    const error = new Error("promotion failed");
    const promote = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(true);
    const setPhases = vi.fn();
    const setError = vi.fn<(error: Error | null) => void>();
    const phasesRef: { current: QueuedMessagePromotionPhases } = { current: {} };
    const input = {
      phasesRef,
      setPhases,
      threadKey: "thread-a",
      messageIds: ["message-a"],
      requestId: "request-a",
      promote,
      onStart: () => setError(null),
      onSuccess: () => setError(null),
      onError: (caught: unknown) => setError(caught as Error),
    };

    await expect(runQueuedMessagePromotion(input)).resolves.toBe(true);
    expect(setError.mock.calls).toEqual([[null], [error]]);
    expect(phasesRef.current).toEqual({});

    await expect(runQueuedMessagePromotion(input)).resolves.toBe(true);
    expect(promote).toHaveBeenCalledTimes(2);
    expect(setError.mock.calls).toEqual([[null], [error], [null], [null]]);
    expect(phasesRef.current).toEqual({
      "thread-a": expect.objectContaining({
        phase: "awaiting-projection",
        messageIds: ["message-a"],
        requestId: "request-a",
      }),
    });
  });

  it("tracks independent threads without letting one RPC unlock another", async () => {
    const phasesRef: { current: QueuedMessagePromotionPhases } = { current: {} };
    const setPhases = vi.fn();
    const callbacks = {
      phasesRef,
      setPhases,
      promote: vi.fn().mockResolvedValue(true),
      onStart: vi.fn(),
      onSuccess: vi.fn(),
      onError: vi.fn(),
    };

    await runQueuedMessagePromotion({
      ...callbacks,
      threadKey: "thread-a",
      messageIds: ["message-a"],
      requestId: "request-a",
    });
    await runQueuedMessagePromotion({
      ...callbacks,
      threadKey: "thread-b",
      messageIds: ["message-b"],
      requestId: "request-b",
    });

    expect(phasesRef.current).toEqual({
      "thread-a": expect.objectContaining({
        phase: "awaiting-projection",
        messageIds: ["message-a"],
        requestId: "request-a",
      }),
      "thread-b": expect.objectContaining({
        phase: "awaiting-projection",
        messageIds: ["message-b"],
        requestId: "request-b",
      }),
    });
    expect(
      settleQueuedMessagePromotion({
        phasesRef,
        setPhases,
        threadKey: "thread-a",
        activities: [promotionActivity({ requestId: "request-a", messageIds: ["message-a"] })],
      }),
    ).toEqual({ status: "succeeded", messageIds: ["message-a"] });
    expect(phasesRef.current).toEqual({
      "thread-b": expect.objectContaining({
        phase: "awaiting-projection",
        messageIds: ["message-b"],
        requestId: "request-b",
      }),
    });
  });

  it("isolates identical thread ids that belong to different environments", async () => {
    const sharedThreadId = ThreadId.make("shared-thread-id");
    const firstKey = scopedThreadKey(
      scopeThreadRef(EnvironmentId.make("environment-a"), sharedThreadId),
    );
    const secondKey = scopedThreadKey(
      scopeThreadRef(EnvironmentId.make("environment-b"), sharedThreadId),
    );
    const phasesRef: { current: QueuedMessagePromotionPhases } = { current: {} };
    const callbacks = {
      phasesRef,
      setPhases: vi.fn(),
      promote: vi.fn().mockResolvedValue(true),
      onStart: vi.fn(),
      onSuccess: vi.fn(),
      onError: vi.fn(),
    };

    await runQueuedMessagePromotion({
      ...callbacks,
      threadKey: firstKey,
      messageIds: ["message-a"],
      requestId: "request-a",
    });
    await runQueuedMessagePromotion({
      ...callbacks,
      threadKey: secondKey,
      messageIds: ["message-b"],
      requestId: "request-b",
    });

    expect(callbacks.promote).toHaveBeenCalledTimes(2);
    expect(Object.keys(phasesRef.current)).toEqual([firstKey, secondKey]);
    expect(
      settleQueuedMessagePromotion({
        phasesRef,
        setPhases: callbacks.setPhases,
        threadKey: firstKey,
        activities: [promotionActivity({ requestId: "request-a", messageIds: ["message-a"] })],
      }),
    ).toEqual({ status: "succeeded", messageIds: ["message-a"] });
    expect(phasesRef.current[firstKey]).toBeUndefined();
    expect(phasesRef.current[secondKey]).toBeDefined();
  });

  it("unlocks an interrupted command without claiming it reached projection", async () => {
    const phasesRef: { current: QueuedMessagePromotionPhases } = { current: {} };
    const onSuccess = vi.fn();
    const onError = vi.fn();

    await expect(
      runQueuedMessagePromotion({
        phasesRef,
        setPhases: vi.fn(),
        threadKey: "thread-a",
        messageIds: ["message-a"],
        requestId: "request-a",
        promote: vi.fn().mockResolvedValue(false),
        onStart: vi.fn(),
        onSuccess,
        onError,
      }),
    ).resolves.toBe(true);

    expect(phasesRef.current).toEqual({});
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("unlocks the promoted batch even when a newer queued message is already visible", async () => {
    const phasesRef: { current: QueuedMessagePromotionPhases } = {
      current: {
        "thread-a": {
          phase: "awaiting-projection",
          messageIds: ["promoted-a", "promoted-b"],
          requestId: "request-a",
          startedAtMs: 0,
        },
      },
    };
    const setPhases = vi.fn();

    expect(
      settleQueuedMessagePromotion({
        phasesRef,
        setPhases,
        threadKey: "thread-a",
        activities: [
          promotionActivity({
            requestId: "request-a",
            messageIds: ["promoted-a", "promoted-b"],
          }),
        ],
      }),
    ).toEqual({ status: "succeeded", messageIds: ["promoted-a", "promoted-b"] });
    expect(phasesRef.current).toEqual({});
  });

  it("ignores another request and unlocks the exact batch on projected failure", () => {
    const phasesRef: { current: QueuedMessagePromotionPhases } = {
      current: {
        "thread-a": {
          phase: "awaiting-projection",
          messageIds: ["message-a"],
          requestId: "request-a",
          startedAtMs: 0,
        },
      },
    };
    const setPhases = vi.fn();
    const unrelated = promotionActivity({
      kind: "provider.queue.promote.failed",
      requestId: "request-b",
      detail: "unrelated failure",
    });

    expect(
      settleQueuedMessagePromotion({
        phasesRef,
        setPhases,
        threadKey: "thread-a",
        activities: [unrelated],
      }),
    ).toBeNull();
    expect(phasesRef.current["thread-a"]).toBeDefined();

    expect(
      settleQueuedMessagePromotion({
        phasesRef,
        setPhases,
        threadKey: "thread-a",
        activities: [
          unrelated,
          promotionActivity({
            kind: "provider.queue.promote.failed",
            requestId: "request-a",
            detail: "session stopped before promotion",
          }),
        ],
      }),
    ).toEqual({ status: "failed", detail: "session stopped before promotion" });
    expect(phasesRef.current).toEqual({});
  });

  it("unlocks a promotion that never received a terminal projection", () => {
    const phasesRef: { current: QueuedMessagePromotionPhases } = {
      current: {
        "thread-a": {
          phase: "awaiting-projection",
          messageIds: ["message-a"],
          requestId: "request-a",
          startedAtMs: 1_000,
        },
      },
    };
    const setPhases = vi.fn();

    expect(
      expireStaleQueuedMessagePromotion({
        phasesRef,
        setPhases,
        threadKey: "thread-a",
        nowMs: 1_000 + QUEUED_MESSAGE_PROMOTION_STALE_MS - 1,
      }),
    ).toBeNull();
    expect(phasesRef.current["thread-a"]).toBeDefined();

    expect(
      expireStaleQueuedMessagePromotion({
        phasesRef,
        setPhases,
        threadKey: "thread-a",
        nowMs: 1_000 + QUEUED_MESSAGE_PROMOTION_STALE_MS,
      }),
    ).toEqual({
      status: "failed",
      detail: "Sending queued messages timed out. Try Send queued now again.",
    });
    expect(phasesRef.current).toEqual({});
  });

  it("does not revive an expired promotion when the RPC later accepts", async () => {
    let releasePromotion: (() => void) | undefined;
    const phasesRef: { current: QueuedMessagePromotionPhases } = { current: {} };
    const setPhases = vi.fn();
    const onSuccess = vi.fn();
    const onError = vi.fn();

    const pending = runQueuedMessagePromotion({
      phasesRef,
      setPhases,
      threadKey: "thread-a",
      messageIds: ["message-a"],
      requestId: "request-a",
      promote: () =>
        new Promise<boolean>((resolve) => {
          releasePromotion = () => resolve(true);
        }),
      onStart: vi.fn(),
      onSuccess,
      onError,
    });

    expect(
      expireStaleQueuedMessagePromotion({
        phasesRef,
        setPhases,
        threadKey: "thread-a",
        nowMs: Date.now() + QUEUED_MESSAGE_PROMOTION_STALE_MS,
      }),
    ).toEqual({
      status: "failed",
      detail: "Sending queued messages timed out. Try Send queued now again.",
    });

    releasePromotion?.();
    await expect(pending).resolves.toBe(true);
    expect(phasesRef.current).toEqual({});
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
