import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  HEARTBEAT_MISSES_TO_LOSE,
  HEARTBEAT_RETRY_MS,
  HEARTBEAT_TIMEOUT_MS,
  startHeartbeatWatch,
} from "./heartbeatWatch";

const EVERY_MS = 15_000;

describe("startHeartbeatWatch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const watch = (beat: (signal: AbortSignal) => Promise<Response>, hidden = false) => {
    const onLost = vi.fn();
    const onRefused = vi.fn();
    const handle = startHeartbeatWatch({
      everyMs: EVERY_MS,
      beat,
      onLost,
      onRefused,
      isHidden: () => hidden,
    });
    return { handle, onLost, onRefused };
  };

  it("keeps beating while the host answers", async () => {
    const beat = vi.fn(async () => new Response(null, { status: 204 }));
    const { handle, onLost } = watch(beat);
    await vi.advanceTimersByTimeAsync(EVERY_MS * 3);
    expect(beat).toHaveBeenCalledTimes(3);
    expect(onLost).not.toHaveBeenCalled();
    handle.stop();
  });

  it("calls a dropped link lost after a few quick retries, not at the lease", async () => {
    const beat = vi.fn(async () => Promise.reject(new TypeError("Load failed")));
    const { onLost } = watch(beat);
    await vi.advanceTimersByTimeAsync(EVERY_MS);
    expect(onLost).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_RETRY_MS * (HEARTBEAT_MISSES_TO_LOSE - 1));
    expect(beat).toHaveBeenCalledTimes(HEARTBEAT_MISSES_TO_LOSE);
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it("counts a request that never answers, the half-open socket a failure can't report", async () => {
    const beat = vi.fn(
      (signal: AbortSignal) =>
        new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const { onLost } = watch(beat);
    await vi.advanceTimersByTimeAsync(
      EVERY_MS +
        HEARTBEAT_MISSES_TO_LOSE * HEARTBEAT_TIMEOUT_MS +
        (HEARTBEAT_MISSES_TO_LOSE - 1) * HEARTBEAT_RETRY_MS,
    );
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it("forgives a miss the next beat makes up for", async () => {
    let fail = true;
    const beat = vi.fn(async () => {
      if (fail) {
        fail = false;
        throw new TypeError("Load failed");
      }
      return new Response(null, { status: 204 });
    });
    const { handle, onLost } = watch(beat);
    await vi.advanceTimersByTimeAsync(EVERY_MS * 4);
    expect(onLost).not.toHaveBeenCalled();
    handle.stop();
  });

  it("reports a host that no longer holds the session", async () => {
    const { onRefused, onLost } = watch(async () => new Response(null, { status: 409 }));
    await vi.advanceTimersByTimeAsync(EVERY_MS);
    expect(onRefused).toHaveBeenCalledTimes(1);
    expect(onLost).not.toHaveBeenCalled();
  });

  it("doesn't count misses while the page is hidden", async () => {
    const beat = vi.fn(async () => Promise.reject(new TypeError("Load failed")));
    const { handle, onLost } = watch(beat, true);
    await vi.advanceTimersByTimeAsync(EVERY_MS * 6);
    expect(beat).toHaveBeenCalledTimes(6);
    expect(onLost).not.toHaveBeenCalled();
    handle.stop();
  });

  it("does nothing more once stopped", async () => {
    const beat = vi.fn(async () => new Response(null, { status: 204 }));
    const { handle } = watch(beat);
    handle.stop();
    await vi.advanceTimersByTimeAsync(EVERY_MS * 2);
    expect(beat).not.toHaveBeenCalled();
  });
});
