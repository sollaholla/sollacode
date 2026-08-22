import { describe, expect, it } from "vite-plus/test";

import { resolveRemoteControlSurface } from "./remoteControlSurfaceState";

const base = {
  isApproved: true,
  videoMimeType: null,
  videoUnavailable: null,
  frameData: null,
  hasRenderedFrame: false,
} as const;

describe("resolveRemoteControlSurface", () => {
  it("shows nothing before the host approves", () => {
    expect(resolveRemoteControlSurface({ ...base, isApproved: false })).toEqual({
      showSurface: false,
      media: "none",
      showLoadingOverlay: false,
    });
  });

  it("mounts the surface as soon as the session is approved, before any frame", () => {
    const state = resolveRemoteControlSurface(base);

    expect(state.showSurface).toBe(true);
    expect(state.media).toBe("none");
    expect(state.showLoadingOverlay).toBe(true);
  });

  it("prefers video while it is still viable", () => {
    expect(
      resolveRemoteControlSurface({
        ...base,
        videoMimeType: 'video/mp4; codecs="avc1.42E01E"',
        frameData: "data:image/jpeg;base64,AAAA",
      }).media,
    ).toBe("video");
  });

  it("falls back to image frames once video is ruled out", () => {
    expect(
      resolveRemoteControlSurface({
        ...base,
        videoMimeType: 'video/mp4; codecs="avc1.42E01E"',
        videoUnavailable: "No video decoded from the host after 5s.",
        frameData: "data:image/jpeg;base64,AAAA",
        hasRenderedFrame: true,
      }).media,
    ).toBe("image");
  });

  // The invariant this module exists for. Between video giving up and the first
  // JPEG landing there is nothing to paint, and unmounting the surface there
  // would drop full screen and pointer lock during a transition the user is
  // meant not to notice.
  it("keeps the surface mounted through the gap between video and the first frame", () => {
    const midFallback = resolveRemoteControlSurface({
      ...base,
      videoMimeType: 'video/mp4; codecs="avc1.42E01E"',
      videoUnavailable: "No video decoded from the host after 5s.",
      frameData: null,
      hasRenderedFrame: true,
    });

    expect(midFallback.showSurface).toBe(true);
    expect(midFallback.media).toBe("none");
  });

  it("keeps loading over received image bytes until the browser decodes them", () => {
    const receivedButNotDecoded = resolveRemoteControlSurface({
      ...base,
      frameData: "data:image/jpeg;base64,AAAA",
    });

    expect(receivedButNotDecoded.media).toBe("image");
    expect(receivedButNotDecoded.showLoadingOverlay).toBe(true);
  });

  it("drops the overlay once anything has painted, by either path", () => {
    expect(
      resolveRemoteControlSurface({ ...base, videoMimeType: "video/mp4", hasRenderedFrame: true })
        .showLoadingOverlay,
    ).toBe(false);
    expect(
      resolveRemoteControlSurface({
        ...base,
        frameData: "data:image/jpeg;base64,AAAA",
        hasRenderedFrame: true,
      }).showLoadingOverlay,
    ).toBe(false);
  });
});
