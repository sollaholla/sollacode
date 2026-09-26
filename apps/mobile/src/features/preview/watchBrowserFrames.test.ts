import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const app = vi.hoisted(() => ({
  currentState: "active",
  listeners: new Set<(state: string) => void>(),
  addEventListener: (_: string, listener: (state: string) => void) => {
    app.listeners.add(listener);
    return { remove: () => app.listeners.delete(listener) };
  },
}));
vi.mock("react-native", () => ({ AppState: app }));

import { watchBrowserFrames } from "./watchBrowserFrames";

function changeState(state: string) {
  app.currentState = state;
  for (const listener of app.listeners) listener(state);
}

afterEach(() => {
  app.currentState = "active";
  app.listeners.clear();
  vi.useRealTimers();
});

describe("native browser frame lifetime", () => {
  it("stops background captures and refreshes immediately on foregrounding", async () => {
    vi.useFakeTimers();
    const capture = vi.fn(async () => true);
    const onPause = vi.fn();
    const stop = watchBrowserFrames({ capture, onPause, intervalMs: () => 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(capture).toHaveBeenCalledOnce();
    changeState("background");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(capture).toHaveBeenCalledOnce();
    expect(onPause).toHaveBeenCalledOnce();
    changeState("active");
    expect(capture).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(app.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never overlaps a slow capture when the app backgrounds and resumes", async () => {
    vi.useFakeTimers();
    let complete!: () => void;
    const capture = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const stop = watchBrowserFrames({ capture, onPause: vi.fn(), intervalMs: () => 1000 });
    changeState("background");
    changeState("active");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(capture).toHaveBeenCalledOnce();
    complete();
    await vi.advanceTimersByTimeAsync(1000);
    expect(capture).toHaveBeenCalledTimes(2);
    stop();
    complete();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
