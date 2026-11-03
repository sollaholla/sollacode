import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  VideoStreamSubscriber,
  VideoStreamSubscriberOptions,
} from "@t3tools/client-runtime/media/video-stream-subscriber";
import type { MediaVideoConfig } from "@t3tools/shared/mediaPacket";
import { PREVIEW_MEDIA_PAGE_STATE_KEY } from "@t3tools/contracts";
import { createRemotePreviewMedia, REMOTE_PREVIEW_MEDIA_STARTUP_MS } from "./remotePreviewMedia";

const mocks = vi.hoisted(() => ({
  detect: vi.fn<() => Promise<ReadonlyArray<string>>>(),
  subscribe: vi.fn<(options: VideoStreamSubscriberOptions) => VideoStreamSubscriber>(),
}));
vi.mock("@t3tools/client-runtime/media/video-codecs", () => ({
  detectDecodableCodecs: mocks.detect,
}));
vi.mock("@t3tools/client-runtime/media/video-stream-subscriber", () => ({
  createVideoStreamSubscriber: mocks.subscribe,
}));

type WatchHandlers = Parameters<Parameters<typeof createRemotePreviewMedia>[0]["watch"]>[0];
const config: MediaVideoConfig = {
  codec: "hvc1.1.6.L153.B0",
  sourceWidth: 1_600,
  sourceHeight: 900,
  codedWidth: 1_120,
  codedHeight: 630,
};

function fixture() {
  let handlers: WatchHandlers | null = null;
  const unsubscribe = vi.fn();
  const watch = vi.fn((next: WatchHandlers) => {
    handlers = next;
    return unsubscribe;
  });
  const onPicture = vi.fn();
  const onState = vi.fn();
  const onFallback = vi.fn();
  const resolveUrl = vi.fn(async (id: string) => `ws://example.invalid/media/${id}`);
  const viewport = vi.fn(() => ({ width: 400, height: 300, devicePixelRatio: 3, zoom: 1 }));
  const viewer = createRemotePreviewMedia({
    canvas: {} as HTMLCanvasElement,
    watch,
    onPicture,
    onState,
    onFallback,
    resolveUrl,
    viewport,
  });
  return {
    viewer,
    watch,
    unsubscribe,
    onPicture,
    onState,
    onFallback,
    resolveUrl,
    viewport,
    get handlers() {
      if (!handlers) throw new Error("Watch has not started");
      return handlers;
    },
  };
}

describe("remote preview media lifecycle", () => {
  const subscribers: Array<{
    options: VideoStreamSubscriberOptions;
    stop: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    frameExpected: ReturnType<typeof vi.fn>;
  }> = [];
  beforeEach(() => {
    vi.useFakeTimers();
    subscribers.length = 0;
    mocks.detect.mockReset().mockResolvedValue([config.codec]);
    mocks.subscribe.mockReset().mockImplementation((options) => {
      const stop = vi.fn();
      const update = vi.fn();
      const frameExpected = vi.fn();
      subscribers.push({ options, stop, update, frameExpected });
      return {
        stop,
        updateViewport: update,
        setFrameExpected: frameExpected,
        stats: () => ({
          decoded: 0,
          dropped: 0,
          errors: 0,
          keyframesRequested: 0,
          codec: null,
          width: 0,
          height: 0,
          packets: 0,
          bytes: 0,
          reconnects: 0,
        }),
      };
    });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("leaves JPEG active until the first video frame and uses source geometry for input", async () => {
    const f = fixture();
    await Promise.resolve();
    f.handlers.onEvent({ type: "ready", watchId: "one" });
    expect(f.onPicture).not.toHaveBeenCalled();
    subscribers[0]!.options.onFrame?.({} as VideoFrame, config, null);
    expect(f.onPicture).toHaveBeenCalledExactlyOnceWith({ width: 1_600, height: 900 });
    subscribers[0]!.options.onFrame?.({} as VideoFrame, config, null);
    expect(f.onPicture).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(REMOTE_PREVIEW_MEDIA_STARTUP_MS);
    expect(f.onFallback).not.toHaveBeenCalled();
    f.viewer.stop();
  });

  it("falls back without opening a host watch when decoding is unsupported", async () => {
    mocks.detect.mockResolvedValue([]);
    const f = fixture();
    await Promise.resolve();
    expect(f.watch).not.toHaveBeenCalled();
    expect(mocks.subscribe).not.toHaveBeenCalled();
    expect(f.onFallback).toHaveBeenCalledOnce();
    f.viewer.stop();
  });

  it("does not start a late codec probe after the viewer is hidden or unmounted", async () => {
    let resolve!: (codecs: ReadonlyArray<string>) => void;
    mocks.detect.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const f = fixture();
    f.viewer.stop();
    resolve([config.codec]);
    await Promise.resolve();
    expect(f.watch).not.toHaveBeenCalled();
    expect(f.onFallback).not.toHaveBeenCalled();
  });

  it("bounds startup and permits a new host generation to recover", async () => {
    const f = fixture();
    await Promise.resolve();
    f.handlers.onEvent({ type: "ready", watchId: "one" });
    await vi.advanceTimersByTimeAsync(REMOTE_PREVIEW_MEDIA_STARTUP_MS);
    expect(subscribers[0]!.stop).not.toHaveBeenCalled();
    expect(f.onFallback).toHaveBeenCalledOnce();
    f.handlers.onEvent({ type: "ready", watchId: "one" });
    expect(subscribers).toHaveLength(1);
    f.handlers.onEvent({ type: "ready", watchId: "two" });
    expect(subscribers).toHaveLength(2);
    expect(subscribers[0]!.stop).toHaveBeenCalledOnce();
    subscribers[0]!.options.onFrame?.({} as VideoFrame, config, null);
    expect(f.onPicture).not.toHaveBeenCalled();
    subscribers[1]!.options.onFrame?.({} as VideoFrame, config, null);
    expect(f.onPicture).toHaveBeenCalledOnce();
    f.viewer.stop();
  });

  it.each(["subscriber", "preview"] as const)(
    "restores video after a quiet source's %s deadline without a new watch",
    async (deadline) => {
      const f = fixture();
      await Promise.resolve();
      f.handlers.onEvent({ type: "ready", watchId: "one" });
      const current = subscribers[0]!;
      if (deadline === "subscriber") current.options.onFrameTimeout?.("No frame yet");
      else await vi.advanceTimersByTimeAsync(REMOTE_PREVIEW_MEDIA_STARTUP_MS);
      expect(f.onFallback).toHaveBeenCalledOnce();
      expect(current.stop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.onFallback).toHaveBeenCalledOnce();
      current.options.onFrame?.({} as VideoFrame, config, null);
      expect(f.onPicture).toHaveBeenCalledOnce();
      expect(subscribers).toHaveLength(1);
      f.viewer.stop();
      expect(current.stop).toHaveBeenCalledOnce();
    },
  );

  it.each(["unavailable", "fatal", "ended", "watch failure"] as const)(
    "releases video and returns to JPEG after %s",
    async (reason) => {
      const f = fixture();
      await Promise.resolve();
      f.handlers.onEvent({ type: "ready", watchId: "one" });
      const current = subscribers[0]!;
      current.options.onFrame?.({} as VideoFrame, config, null);
      if (reason === "unavailable")
        f.handlers.onEvent({ type: "unavailable", reason: "Host left" });
      else if (reason === "fatal") current.options.onFatal("Decoder failed");
      else if (reason === "ended") current.options.onEnded?.();
      else f.handlers.onFailure();
      expect(current.stop).toHaveBeenCalledOnce();
      expect(f.onFallback).toHaveBeenCalledOnce();
      expect(f.unsubscribe).not.toHaveBeenCalled();
      f.viewer.stop();
      expect(f.unsubscribe).toHaveBeenCalledOnce();
    },
  );

  it("refreshes tickets for the same watch and forwards viewport updates", async () => {
    const f = fixture();
    await Promise.resolve();
    f.handlers.onEvent({ type: "ready", watchId: "one" });
    const current = subscribers[0]!;
    await current.options.resolveUrl();
    await current.options.resolveUrl();
    expect(f.resolveUrl.mock.calls).toEqual([["one"], ["one"]]);
    expect(current.options.viewport()).toEqual(f.viewport());
    f.viewer.updateViewport();
    expect(current.update).toHaveBeenCalledOnce();
    f.viewer.stop();
    f.viewer.updateViewport();
    expect(current.update).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "recovers from capture loss after JPEG fallback (had picture: %s)",
    async (hadPicture) => {
      const f = fixture();
      await Promise.resolve();
      f.handlers.onEvent({ type: "ready", watchId: "one" });
      const current = subscribers[0]!;
      if (hadPicture) current.options.onFrame?.({} as VideoFrame, config, null);
      f.onPicture.mockClear();
      current.options.onBroadcast?.("preview-capture", { capturing: false });
      expect(f.onFallback).toHaveBeenCalledOnce();
      expect(current.frameExpected).toHaveBeenLastCalledWith(false);
      current.options.onFrame?.({} as VideoFrame, config, null);
      expect(f.onPicture).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(current.stop).not.toHaveBeenCalled();
      current.options.onBroadcast?.("preview-capture", { capturing: true });
      expect(current.frameExpected).toHaveBeenLastCalledWith(true);
      expect(f.onPicture).not.toHaveBeenCalled();
      current.options.onFrame?.({} as VideoFrame, config, null);
      expect(f.onPicture).toHaveBeenCalledExactlyOnceWith({ width: 1_600, height: 900 });
      expect(subscribers).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(REMOTE_PREVIEW_MEDIA_STARTUP_MS);
      expect(f.onFallback).toHaveBeenCalledOnce();
      f.viewer.stop();
      expect(current.stop).toHaveBeenCalledOnce();
    },
  );

  it("accepts validated page metadata and ignores stale generations", async () => {
    const f = fixture();
    await Promise.resolve();
    f.handlers.onEvent({ type: "ready", watchId: "one" });
    const first = subscribers[0]!;
    const state = { url: "https://example.com", title: "Page", loading: false };
    first.options.onBroadcast?.(PREVIEW_MEDIA_PAGE_STATE_KEY, state);
    first.options.onBroadcast?.(PREVIEW_MEDIA_PAGE_STATE_KEY, { title: 12 });
    expect(f.onState).toHaveBeenCalledExactlyOnceWith(state);
    f.handlers.onEvent({ type: "ready", watchId: "two" });
    expect(first.stop).toHaveBeenCalledOnce();
    first.options.onBroadcast?.(PREVIEW_MEDIA_PAGE_STATE_KEY, state);
    first.options.onFatal("Stale failure");
    expect(f.onState).toHaveBeenCalledOnce();
    expect(f.onFallback).not.toHaveBeenCalled();
    f.viewer.stop();
    subscribers[1]!.options.onFrame?.({} as VideoFrame, config, null);
    expect(f.onPicture).not.toHaveBeenCalled();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });

  it("rejects invalid source dimensions before changing input geometry", async () => {
    const f = fixture();
    await Promise.resolve();
    f.handlers.onEvent({ type: "ready", watchId: "one" });
    subscribers[0]!.options.onFrame?.({} as VideoFrame, { ...config, sourceWidth: 0 }, null);
    expect(f.onPicture).not.toHaveBeenCalled();
    expect(f.onFallback).toHaveBeenCalledOnce();
    f.viewer.stop();
  });
});
