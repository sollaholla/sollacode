import { beforeEach, describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  cacheTerminalFontSize,
  cacheTerminalGridSize,
  getCachedTerminalFontSize,
  getCachedTerminalGridSize,
  resetTerminalUiStateCaches,
} from "./terminalUiState";

describe("terminalUiState", () => {
  beforeEach(() => {
    resetTerminalUiStateCaches();
  });

  it("caches terminal font size using the shared normalization rules", () => {
    expect(getCachedTerminalFontSize()).toBeNull();
    expect(cacheTerminalFontSize(8.5)).toBe(8.5);
    expect(getCachedTerminalFontSize()).toBe(8.5);
    expect(cacheTerminalFontSize(100)).toBe(14);
    expect(getCachedTerminalFontSize()).toBe(14);
  });

  it("stores terminal grid sizes per terminal target", () => {
    const primaryTarget = {
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      terminalId: "default",
    };
    const otherTarget = {
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      terminalId: "term-2",
    };

    expect(getCachedTerminalGridSize(primaryTarget)).toBeNull();
    expect(
      cacheTerminalGridSize(primaryTarget, {
        cols: 107.9,
        rows: 33.2,
      }),
    ).toEqual({
      cols: 107,
      rows: 33,
    });
    expect(getCachedTerminalGridSize(primaryTarget)).toEqual({
      cols: 107,
      rows: 33,
    });
    expect(getCachedTerminalGridSize(otherTarget)).toBeNull();
  });

  it("bounds old terminal sizes while preserving recently read or resized terminals", () => {
    const target = (id: number) => ({
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make(`thread-${id}`),
      terminalId: "default",
    });
    for (let id = 0; id < 256; id++) {
      cacheTerminalGridSize(target(id), { cols: 80, rows: 24 });
    }
    expect(getCachedTerminalGridSize(target(0))).toEqual({ cols: 80, rows: 24 });
    cacheTerminalGridSize(target(1), { cols: 120, rows: 40 });
    cacheTerminalGridSize(target(256), { cols: 100, rows: 30 });
    expect(getCachedTerminalGridSize(target(2))).toBeNull();
    expect(getCachedTerminalGridSize(target(0))).toEqual({ cols: 80, rows: 24 });
    expect(getCachedTerminalGridSize(target(1))).toEqual({ cols: 120, rows: 40 });
    expect(getCachedTerminalGridSize(target(256))).toEqual({ cols: 100, rows: 30 });
  });
});
