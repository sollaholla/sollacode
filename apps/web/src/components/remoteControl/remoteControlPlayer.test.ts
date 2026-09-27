import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  bufferedDrift,
  liveEdgeSeekTarget,
  LIVE_EDGE_MAX_DRIFT_SECONDS,
  LIVE_EDGE_TARGET_LAG_SECONDS,
  createRemoteControlVideoSink,
  VIDEO_MAX_QUEUED_BYTES,
  VIDEO_MAX_QUEUED_CHUNKS,
} from "./remoteControlPlayer";
import { selectRemoteControlMimeType } from "./remoteControlEncoder";

function buffered(ranges: ReadonlyArray<number>) {
  return {
    length: ranges.length,
    end: (index: number) => ranges[index] ?? 0,
  };
}

describe("bufferedDrift", () => {
  it("reports how far the buffer leads the playhead, and null when empty", () => {
    expect(bufferedDrift(buffered([]), 0)).toBeNull();
    expect(bufferedDrift(buffered([10]), 9.5)).toBeCloseTo(0.5);
    // Only the newest range matters — earlier ones are already played out.
    expect(bufferedDrift(buffered([2, 10]), 9)).toBeCloseTo(1);
  });
});

function installVideoStandIns() {
  class Buffer extends EventTarget {
    updating = false;
    oldest = 0;
    newest = 0;
    buffered = {
      length: 1,
      start: () => this.oldest,
      end: () => this.newest,
    };
    appendBuffer = vi.fn(() => {
      this.updating = true;
    });
    remove = vi.fn((_start: number, end: number) => {
      this.oldest = end;
      this.updating = true;
    });
    complete() {
      this.updating = false;
      this.dispatchEvent(new Event("updateend"));
    }
  }
  const buffer = new Buffer();
  const media = new EventTarget();
  vi.stubGlobal(
    "MediaSource",
    class {
      static isTypeSupported() {
        return true;
      }
      constructor() {
        return Object.assign(media, {
          readyState: "open",
          addSourceBuffer: () => buffer,
          endOfStream: vi.fn(),
        });
      }
    },
  );
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test-stream");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const video = Object.assign(new EventTarget(), {
    currentTime: 0,
    buffered: buffer.buffered,
    paused: false,
    play: vi.fn(() => Promise.resolve()),
    pause: vi.fn(),
    removeAttribute: vi.fn(),
    load: vi.fn(),
  });
  return { buffer, media, video, revoke };
}

describe("remote video resource lifetime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("bounds queued chunks when MediaSource never opens and reports failure only once", () => {
    const { video } = installVideoStandIns();
    const error = vi.fn();
    const sink = createRemoteControlVideoSink(
      "video/webm",
      video as unknown as HTMLVideoElement,
      error,
    )!;
    for (let i = 0; i < VIDEO_MAX_QUEUED_CHUNKS + 100; i++) {
      sink.append({ data: "AAEC", isInit: i === 0 });
    }
    expect(sink.stats().queued).toBe(0);
    expect(error).toHaveBeenCalledOnce();
    sink.dispose();
  });

  it("rejects an oversized encoded chunk before allocating its decoded bytes", () => {
    const { video } = installVideoStandIns();
    const decode = vi.spyOn(globalThis, "atob");
    const error = vi.fn();
    const sink = createRemoteControlVideoSink(
      "video/webm",
      video as unknown as HTMLVideoElement,
      error,
    )!;
    sink.append({
      data: "A".repeat(Math.ceil((VIDEO_MAX_QUEUED_BYTES * 4) / 3) + 4),
      isInit: true,
    });
    expect(decode).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
    expect(sink.stats().queued).toBe(0);
    sink.dispose();
  });

  it("trims played history during a long session while continuing to append", () => {
    const { video, media, buffer } = installVideoStandIns();
    const error = vi.fn();
    const sink = createRemoteControlVideoSink(
      "video/webm",
      video as unknown as HTMLVideoElement,
      error,
    )!;
    media.dispatchEvent(new Event("sourceopen"));
    for (let second = 0; second < 1800; second++) {
      video.currentTime = second;
      buffer.newest = second + 0.1;
      sink.append({ data: "AAEC", isInit: second === 0 });
      // Removal and append each emit their own completion receipt.
      while (buffer.updating) buffer.complete();
      expect(video.currentTime - buffer.oldest).toBeLessThan(15);
    }
    expect(buffer.appendBuffer).toHaveBeenCalledTimes(1800);
    expect(buffer.remove).toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    sink.dispose();
  });

  it("releases the media element and ignores late events after disposal", () => {
    const { video, media, buffer, revoke } = installVideoStandIns();
    const sink = createRemoteControlVideoSink("video/webm", video as unknown as HTMLVideoElement)!;
    sink.append({ data: "AAEC", isInit: true });
    sink.dispose();
    sink.dispose();
    media.dispatchEvent(new Event("sourceopen"));
    buffer.complete();
    expect(buffer.appendBuffer).not.toHaveBeenCalled();
    expect(video.pause).toHaveBeenCalledOnce();
    expect(video.removeAttribute).toHaveBeenCalledWith("src");
    expect(video.load).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:test-stream");
  });

  it.each(["buffer", "video"] as const)(
    "recovers from an asynchronous %s error after the first frame without awaiting another chunk",
    (target) => {
      const { video, media, buffer } = installVideoStandIns();
      const error = vi.fn();
      const sink = createRemoteControlVideoSink(
        "video/webm",
        video as unknown as HTMLVideoElement,
        error,
      )!;
      media.dispatchEvent(new Event("sourceopen"));
      sink.append({ data: "AAEC", isInit: true });
      buffer.complete();
      sink.append({ data: "AAEC", isInit: false });
      sink.append({ data: "AAEC", isInit: false });
      expect(sink.stats().queued).toBe(1);
      const emitter = target === "buffer" ? buffer : video;
      emitter.dispatchEvent(new Event("error"));
      expect(error).toHaveBeenCalledOnce();
      expect(sink.stats().queued).toBe(0);
      buffer.complete();
      expect(buffer.appendBuffer).toHaveBeenCalledTimes(2);
      sink.dispose();
      emitter.dispatchEvent(new Event("error"));
      expect(error).toHaveBeenCalledOnce();
    },
  );
});

describe("liveEdgeSeekTarget", () => {
  it("leaves playback alone while drift stays within tolerance", () => {
    expect(liveEdgeSeekTarget(buffered([]), 0)).toBeNull();
    expect(liveEdgeSeekTarget(buffered([10]), 10)).toBeNull();
    expect(liveEdgeSeekTarget(buffered([10]), 10 - LIVE_EDGE_MAX_DRIFT_SECONDS + 0.01)).toBeNull();
  });

  it("seeks to just behind the live edge once the buffer runs ahead", () => {
    // Without this the viewer drifts further behind the host the longer it
    // watches, which is the failure mode that makes remote control unusable.
    const target = liveEdgeSeekTarget(buffered([10]), 5);
    expect(target).toBeCloseTo(10 - LIVE_EDGE_TARGET_LAG_SECONDS);
  });

  it("keeps a small lag rather than seeking exactly to the edge", () => {
    // Seeking onto the edge itself starves the decoder and stalls playback.
    const target = liveEdgeSeekTarget(buffered([10]), 5);
    expect(target).toBeLessThan(10);
    expect(LIVE_EDGE_TARGET_LAG_SECONDS).toBeGreaterThan(0);
  });

  it("never seeks to a negative position", () => {
    expect(liveEdgeSeekTarget(buffered([0.02]), -5)).toBe(0);
  });
});

describe("selectRemoteControlMimeType", () => {
  it("prefers VP8, the lowest-latency encoder, over better-compressing codecs", () => {
    expect(selectRemoteControlMimeType(() => true)).toBe("video/webm;codecs=vp8");
  });

  it("falls through to the next supported codec", () => {
    expect(selectRemoteControlMimeType((type) => type !== "video/webm;codecs=vp8")).toBe(
      "video/webm;codecs=vp9",
    );
    expect(selectRemoteControlMimeType((type) => type === "video/mp4;codecs=avc1")).toBe(
      "video/mp4;codecs=avc1",
    );
  });

  it("reports null when nothing is supported so the JPEG path stays in charge", () => {
    expect(selectRemoteControlMimeType(() => false)).toBeNull();
  });
});
