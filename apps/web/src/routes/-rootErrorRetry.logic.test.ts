import { describe, expect, it, vi } from "vite-plus/test";

import { installRootErrorAutoRetry, ROOT_ERROR_RETRY_INTERVAL_MS } from "./-rootErrorRetry.logic";

function makeTargets(visibilityState: DocumentVisibilityState) {
  const windowListeners = new Set<() => void>();
  const documentListeners = new Set<() => void>();
  const testDocument = {
    visibilityState,
    addEventListener: (_type: "visibilitychange", listener: () => void) =>
      documentListeners.add(listener),
    removeEventListener: (_type: "visibilitychange", listener: () => void) =>
      documentListeners.delete(listener),
  };
  const testWindow = {
    addEventListener: (_type: "online", listener: () => void) => windowListeners.add(listener),
    removeEventListener: (_type: "online", listener: () => void) =>
      windowListeners.delete(listener),
    setInterval: (handler: () => void, timeout: number) =>
      globalThis.setInterval(handler, timeout) as unknown as number,
    clearInterval: (id: number) => globalThis.clearInterval(id),
  };
  return {
    testWindow,
    testDocument,
    goOnline: () => windowListeners.forEach((listener) => listener()),
    show: () => {
      testDocument.visibilityState = "visible";
      documentListeners.forEach((listener) => listener());
    },
    listenerCount: () => windowListeners.size + documentListeners.size,
  };
}

describe("installRootErrorAutoRetry", () => {
  it("retries on its own while the page is on screen, and at once when the connection returns", () => {
    vi.useFakeTimers();
    const targets = makeTargets("visible");
    const retry = vi.fn();
    const cleanup = installRootErrorAutoRetry({
      window: targets.testWindow,
      document: targets.testDocument,
      retry,
    });

    vi.advanceTimersByTime(ROOT_ERROR_RETRY_INTERVAL_MS);
    expect(retry).toHaveBeenCalledTimes(1);
    targets.goOnline();
    expect(retry).toHaveBeenCalledTimes(2);

    cleanup();
    vi.advanceTimersByTime(ROOT_ERROR_RETRY_INTERVAL_MS * 3);
    targets.goOnline();
    expect(retry).toHaveBeenCalledTimes(2);
    expect(targets.listenerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("waits for a hidden page to come back instead of retrying in the background", () => {
    vi.useFakeTimers();
    const targets = makeTargets("hidden");
    const retry = vi.fn();
    const cleanup = installRootErrorAutoRetry({
      window: targets.testWindow,
      document: targets.testDocument,
      retry,
    });

    vi.advanceTimersByTime(ROOT_ERROR_RETRY_INTERVAL_MS * 3);
    targets.goOnline();
    expect(retry).not.toHaveBeenCalled();
    targets.show();
    expect(retry).toHaveBeenCalledTimes(1);
    cleanup();
    vi.useRealTimers();
  });
});
