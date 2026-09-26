import { afterEach, expect, it, vi } from "vite-plus/test";

import { pollRemoteControlPointer } from "./pollRemoteControlPointer";

afterEach(() => vi.useRealTimers());

it("keeps only one native pointer request in flight and stops after session cleanup", async () => {
  vi.useFakeTimers();
  let complete!: () => void;
  const read = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  const stop = pollRemoteControlPointer(read);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(read).toHaveBeenCalledOnce();
  complete();
  await vi.advanceTimersByTimeAsync(100);
  expect(read).toHaveBeenCalledTimes(2);
  stop();
  complete();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(read).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
