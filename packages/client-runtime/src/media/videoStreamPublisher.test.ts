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

  it("reports the first healthy frame of every explicitly replaced capture", async () => {
    const frames: ReadableStreamDefaultController<VideoFrame>[] = [];
    vi.stubGlobal(
      "MediaStreamTrackProcessor",
      class {
        readable = new ReadableStream<VideoFrame>({
          start: (controller) => {
            frames.push(controller);
          },
        });
      },
    );
    vi.stubGlobal(
      "VideoFrame",
      class {
        readonly timestamp: number;
        constructor(_source: VideoFrame, options: VideoFrameInit) {
          this.timestamp = options.timestamp!;
        }
        close() {}
      },
    );
    vi.stubGlobal(
      "VideoEncoder",
      class {
        static async isConfigSupported(config: VideoEncoderConfig) {
          return { supported: true, config };
        }
        state = "configured";
        encodeQueueSize = 0;
        configure() {}
        encode() {}
        close() {
          this.state = "closed";
        }
      },
    );
    const onCaptureFrame = vi.fn();
    const publisher = createVideoStreamPublisher({
      resolveUrl: async () => "wss://example.test/ws/media",
      openSource: async () => source(),
      codecs: ["vp8"],
      onCaptureFrame,
    });
    const frame = () =>
      ({ displayWidth: 640, displayHeight: 480, close: vi.fn() }) as unknown as VideoFrame;
    await vi.advanceTimersByTimeAsync(0);
    notice(true);
    await vi.advanceTimersByTimeAsync(0);
    frames[0]!.enqueue(frame());
    await vi.advanceTimersByTimeAsync(0);
    expect(onCaptureFrame).toHaveBeenCalledOnce();
    publisher.restartSource();
    await vi.advanceTimersByTimeAsync(0);
    expect(onCaptureFrame).toHaveBeenCalledOnce();
    frames[1]!.enqueue(frame());
    await vi.advanceTimersByTimeAsync(0);
    expect(onCaptureFrame).toHaveBeenCalledTimes(2);
    frames[1]!.enqueue(frame());
    await vi.advanceTimersByTimeAsync(0);
    expect(onCaptureFrame).toHaveBeenCalledTimes(2);
    publisher.stop();
    for (const controller of frames) controller.close();
  });

  it("waits for socket congestion to drain before re-encoding a dropped still frame", async () => {
    let bufferedBytes = 0;
    let frames!: ReadableStreamDefaultController<VideoFrame>;
    let output!: VideoEncoderInit["output"];
    const encode = vi.fn<(frame: VideoFrame, options: VideoEncoderEncodeOptions) => void>();
    const sendPacket = vi.fn();
    vi.mocked(openMediaPublisher).mockReturnValue({
      close: closeSocket,
      send: vi.fn(),
      sendPacket,
      bufferedAmount: () => bufferedBytes,
      isOpen: () => true,
    });
    vi.stubGlobal(
      "MediaStreamTrackProcessor",
      class {
        readable = new ReadableStream<VideoFrame>({
          start: (controller) => {
            frames = controller;
          },
        });
      },
    );
    vi.stubGlobal(
      "VideoFrame",
      class {
        readonly timestamp: number;
        constructor(_source: VideoFrame, options: VideoFrameInit) {
          this.timestamp = options.timestamp!;
        }
        close() {}
      },
    );
    vi.stubGlobal(
      "VideoEncoder",
      class {
        static async isConfigSupported(config: VideoEncoderConfig) {
          return { supported: true, config };
        }
        state = "configured";
        encodeQueueSize = 0;
        encode = encode;
        constructor(callbacks: VideoEncoderInit) {
          output = callbacks.output;
        }
        configure() {}
        close() {
          this.state = "closed";
        }
      },
    );
    const publisher = createVideoStreamPublisher({
      resolveUrl: async () => "wss://example.test/ws/media",
      openSource: async () => source(),
      codecs: ["vp8"],
    });
    await vi.advanceTimersByTimeAsync(0);
    notice(true);
    await vi.advanceTimersByTimeAsync(0);
    frames.enqueue({
      displayWidth: 640,
      displayHeight: 480,
      close: vi.fn(),
    } as unknown as VideoFrame);
    await vi.advanceTimersByTimeAsync(0);
    expect(encode).toHaveBeenCalledOnce();

    const deliverOutput = () =>
      output(
        {
          type: "key",
          timestamp: encode.mock.calls.at(-1)![0].timestamp,
          byteLength: 100,
          copyTo: () => {},
        } as unknown as EncodedVideoChunk,
        {
          decoderConfig: { codec: "vp8", codedWidth: 640, codedHeight: 480 },
        },
      );
    bufferedBytes = 9 * 1024 * 1024;
    deliverOutput();
    await vi.advanceTimersByTimeAsync(500);
    expect(encode).toHaveBeenCalledOnce();
    expect(sendPacket).not.toHaveBeenCalled();

    bufferedBytes = 0;
    await vi.advanceTimersByTimeAsync(50);
    expect(encode).toHaveBeenCalledTimes(2);
    expect(encode.mock.calls[1]![1].keyFrame).toBe(true);
    deliverOutput();
    expect(sendPacket).toHaveBeenCalledOnce();
    expect(publisher.stats().framesIn).toBe(1);
    publisher.stop();
  });
});
