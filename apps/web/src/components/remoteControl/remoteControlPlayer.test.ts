import { describe, expect, it } from "vite-plus/test";

import {
  bufferedDrift,
  liveEdgeSeekTarget,
  LIVE_EDGE_MAX_DRIFT_SECONDS,
  LIVE_EDGE_TARGET_LAG_SECONDS,
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
