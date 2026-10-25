import {
  PreviewTabId,
  ThreadId,
  type PreviewRemoteFrameDemand,
  type PreviewRemoteFrameEvent,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createRemoteFrameStreamer } from "./remoteFrameStreamer";
import type { RemoteFrameEncoded } from "./remoteFrameEncoder";

const demand: PreviewRemoteFrameDemand = {
  threadId: ThreadId.make("thread"),
  tabId: PreviewTabId.make("tab"),
  maxWidth: 640,
  maxHeight: 480,
  patches: true,
  keyframeRequest: 0,
};
const encoded: RemoteFrameEncoded = { type: "keyframe", width: 640, height: 480, data: "jpeg" };
const setup = () => {
  vi.useFakeTimers();
  const capture = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
  };
  const encoder = {
    encode: vi.fn(async (): Promise<RemoteFrameEncoded> => encoded),
    reset: vi.fn(),
    drop: vi.fn(),
  };
  const batches: Array<ReadonlyArray<PreviewRemoteFrameEvent>> = [];
  const publish = vi.fn(
    async (_target: unknown, events: ReadonlyArray<PreviewRemoteFrameEvent>) => {
      batches.push(events);
    },
  );
  const streamer = createRemoteFrameStreamer({
    runtimeTabId: () => "runtime-tab",
    capture,
    encoder,
    publish,
    readState: () => null,
    scheduler: {
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
  });
  return { streamer, capture, encoder, publish, batches };
};
afterEach(() => vi.useRealTimers());

describe("remote frame streamer", () => {
  it("does no work without demand and stops capturing after the last viewer leaves", async () => {
    const { streamer, capture, encoder } = setup();
    streamer.frameArrived({ tabId: "runtime-tab", data: "ignored" });
    expect(encoder.encode).not.toHaveBeenCalled();
    streamer.setDemand([demand]);
    await vi.advanceTimersByTimeAsync(0);
    expect(capture.start).toHaveBeenCalledWith("runtime-tab", { maxWidth: 640, maxHeight: 480 });
    streamer.setDemand([]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(capture.stop).toHaveBeenCalledWith("runtime-tab");
    expect(capture.refresh).not.toHaveBeenCalled();
    expect(encoder.drop).toHaveBeenCalled();
  });
  it("satisfies keyframe resync from its cached latest picture even on an idle page", async () => {
    const { streamer, encoder, batches } = setup();
    streamer.setDemand([demand]);
    streamer.frameArrived({ tabId: "runtime-tab", data: "still" });
    await vi.advanceTimersByTimeAsync(50);
    streamer.setDemand([{ ...demand, keyframeRequest: 1 }]);
    await vi.advanceTimersByTimeAsync(50);
    expect(batches).toHaveLength(2);
    expect(encoder.encode).toHaveBeenLastCalledWith("thread\u0000tab", {
      data: "still",
      forceKeyframe: true,
      keyframesOnly: false,
    });
    streamer.dispose();
  });
  it("does not lose a resync request arriving while a keyframe publish is in flight", async () => {
    const { streamer, encoder, publish } = setup();
    let release!: () => void;
    publish.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    streamer.setDemand([demand]);
    streamer.frameArrived({ tabId: "runtime-tab", data: "first" });
    await vi.advanceTimersByTimeAsync(0);
    streamer.setDemand([{ ...demand, keyframeRequest: 1 }]);
    release();
    await vi.advanceTimersByTimeAsync(50);
    expect(encoder.encode).toHaveBeenLastCalledWith("thread\u0000tab", {
      data: "first",
      forceKeyframe: true,
      keyframesOnly: false,
    });
    streamer.dispose();
  });
  it("switches to complete pictures for a native viewer", async () => {
    const { streamer, encoder } = setup();
    streamer.setDemand([{ ...demand, patches: false }]);
    streamer.frameArrived({ tabId: "runtime-tab", data: "phone" });
    await vi.advanceTimersByTimeAsync(0);
    expect(encoder.encode).toHaveBeenCalledWith("thread\u0000tab", {
      data: "phone",
      forceKeyframe: true,
      keyframesOnly: true,
    });
    streamer.dispose();
  });
  it("keeps a shared guest running when its parent or side-chat viewer leaves", async () => {
    const { streamer, capture } = setup();
    const side = { ...demand, threadId: ThreadId.make("side"), maxWidth: 1280 };
    streamer.setDemand([demand, side]);
    await vi.advanceTimersByTimeAsync(0);
    expect(capture.start).toHaveBeenLastCalledWith("runtime-tab", {
      maxWidth: 1280,
      maxHeight: 480,
    });
    streamer.setDemand([demand]);
    await vi.advanceTimersByTimeAsync(0);
    expect(capture.stop).not.toHaveBeenCalled();
    expect(capture.start).toHaveBeenLastCalledWith("runtime-tab", {
      maxWidth: 640,
      maxHeight: 480,
    });
    streamer.setDemand([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(capture.stop).toHaveBeenCalledTimes(1);
  });
  it("falls back on capture loss and resumes with a complete frame", async () => {
    const { streamer, batches, encoder } = setup();
    streamer.setDemand([demand]);
    streamer.frameArrived({ tabId: "runtime-tab", data: "first" });
    await vi.advanceTimersByTimeAsync(50);
    streamer.frameArrived({ tabId: "runtime-tab", unavailable: "detached" });
    await vi.advanceTimersByTimeAsync(50);
    expect(batches.at(-1)).toEqual([{ type: "unavailable", reason: "detached" }]);
    streamer.frameArrived({ tabId: "runtime-tab", data: "restored" });
    await vi.advanceTimersByTimeAsync(50);
    expect(encoder.encode).toHaveBeenLastCalledWith("thread\u0000tab", {
      data: "restored",
      forceKeyframe: true,
      keyframesOnly: false,
    });
    streamer.dispose();
  });
});
