import { PreviewTabId, ThreadId, type PreviewRemoteFramePageState } from "@t3tools/contracts";
import type {
  VideoSource,
  VideoStreamPublisherOptions,
} from "@t3tools/client-runtime/media/video-stream-publisher";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { capturePreviewTab, createPreviewMediaHost, previewCaptureSize } from "./previewMediaHost";

const target = { threadId: ThreadId.make("thread-1"), tabId: PreviewTabId.make("tab-1") };
const other = { ...target, tabId: PreviewTabId.make("tab-2") };

function harness() {
  let generation = "one";
  let page: PreviewRemoteFramePageState = {
    url: "https://example.test",
    title: "Page",
    loading: false,
  };
  const publishers: Array<{
    options: VideoStreamPublisherOptions;
    broadcast: ReturnType<typeof vi.fn>;
    restartSource: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }> = [];
  const changes: Array<() => void> = [];
  const unsubscribe = vi.fn();
  const source = { track: new EventTarget() as MediaStreamTrack, close: vi.fn() };
  const openSource = vi.fn(async (_runtimeTabId: string): Promise<VideoSource> => source);
  const host = createPreviewMediaHost({
    runtime: (tab) => ({ runtimeTabId: `${tab.tabId}:${generation}`, generation }),
    resolveUrl: async (tab) => `wss://example.test/${tab.tabId}`,
    openSource,
    readState: () => page,
    subscribeTarget: (_target, changed) => {
      changes.push(changed);
      return unsubscribe;
    },
    createPublisher: (options) => {
      const publisher = { options, broadcast: vi.fn(), restartSource: vi.fn(), stop: vi.fn() };
      publishers.push(publisher);
      return publisher;
    },
  });
  return {
    host,
    publishers,
    changes,
    unsubscribe,
    openSource,
    source,
    setGeneration: (next: string) => {
      generation = next;
    },
    setPage: (next: PreviewRemoteFramePageState) => {
      page = next;
    },
  };
}

describe("preview video host ownership", () => {
  it("opens one publisher per demanded target and releases only removed targets", () => {
    const test = harness();
    expect(test.publishers).toHaveLength(0);
    test.host.setDemand([target, target, other]);
    expect(test.publishers).toHaveLength(2);
    expect(test.openSource).not.toHaveBeenCalled();
    test.host.setDemand([other]);
    expect(test.publishers[0]!.stop).toHaveBeenCalledOnce();
    expect(test.publishers[1]!.stop).not.toHaveBeenCalled();
    test.host.dispose();
    test.host.dispose();
    test.host.setDemand([target]);
    expect(test.publishers).toHaveLength(2);
    expect(test.publishers[1]!.stop).toHaveBeenCalledOnce();
    expect(test.unsubscribe).toHaveBeenCalledTimes(2);
  });

  it("reacquires the current runtime source after its generation changes", async () => {
    const test = harness();
    test.host.setDemand([target]);
    const publisher = test.publishers[0]!;
    await expect(publisher.options.resolveUrl()).resolves.toBe("wss://example.test/tab-1");
    await publisher.options.openSource({ highResolution: false });
    expect(test.openSource).toHaveBeenLastCalledWith("tab-1:one");
    test.setGeneration("two");
    test.changes[0]!();
    expect(publisher.restartSource).toHaveBeenCalledOnce();
    expect(test.unsubscribe).toHaveBeenCalledOnce();
    await publisher.options.openSource({ highResolution: false });
    expect(test.openSource).toHaveBeenLastCalledWith("tab-1:two");
    expect(test.host.hasRuntime("tab-1:one")).toBe(false);
    expect(test.host.hasRuntime("tab-1:two")).toBe(true);
    test.host.dispose();
  });

  it("reconnects a rotated topic even when the empty demand between watches was coalesced", async () => {
    const test = harness();
    test.host.setDemand([target]);
    const previous = test.publishers[0]!;
    previous.options.onEnded?.();
    expect(test.publishers).toHaveLength(2);
    const replacement = test.publishers[1]!;
    await expect(replacement.options.resolveUrl()).resolves.toBe("wss://example.test/tab-1");
    expect(replacement.broadcast).toHaveBeenCalledOnce();
    expect(test.openSource).not.toHaveBeenCalled();
    test.host.setDemand([target]);
    expect(test.publishers).toHaveLength(2);
    test.host.setDemand([]);
    expect(replacement.stop).toHaveBeenCalledOnce();
    replacement.options.onEnded?.();
    expect(test.publishers).toHaveLength(2);
  });

  it("reports capture interruption and recovery without publishing the native error", () => {
    const test = harness();
    test.host.setDemand([target]);
    const publisher = test.publishers[0]!;
    publisher.options.onCaptureError?.(new Error("private source detail"));
    expect(publisher.broadcast).toHaveBeenLastCalledWith("preview-capture", { capturing: false });
    const count = publisher.broadcast.mock.calls.length;
    publisher.options.onCaptureError?.(new Error("retry"));
    expect(publisher.broadcast).toHaveBeenCalledTimes(count);
    publisher.options.onCaptureFrame?.();
    expect(publisher.broadcast).toHaveBeenLastCalledWith("preview-capture", { capturing: true });
    test.host.dispose();
    publisher.options.onCaptureError?.(new Error("late"));
    expect(publisher.broadcast).toHaveBeenCalledTimes(count + 1);
  });

  it.each(["runtime", "viewport"] as const)(
    "marks %s replacement unavailable before restarting its source",
    (change) => {
      const test = harness();
      test.host.setDemand([target]);
      const publisher = test.publishers[0]!;
      publisher.options.onCaptureFrame?.();
      publisher.restartSource.mockImplementation(() => {
        expect(publisher.broadcast).toHaveBeenLastCalledWith("preview-capture", {
          capturing: false,
        });
      });
      if (change === "runtime") {
        test.setGeneration("two");
        test.host.refresh();
      } else test.host.sourceChanged("tab-1:one");
      expect(publisher.restartSource).toHaveBeenCalledOnce();
      publisher.options.onCaptureFrame?.();
      expect(publisher.broadcast).toHaveBeenLastCalledWith("preview-capture", { capturing: true });
      test.host.dispose();
    },
  );

  it.each(["removed", "replaced", "resized", "disposed"])(
    "closes a pending capture when its owner is %s",
    async (change) => {
      const test = harness();
      let opened!: (source: VideoSource) => void;
      test.openSource.mockImplementation(
        () =>
          new Promise((resolve) => {
            opened = resolve;
          }),
      );
      test.host.setDemand([target]);
      const pending = test.publishers[0]!.options.openSource({ highResolution: false });
      if (change === "removed") test.host.setDemand([]);
      if (change === "disposed") test.host.dispose();
      if (change === "resized") test.host.sourceChanged("tab-1:one");
      if (change === "replaced") {
        test.setGeneration("two");
        test.host.refresh();
      }
      opened(test.source);
      await expect(pending).rejects.toThrow("changed while capture was opening");
      expect(test.source.close).toHaveBeenCalledOnce();
      test.host.dispose();
    },
  );

  it("publishes changed page state and cursor removal without redundant broadcasts", () => {
    const test = harness();
    test.host.setDemand([target]);
    const publisher = test.publishers[0]!;
    expect(publisher.broadcast).toHaveBeenCalledOnce();
    test.host.stateChanged("tab-1:one");
    expect(publisher.broadcast).toHaveBeenCalledOnce();
    const next = { url: "https://example.test/next", title: "Next", loading: true };
    test.setPage(next);
    test.changes[0]!();
    expect(publisher.broadcast).toHaveBeenLastCalledWith("preview-page", next);
    expect(publisher.broadcast).toHaveBeenCalledTimes(2);
    test.setPage({ ...next, agentPointer: { x: 0.5, y: 0.5, phase: "move", sequence: 1 } });
    test.host.stateChanged("tab-1:one");
    test.setPage(next);
    test.host.stateChanged("tab-1:one");
    expect(publisher.broadcast).toHaveBeenLastCalledWith("preview-page", next);
    expect(publisher.broadcast).toHaveBeenCalledTimes(4);
    test.host.dispose();
    test.changes[0]!();
    expect(publisher.broadcast).toHaveBeenCalledTimes(4);
  });
});

describe("preview native tab capture", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("captures only the requested tab video and closes every returned track", async () => {
    const video = { stop: vi.fn(), getSettings: () => ({ width: 1800, height: 2000 }) };
    const extra = { stop: vi.fn() };
    const getUserMedia = vi.fn(async () => ({
      getVideoTracks: () => [video],
      getTracks: () => [video, extra],
    }));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const captured = await capturePreviewTab({
      sourceId: "request-bound-tab-source",
      width: 900,
      height: 1000,
      devicePixelRatio: 2,
    });
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: "request-bound-tab-source",
          maxWidth: 1800,
          maxHeight: 2000,
          maxFrameRate: 30,
        },
      },
    });
    expect(captured.track).toBe(video);
    captured.close();
    expect(video.stop).toHaveBeenCalledOnce();
    expect(extra.stop).toHaveBeenCalledOnce();
  });

  it("closes a malformed capture that returns no video track", async () => {
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: async () => ({ getVideoTracks: () => [], getTracks: () => [track] }),
      },
    });
    await expect(
      capturePreviewTab({ sourceId: "source", width: 900, height: 1000, devicePixelRatio: 2 }),
    ).rejects.toThrow("no video track");
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("rejects padded square capture instead of forwarding clicks into letterbox bars", async () => {
    const track = { stop: vi.fn(), getSettings: () => ({ width: 2560, height: 2560 }) };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: async () => ({ getVideoTracks: () => [track], getTracks: () => [track] }),
      },
    });
    await expect(
      capturePreviewTab({ sourceId: "source", width: 900, height: 1000, devicePixelRatio: 2 }),
    ).rejects.toThrow("aspect ratio");
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it.each([
    { width: 900, height: 1000, devicePixelRatio: 2 },
    { width: 7680, height: 4320, devicePixelRatio: 2 },
    { width: 500, height: 2000, devicePixelRatio: 3 },
  ])("bounds capture pixels while retaining the source aspect ratio: %o", (source) => {
    const size = previewCaptureSize(source);
    expect(size.width).toBeLessThanOrEqual(2560);
    expect(size.height).toBeLessThanOrEqual(2560);
    expect(size.width * size.height).toBeLessThanOrEqual(2560 * 1600);
    expect(Math.abs(size.width - (size.height * source.width) / source.height)).toBeLessThanOrEqual(
      2,
    );
  });
});
