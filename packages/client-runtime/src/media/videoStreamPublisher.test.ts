import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createVideoStreamPublisher, type VideoSource } from "./videoStreamPublisher.ts";
import { openMediaPublisher } from "./mediaChannelSocket.ts";
import { decodeMediaPacket } from "@t3tools/shared/mediaPacket";

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

describe("publishing a magnified viewer's crop", () => {
  const whole = { width: 1_000, height: 800, devicePixelRatio: 2, zoom: 1 };
  const region = { x: 0.4, y: 0.4, width: 0.2, height: 0.2 };
  const zoomed = { ...whole, zoom: 5, region };

  function setup(opts: { readonly canCaptureHigher?: boolean } = {}) {
    const frames: ReadableStreamDefaultController<VideoFrame>[] = [];
    const encoders: Array<{ config: VideoEncoderConfig | null }> = [];
    let output!: VideoEncoderInit["output"];
    const encode = vi.fn<(frame: VideoFrame, options: VideoEncoderEncodeOptions) => void>();
    const sendPacket = vi.fn();
    const drawImage = vi.fn();
    vi.mocked(openMediaPublisher).mockReturnValue({
      close: vi.fn(),
      send: vi.fn(),
      sendPacket,
      bufferedAmount: () => 0,
      isOpen: () => true,
    });
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
        constructor(_source: unknown, options: VideoFrameInit) {
          this.timestamp = options.timestamp!;
        }
        close() {}
      },
    );
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        readonly width: number;
        readonly height: number;
        constructor(width: number, height: number) {
          this.width = width;
          this.height = height;
        }
        getContext() {
          return { drawImage };
        }
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
        entry: { config: VideoEncoderConfig | null } = { config: null };
        constructor(callbacks: VideoEncoderInit) {
          output = callbacks.output;
          encoders.push(this.entry);
        }
        configure(config: VideoEncoderConfig) {
          this.entry.config = config;
        }
        close() {
          this.state = "closed";
        }
      },
    );
    const openSource = vi.fn(
      async (_request: { readonly highResolution: boolean }): Promise<VideoSource> => ({
        track: new EventTarget() as MediaStreamTrack,
        close: vi.fn(),
        ...(opts.canCaptureHigher ? { canCaptureHigher: true } : {}),
      }),
    );
    const publisher = createVideoStreamPublisher({
      resolveUrl: async () => "wss://example.test/ws/media",
      openSource,
      codecs: ["vp8"],
    });
    const notice = (view: typeof whole | typeof zoomed) =>
      vi
        .mocked(openMediaPublisher)
        .mock.calls.at(-1)![1]
        .onNotice({
          type: "subscribers",
          subscribers: [{ id: "viewer", codecs: ["vp8"], view }],
        });
    const pushFrame = async () => {
      frames.at(-1)!.enqueue({
        displayWidth: 2_000,
        displayHeight: 1_600,
        close: vi.fn(),
      } as unknown as VideoFrame);
      await vi.advanceTimersByTimeAsync(20);
    };
    const deliver = () => {
      const [frame, options] = encode.mock.calls.at(-1)!;
      output(
        {
          type: options.keyFrame ? "key" : "delta",
          timestamp: frame.timestamp,
          byteLength: 100,
          copyTo: () => {},
        } as unknown as EncodedVideoChunk,
        { decoderConfig: { codec: "vp8", codedWidth: 2, codedHeight: 2 } },
      );
      return decodeMediaPacket(sendPacket.mock.calls.at(-1)![0] as Uint8Array)!;
    };
    return { publisher, notice, pushFrame, deliver, encode, encoders, drawImage, openSource };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  const start = async (test: ReturnType<typeof setup>) => {
    await vi.advanceTimersByTimeAsync(0);
    test.notice(whole);
    await vi.advanceTimersByTimeAsync(0);
    await test.pushFrame();
  };

  it("draws only the crop into the encoder and names it on the key frame", async () => {
    const test = setup();
    await start(test);
    expect(test.deliver().config?.region).toBeUndefined();
    test.notice(zoomed);
    await vi.advanceTimersByTimeAsync(100);
    const packet = test.deliver();
    expect(packet.key).toBe(true);
    const crop = test.publisher.stats().region!;
    expect(packet.config?.region?.x).toBeCloseTo(crop.x, 3);
    expect(packet.config?.region?.width).toBeCloseTo(crop.width, 3);
    const [, sx, , sw, , , , dw] = test.drawImage.mock.calls.at(-1)!;
    expect(sx).toBeCloseTo(crop.x * 2_000, 5);
    expect(sw).toBeCloseTo(crop.width * 2_000, 5);
    expect(dw).toBe(test.encoders.at(-1)!.config!.width);
    expect(test.publisher.stats().width).toBeLessThanOrEqual(crop.width * 2_000);
    test.publisher.stop();
  });

  it("moves the crop with a key frame and no new encoder when only the place changed", async () => {
    const test = setup();
    await start(test);
    test.notice(zoomed);
    await vi.advanceTimersByTimeAsync(100);
    test.deliver();
    const encoders = test.encoders.length;
    test.notice({ ...zoomed, region: { ...region, x: 0.1, y: 0.1 } });
    await vi.advanceTimersByTimeAsync(100);
    expect(test.encoders.length).toBe(encoders);
    expect(test.encode.mock.calls.at(-1)![1].keyFrame).toBe(true);
    expect(test.deliver().config?.region?.x).toBeLessThan(0.1);
    test.publisher.stop();
  });

  it("goes back to the whole picture when the viewer zooms out", async () => {
    const test = setup();
    await start(test);
    test.notice(zoomed);
    await vi.advanceTimersByTimeAsync(100);
    test.notice(whole);
    await vi.advanceTimersByTimeAsync(100);
    expect(test.publisher.stats().region).toBeNull();
    expect(test.deliver().config?.region).toBeUndefined();
    test.publisher.stop();
  });

  it("captures at full resolution only while cropped, with a hold before dropping back", async () => {
    const test = setup({ canCaptureHigher: true });
    await start(test);
    expect(test.openSource).toHaveBeenLastCalledWith({ highResolution: false });
    test.notice(zoomed);
    await vi.advanceTimersByTimeAsync(0);
    expect(test.openSource).toHaveBeenCalledTimes(2);
    expect(test.openSource).toHaveBeenLastCalledWith({ highResolution: true });
    test.notice(whole);
    await vi.advanceTimersByTimeAsync(5_000);
    test.notice(zoomed);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(test.openSource).toHaveBeenCalledTimes(2);
    test.notice(whole);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(test.openSource).toHaveBeenCalledTimes(3);
    expect(test.openSource).toHaveBeenLastCalledWith({ highResolution: false });
    test.publisher.stop();
  });

  it("does not reopen a capture that is already everything the display has", async () => {
    const test = setup();
    await start(test);
    test.notice(zoomed);
    await vi.advanceTimersByTimeAsync(100);
    expect(test.openSource).toHaveBeenCalledOnce();
    test.publisher.stop();
  });
});
