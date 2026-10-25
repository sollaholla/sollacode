import * as NodeNet from "node:net";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createPipe, LOOPBACK } from "./linkEmulator.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("benchmark link backpressure", () => {
  it("pauses unshaped input until the receiver drains and retains byte ordering", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const source = new NodeNet.Socket();
    const target = new NodeNet.Socket();
    const pause = vi.spyOn(source, "pause");
    const resume = vi.spyOn(source, "resume");
    const write = vi.spyOn(target, "write").mockReturnValue(false);
    const count = vi.fn();
    const pipe = createPipe(source, target, () => LOOPBACK, count);
    try {
      pipe.push(Buffer.from([1]));
      pipe.push(Buffer.from([2]));
      vi.runAllTimers();
      expect(pause).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledOnce();
      expect(count.mock.calls).toEqual([[1]]);
      expect(resume).not.toHaveBeenCalled();

      write.mockReturnValue(true);
      target.emit("drain");
      expect(write.mock.calls.map(([data]) => [...(data as Buffer)])).toEqual([[1], [2]]);
      expect(resume).toHaveBeenCalledOnce();
      expect(count.mock.calls).toEqual([[1], [1]]);
    } finally {
      pipe.destroy();
      source.destroy();
      target.destroy();
    }
    expect(target.listenerCount("drain")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops a shaped flush at a blocked write instead of filling the socket buffer", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const source = new NodeNet.Socket();
    const target = new NodeNet.Socket();
    const pause = vi.spyOn(source, "pause");
    const resume = vi.spyOn(source, "resume");
    const write = vi.spyOn(target, "write").mockReturnValue(false);
    const count = vi.fn();
    const pipe = createPipe(
      source,
      target,
      () => ({ name: "test", rttMs: 2, rateBitsPerSecond: 16_384 * 8 * 1_000, bufferMs: 100 }),
      count,
    );
    try {
      pipe.push(Buffer.alloc(3 * 16_384));
      vi.advanceTimersByTime(10);
      expect(write).toHaveBeenCalledOnce();
      expect(pause).toHaveBeenCalledOnce();
      expect(resume).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);

      write.mockReturnValue(true);
      target.emit("drain");
      expect(write).toHaveBeenCalledTimes(3);
      expect(count.mock.calls).toEqual([[16_384], [16_384], [16_384]]);
      expect(resume).toHaveBeenCalledOnce();
    } finally {
      pipe.destroy();
      source.destroy();
      target.destroy();
    }
    expect(target.listenerCount("drain")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
