import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { waitWithTimeout } from "./deadline.ts";

afterEach(() => vi.useRealTimers());

describe("benchmark operation deadlines", () => {
  it("releases the timeout after a picture arrives", async () => {
    vi.useFakeTimers();
    expect(await waitWithTimeout(Promise.resolve(42), 10_000, null)).toBe(42);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases the timeout when the operation fails", async () => {
    vi.useFakeTimers();
    const error = new Error("connection closed");
    await expect(waitWithTimeout(Promise.reject(error), 10_000, null)).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still times out an operation that never completes", async () => {
    vi.useFakeTimers();
    const result = waitWithTimeout(new Promise<number>(() => {}), 10_000, null);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
