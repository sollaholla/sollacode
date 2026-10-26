import { describe, expect, it, vi } from "vite-plus/test";
import { captureNextEncodedFrame } from "./nativeQuality.ts";

function frameFixture() {
  const close = vi.fn();
  const cloned = { close } as unknown as VideoFrame;
  const clone = vi.fn(() => cloned);
  return { source: { clone } as unknown as VideoFrame, cloned, clone, close };
}

describe("native quality frame ownership", () => {
  it("captures one submitted frame, restores the encoder, and transfers clone ownership", () => {
    const original = vi.fn();
    const prototype = { encode: original };
    const capture = captureNextEncodedFrame(prototype);
    const frame = frameFixture();
    const encoder = {} as VideoEncoder;
    const options = { keyFrame: true };

    prototype.encode.call(encoder, frame.source, options);

    expect(original).toHaveBeenCalledExactlyOnceWith(frame.source, options);
    expect(original.mock.contexts).toEqual([encoder]);
    expect(frame.clone).toHaveBeenCalledOnce();
    expect(prototype.encode).toBe(original);
    expect(capture.take()).toBe(frame.cloned);
    expect(capture.take()).toBeNull();
    capture.stop();
    expect(frame.close).not.toHaveBeenCalled();
    frame.cloned.close();
    expect(frame.close).toHaveBeenCalledOnce();
  });

  it("closes an unconsumed clone once when the run stops", () => {
    const prototype = { encode: vi.fn() };
    const capture = captureNextEncodedFrame(prototype);
    const frame = frameFixture();
    prototype.encode.call({} as VideoEncoder, frame.source);
    capture.stop();
    capture.stop();
    expect(frame.close).toHaveBeenCalledOnce();
    expect(capture.take()).toBeNull();
  });

  it("restores the encoder when a run stops before its first frame", () => {
    const original = vi.fn();
    const prototype = { encode: original };
    const capture = captureNextEncodedFrame(prototype);
    capture.stop();
    expect(prototype.encode).toBe(original);
    expect(capture.take()).toBeNull();
  });

  it("closes the clone and restores the encoder if native encoding rejects", () => {
    const failure = new Error("closed encoder");
    const original = vi.fn((_frame: VideoFrame) => {
      throw failure;
    });
    const prototype = { encode: original };
    const capture = captureNextEncodedFrame(prototype);
    const frame = frameFixture();
    expect(() => prototype.encode.call({} as VideoEncoder, frame.source)).toThrow(failure);
    expect(frame.close).toHaveBeenCalledOnce();
    expect(prototype.encode).toBe(original);
    expect(capture.take()).toBeNull();
    capture.stop();
    expect(frame.close).toHaveBeenCalledOnce();
  });
});
