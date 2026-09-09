import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { readPreviewDiagnostic } from "./previewDiagnosticDeadline";

afterEach(() => vi.useRealTimers());

describe("preview diagnostic deadline", () => {
  it("returns completed diagnostics and clears its deadline", async () => {
    vi.useFakeTimers();
    expect(await readPreviewDiagnostic(async () => "ready", "cached")).toBe("ready");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("returns cached state while a navigating renderer never settles", async () => {
    vi.useFakeTimers();
    const result = readPreviewDiagnostic(() => new Promise<string>(() => {}), "cached");
    await vi.advanceTimersByTimeAsync(750);
    expect(await result).toBe("cached");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("handles a late navigation rejection after the response was returned", async () => {
    vi.useFakeTimers();
    let reject: ((error: Error) => void) | undefined;
    const result = readPreviewDiagnostic(
      () =>
        new Promise<string>((_, fail) => {
          reject = fail;
        }),
      "cached",
    );
    await vi.advanceTimersByTimeAsync(750);
    expect(await result).toBe("cached");
    reject?.(new Error("execution context destroyed"));
    await Promise.resolve();
  });
});
