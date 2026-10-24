import type {
  PreviewRemoteSnapshotResult,
  PreviewRemoteSnapshotUnchangedResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergeRemoteSnapshot, remoteSnapshotRequest } from "./remoteFrame.ts";

const full = (overrides: Record<string, unknown> = {}): PreviewRemoteSnapshotResult =>
  ({
    tabId: "tab-1",
    url: "https://example.com/",
    title: "Example",
    loading: false,
    capturedAt: "t0",
    screenshot: { mimeType: "image/jpeg", data: "AAAA", width: 10, height: 5 },
    frameId: "frame-a",
    ...overrides,
  }) as unknown as PreviewRemoteSnapshotResult;

const unchanged = (overrides: Record<string, unknown> = {}): PreviewRemoteSnapshotUnchangedResult =>
  ({
    unchanged: true,
    tabId: "tab-1",
    url: "https://example.com/",
    title: "Example",
    loading: false,
    capturedAt: "t1",
    frameId: "frame-a",
    ...overrides,
  }) as unknown as PreviewRemoteSnapshotUnchangedResult;

const base = { threadId: "thread-1", tabId: "tab-1" } as never;

describe("remoteSnapshotRequest", () => {
  it("names the held frame of the same tab so the server can skip the picture", () => {
    expect(remoteSnapshotRequest(base, full())).toEqual({
      ...(base as object),
      unchangedSince: "frame-a",
    });
  });

  it("asks for a frame outright when nothing is held, or the held one is another tab's", () => {
    expect(remoteSnapshotRequest(base, null)).toEqual(base);
    expect(remoteSnapshotRequest(base, full({ tabId: "tab-2" }))).toEqual(base);
  });

  it("asks for a frame outright when the held one predates frame ids", () => {
    const { frameId: _drop, ...legacy } = full() as unknown as Record<string, unknown>;
    expect(remoteSnapshotRequest(base, legacy as unknown as PreviewRemoteSnapshotResult)).toEqual(
      base,
    );
  });
});

describe("mergeRemoteSnapshot", () => {
  it("replaces the held frame with a full one", () => {
    const next = full({
      frameId: "frame-b",
      screenshot: { mimeType: "image/jpeg", data: "BBBB", width: 10, height: 5 },
    });
    expect(mergeRemoteSnapshot(full(), next)).toBe(next);
    expect(mergeRemoteSnapshot(null, next)).toBe(next);
  });

  it("keeps the held picture and takes everything else from an unchanged answer", () => {
    const held = full();
    const merged = mergeRemoteSnapshot(
      held,
      unchanged({
        url: "https://example.com/next",
        title: "Next",
        capturedAt: "t2",
        agentPointer: { x: 1, y: 2 },
      }),
    )!;
    expect(merged.screenshot).toBe(held.screenshot);
    expect(merged).toMatchObject({
      url: "https://example.com/next",
      title: "Next",
      capturedAt: "t2",
      agentPointer: { x: 1, y: 2 },
      frameId: "frame-a",
    });
    expect("unchanged" in merged).toBe(false);
  });

  it("drops an unchanged answer for a picture the viewer no longer holds", () => {
    const held = full({ frameId: "frame-b" });
    expect(mergeRemoteSnapshot(held, unchanged({ frameId: "frame-a" }))).toBe(held);
    expect(mergeRemoteSnapshot(held, unchanged({ frameId: "frame-b", tabId: "tab-2" }))).toBe(held);
    expect(mergeRemoteSnapshot(null, unchanged())).toBeNull();
  });
});
