import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  isProcessShuttingDown,
  markProcessShuttingDown,
  resetProcessShutdownForTesting,
  watchProcessShutdown,
} from "./processShutdown.ts";

afterEach(() => {
  resetProcessShutdownForTesting();
});

describe("process shutdown latch", () => {
  it("is not shutting down until something says so", () => {
    expect(isProcessShuttingDown()).toBe(false);
  });

  it("latches on a termination signal", () => {
    const unwatch = watchProcessShutdown();
    try {
      process.emit("SIGTERM");
      expect(isProcessShuttingDown()).toBe(true);
    } finally {
      unwatch();
    }
  });

  it("stops listening when told to, and removes only its own listener", () => {
    const before = process.listenerCount("SIGTERM");
    const unwatch = watchProcessShutdown();
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    unwatch();
    expect(process.listenerCount("SIGTERM")).toBe(before);

    process.emit("SIGTERM");
    // Unwatched, so the signal no longer latches anything.
    expect(isProcessShuttingDown()).toBe(false);
  });

  it("can be latched directly by a shutdown path that already knows", () => {
    markProcessShuttingDown();
    expect(isProcessShuttingDown()).toBe(true);
  });
});
