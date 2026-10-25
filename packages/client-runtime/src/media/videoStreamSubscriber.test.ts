import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createVideoStreamSubscriber } from "./videoStreamSubscriber.ts";
import { openMediaSubscriber } from "./mediaChannelSocket.ts";
import { createVideoCanvasRenderer } from "./videoCanvasRenderer.ts";

vi.mock("./mediaChannelSocket.ts", () => ({ openMediaSubscriber: vi.fn() }));
vi.mock("./videoCanvasRenderer.ts", () => ({ createVideoCanvasRenderer: vi.fn() }));

describe("video subscriber recovery", () => {
  const close = vi.fn();
  const dispose = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(openMediaSubscriber).mockReturnValue({ close, send: vi.fn() });
    vi.mocked(createVideoCanvasRenderer).mockReturnValue({
      push: vi.fn(),
      dispose,
      stats: () => ({
        decoded: 0,
        dropped: 0,
        errors: 0,
        keyframesRequested: 0,
        codec: null,
        width: 0,
        height: 0,
      }),
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });
  const start = (onFatal = vi.fn()) => ({
    onFatal,
    subscriber: createVideoStreamSubscriber({
      resolveUrl: async () => "wss://example.test/ws/media?ticket=fresh",
      canvas: {} as HTMLCanvasElement,
      codecs: ["vp8"],
      viewport: () => ({ width: 640, height: 480, devicePixelRatio: 1, zoom: 1 }),
      onFatal,
    }),
  });
  const callbacks = () => vi.mocked(openMediaSubscriber).mock.calls.at(-1)![1];

  it("falls back when a connected publisher never produces a usable frame", async () => {
    const { onFatal } = start();
    await vi.advanceTimersByTimeAsync(0);
    callbacks().onOpen?.();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onFatal).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("bounds reconnects even when sockets open then immediately close", async () => {
    const { onFatal } = start();
    for (const delay of [0, 500, 1_000, 2_000]) {
      await vi.advanceTimersByTimeAsync(delay);
      callbacks().onOpen?.();
      callbacks().onClose(1006, "lost");
    }
    expect(onFatal).toHaveBeenCalledOnce();
    expect(openMediaSubscriber).toHaveBeenCalledTimes(4);
  });

  it("turns synchronous socket failures into bounded retries", async () => {
    vi.mocked(openMediaSubscriber).mockImplementation(() => {
      throw new Error("bad URL");
    });
    const { onFatal } = start();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(onFatal).toHaveBeenCalledWith("bad URL");
    expect(openMediaSubscriber).toHaveBeenCalledTimes(4);
  });

  it("cancels pending connection and watchdog work when stopped", async () => {
    const { subscriber, onFatal } = start();
    await vi.advanceTimersByTimeAsync(0);
    callbacks().onOpen?.();
    subscriber.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onFatal).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not time out a still screen after its first decoded frame", async () => {
    const { subscriber, onFatal } = start();
    await vi.advanceTimersByTimeAsync(0);
    callbacks().onOpen?.();
    vi.mocked(createVideoCanvasRenderer).mock.calls[0]![0].onFrame?.({} as VideoFrame, {
      codec: "vp8",
      codedWidth: 640,
      codedHeight: 480,
      sourceWidth: 640,
      sourceHeight: 480,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onFatal).not.toHaveBeenCalled();
    subscriber.stop();
  });
});
