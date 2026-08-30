import { describe, expect, it } from "vite-plus/test";

import {
  resolveThreadSyncPhase,
  threadSyncBlocksSend,
  threadSyncLabel,
  threadSyncOverlayCopy,
} from "./threadSync";

describe("resolveThreadSyncPhase", () => {
  it("loads when only shell data is available", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: false,
        shellExists: true,
        status: "synchronizing",
      }),
    ).toBe("loading");
  });

  it("syncs when cached detail is already visible", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: "cached",
      }),
    ).toBe("syncing");
  });

  it("does not report a sync phase without a shell or after going live", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: false,
        shellExists: false,
        status: "empty",
      }),
    ).toBeNull();
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: "live",
      }),
    ).toBeNull();
  });
});

describe("threadSyncLabel", () => {
  it("blocks sends only until the bounded detail snapshot exists", () => {
    expect(threadSyncBlocksSend("loading")).toBe(true);
    expect(threadSyncBlocksSend("syncing")).toBe(false);
    expect(threadSyncBlocksSend(null)).toBe(false);
  });

  it("uses the same loading and syncing language as mobile", () => {
    expect(threadSyncLabel("loading")).toBe("Loading messages...");
    expect(threadSyncLabel("syncing")).toBe("Syncing messages...");
  });

  it("explains cold loading and fast-forward catch-up without implying lost context", () => {
    expect(threadSyncOverlayCopy("loading")).toEqual({
      title: "Loading conversation…",
      detail: "Restoring this thread’s messages and working context.",
    });
    expect(threadSyncOverlayCopy("syncing")).toEqual({
      title: "Catching up…",
      detail: "Fast-forwarding to the latest messages. Your conversation context is still here.",
    });
  });
});
