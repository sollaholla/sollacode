import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createVideoStreamPublisher, type VideoSource } from "./videoStreamPublisher.ts";
import { openMediaPublisher } from "./mediaChannelSocket.ts";

vi.mock("./mediaChannelSocket.ts", () => ({ openMediaPublisher: vi.fn() }));

describe("publisher capture lifecycle", () => {
  const closeSocket = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(openMediaPublisher).mockReturnValue({
      close: closeSocket,
      send: vi.fn(),
      sendPacket: vi.fn(),
      bufferedAmount: () => 0,
      isOpen: () => true,
    });
    vi.stubGlobal(
      "MediaStreamTrackProcessor",
      class {
        readable = new ReadableStream<VideoFrame>();
      },
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });
  const subscriber = {
    id: "viewer",
    codecs: ["vp8"],
    view: { width: 640, height: 480, devicePixelRatio: 1, zoom: 1 },
  };
  const notice = (present: boolean) =>
    vi
      .mocked(openMediaPublisher)
      .mock.calls.at(-1)![1]
      .onNotice({ type: "subscribers", subscribers: present ? [subscriber] : [] });
  const source = (): VideoSource => ({
    track: new EventTarget() as MediaStreamTrack,
    close: vi.fn(),
  });

  it("reopens after the last viewer leaves while capture is still opening", async () => {
    let resolveFirst!: (source: VideoSource) => void;
    const first = source();
    const second = source();
    const openSource = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<VideoSource>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue(second);
    const publisher = createVideoStreamPublisher({
      resolveUrl: async () => "wss://example.test/ws/media",
      openSource,
    });
    await vi.advanceTimersByTimeAsync(0);
    notice(true);
    notice(false);
    await vi.advanceTimersByTimeAsync(3_001);
    notice(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(openSource).toHaveBeenCalledTimes(2);
    resolveFirst(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(first.close).toHaveBeenCalledOnce();
    expect(publisher.stats().capturing).toBe(true);
    publisher.stop();
    expect(second.close).toHaveBeenCalledOnce();
  });

  it("closes a capture that resolves after stop without starting an encoder", async () => {
    let resolve!: (source: VideoSource) => void;
    const captured = source();
    const publisher = createVideoStreamPublisher({
      resolveUrl: async () => "wss://example.test/ws/media",
      openSource: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    await vi.advanceTimersByTimeAsync(0);
    notice(true);
    publisher.stop();
    resolve(captured);
    await vi.advanceTimersByTimeAsync(0);
    expect(captured.close).toHaveBeenCalledOnce();
    expect(publisher.stats().capturing).toBe(false);
    expect(closeSocket).toHaveBeenCalledOnce();
  });
});
