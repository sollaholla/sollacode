// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vite-plus/test";

import { observeComposerMenuPosition } from "./composerMenuPosition";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("coalesces scroll bursts without re-rendering a stationary composer menu", async () => {
  vi.useFakeTimers();
  const anchor = document.createElement("div");
  let top = 400;
  const read = vi
    .spyOn(anchor, "getBoundingClientRect")
    .mockImplementation(() => new DOMRect(20, top, 600, 80));
  const position = vi.fn();
  const cleanup = observeComposerMenuPosition(anchor, position);
  expect(position).toHaveBeenCalledOnce();
  for (let i = 0; i < 100; i++) window.dispatchEvent(new Event("scroll"));
  await vi.advanceTimersByTimeAsync(20);
  expect(read).toHaveBeenCalledTimes(2);
  expect(position).toHaveBeenCalledOnce();
  top = 350;
  window.dispatchEvent(new Event("resize"));
  await vi.advanceTimersByTimeAsync(20);
  expect(position).toHaveBeenCalledTimes(2);
  expect(position).toHaveBeenLastCalledWith({
    bottom: window.innerHeight - 350 + 8,
    left: 20,
    maxHeight: 326,
    width: 600,
  });
  window.dispatchEvent(new Event("scroll"));
  cleanup();
  window.dispatchEvent(new Event("resize"));
  await vi.advanceTimersByTimeAsync(20);
  expect(read).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});
