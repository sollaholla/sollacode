import type { PreviewRemoteFrameEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  REMOTE_FRAME_STREAM_GRACE_MS,
  planRemoteFrameEvents,
  remoteFrameRequestSize,
  remoteFrameShouldPoll,
} from "./remoteFrameFeed.ts";

const keyframe = (sequence: number): PreviewRemoteFrameEvent => ({
  type: "keyframe",
  sequence,
  width: 1170,
  height: 1300,
  mimeType: "image/jpeg",
  data: `key-${sequence}`,
});

const patch = (sequence: number, after: number): PreviewRemoteFrameEvent => ({
  type: "patch",
  sequence,
  after,
  width: 1170,
  height: 1300,
  mimeType: "image/jpeg",
  patches: [{ x: 0, y: 0, width: 32, height: 32, data: `patch-${sequence}` }],
});

const state: PreviewRemoteFrameEvent = {
  type: "state",
  state: { url: "https://example.com/", title: "Example", loading: false },
};

describe("remoteFrameRequestSize", () => {
  it("asks for the box in device pixels, rounded up to a step", () => {
    expect(remoteFrameRequestSize({ boxWidth: 390, boxHeight: 700, devicePixelRatio: 3 })).toEqual({
      maxWidth: 1280,
      maxHeight: 2176,
    });
  });

  it("asks for more pixels while the viewer is zoomed in, within bounds", () => {
    expect(
      remoteFrameRequestSize({ boxWidth: 390, boxHeight: 700, devicePixelRatio: 3, zoom: 2 }),
    ).toEqual({ maxWidth: 2432, maxHeight: 2560 });
    expect(remoteFrameRequestSize({ boxWidth: 10, boxHeight: 10, devicePixelRatio: 1 })).toEqual({
      maxWidth: 256,
      maxHeight: 256,
    });
  });

  it("does not move for small layout changes", () => {
    const before = remoteFrameRequestSize({ boxWidth: 390, boxHeight: 700, devicePixelRatio: 3 });
    const after = remoteFrameRequestSize({ boxWidth: 391, boxHeight: 702, devicePixelRatio: 3 });
    expect(after).toEqual(before);
  });
});

describe("planRemoteFrameEvents", () => {
  it("draws a keyframe and the patches after it, in order", () => {
    const batch = planRemoteFrameEvents(null, [state, keyframe(4), patch(5, 4), patch(6, 5)]);
    expect(batch.draws.map((draw) => draw.event.sequence)).toEqual([4, 5, 6]);
    expect(batch.held).toEqual({ sequence: 6, width: 1170, height: 1300 });
    expect(batch.state?.title).toBe("Example");
    expect(batch.resync).toBe(false);
  });

  it("skips pictures a later keyframe in the same batch covers", () => {
    const batch = planRemoteFrameEvents(null, [keyframe(1), patch(2, 1), keyframe(3)]);
    expect(batch.draws.map((draw) => draw.event.sequence)).toEqual([3]);
  });

  it("asks to resync when a patch does not follow the held picture", () => {
    const batch = planRemoteFrameEvents({ sequence: 7, width: 1170, height: 1300 }, [patch(9, 8)]);
    expect(batch.resync).toBe(true);
    expect(batch.draws).toEqual([]);
  });

  it("ignores patches for a viewer that only draws keyframes", () => {
    const batch = planRemoteFrameEvents(null, [keyframe(1), patch(2, 1)], { patches: false });
    expect(batch.draws.map((draw) => draw.kind)).toEqual(["keyframe"]);
    expect(batch.held?.sequence).toBe(1);
    expect(batch.resync).toBe(false);
  });

  it("reports the stream unavailable until a picture arrives", () => {
    expect(
      planRemoteFrameEvents(null, [{ type: "unavailable", reason: "no desktop" }]),
    ).toMatchObject({ unavailable: "no desktop" });
    expect(
      planRemoteFrameEvents(null, [{ type: "unavailable", reason: "no desktop" }, keyframe(1)])
        .unavailable,
    ).toBeNull();
  });
});

describe("remoteFrameShouldPoll", () => {
  const base = {
    streamSupported: true,
    subscribedAt: 1_000,
    lastPictureAt: null,
    unavailableAt: null,
  };

  it("polls against servers without the stream", () => {
    expect(remoteFrameShouldPoll({ ...base, streamSupported: false, now: 1_000 })).toBe(true);
  });

  it("waits out the grace period before polling for a silent stream", () => {
    expect(remoteFrameShouldPoll({ ...base, now: 1_000 + REMOTE_FRAME_STREAM_GRACE_MS - 1 })).toBe(
      false,
    );
    expect(remoteFrameShouldPoll({ ...base, now: 1_000 + REMOTE_FRAME_STREAM_GRACE_MS })).toBe(
      true,
    );
  });

  it("polls while unavailable and stops once a newer picture arrives", () => {
    expect(remoteFrameShouldPoll({ ...base, unavailableAt: 1_200, now: 1_300 })).toBe(true);
    expect(
      remoteFrameShouldPoll({ ...base, unavailableAt: 1_200, lastPictureAt: 1_250, now: 1_300 }),
    ).toBe(false);
    expect(remoteFrameShouldPoll({ ...base, lastPictureAt: 1_100, now: 9_000 })).toBe(false);
  });
});
