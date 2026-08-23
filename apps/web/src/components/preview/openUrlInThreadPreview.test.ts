import type { PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const previewStateMocks = vi.hoisted(() => ({
  isPreviewSupportedInRuntime: vi.fn(() => true),
  readThreadPreviewState: vi.fn(() => ({ sessions: {} }) as { sessions: Record<string, unknown> }),
  setActivePreviewTab: vi.fn(),
  applyPreviewServerSnapshot: vi.fn(),
  rememberPreviewUrl: vi.fn(),
}));
const rightPanelMocks = vi.hoisted(() => ({ openBrowser: vi.fn() }));

vi.mock("~/previewStateStore", () => previewStateMocks);
vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: { getState: () => rightPanelMocks },
}));

import { findPreviewTabAtUrl, openUrlInThreadPreview } from "./openUrlInThreadPreview";

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};

const sessionAt = (tabId: string, url: string): PreviewSessionSnapshot => ({
  threadId: threadRef.threadId,
  tabId,
  navStatus: { _tag: "Success", url, title: "" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-08-23T00:00:00.000Z",
});

afterEach(() => {
  vi.clearAllMocks();
  previewStateMocks.isPreviewSupportedInRuntime.mockReturnValue(true);
  previewStateMocks.readThreadPreviewState.mockReturnValue({ sessions: {} });
});

describe("findPreviewTabAtUrl", () => {
  it("matches the tab currently at the exact URL, normalized on both sides", () => {
    const sessions = {
      "tab-1": sessionAt("tab-1", "https://studio.youtube.com/"),
      "tab-2": sessionAt("tab-2", "https://accounts.google.com/signin"),
    };
    expect(findPreviewTabAtUrl(sessions, "accounts.google.com/signin")).toBe("tab-2");
  });

  it("does not match tabs that navigated elsewhere, idle tabs, or malformed URLs", () => {
    const sessions = {
      idle: {
        ...sessionAt("idle", ""),
        navStatus: { _tag: "Idle" } as PreviewSessionSnapshot["navStatus"],
      },
      elsewhere: sessionAt("elsewhere", "https://example.com/other"),
    };
    expect(findPreviewTabAtUrl(sessions, "https://example.com/target")).toBeNull();
    expect(findPreviewTabAtUrl(sessions, "not a url")).toBeNull();
  });
});

describe("openUrlInThreadPreview", () => {
  it("focuses an existing tab already at the URL instead of opening a new one", async () => {
    previewStateMocks.readThreadPreviewState.mockReturnValue({
      sessions: { "tab-2": sessionAt("tab-2", "https://accounts.google.com/signin") },
    });
    const openPreview = vi.fn();
    const openExternally = vi.fn();

    const outcome = await openUrlInThreadPreview({
      threadRef,
      url: "https://accounts.google.com/signin",
      openPreview: openPreview as never,
      openExternally,
    });

    expect(outcome).toBe("reused-tab");
    expect(openPreview).not.toHaveBeenCalled();
    expect(previewStateMocks.setActivePreviewTab).toHaveBeenCalledWith(threadRef, "tab-2");
    expect(rightPanelMocks.openBrowser).toHaveBeenCalledWith(threadRef, "tab-2");
    expect(openExternally).not.toHaveBeenCalled();
  });

  it("opens a new preview tab when no tab is at the URL", async () => {
    const snapshot = sessionAt("tab-new", "https://studio.youtube.com/");
    const openPreview = vi.fn(async () => AsyncResult.success(snapshot));
    const openExternally = vi.fn();

    const outcome = await openUrlInThreadPreview({
      threadRef,
      url: "https://studio.youtube.com/",
      openPreview: openPreview as never,
      openExternally,
    });

    expect(outcome).toBe("opened-tab");
    expect(openPreview).toHaveBeenCalledWith({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, url: "https://studio.youtube.com/" },
    });
    expect(rightPanelMocks.openBrowser).toHaveBeenCalledWith(threadRef, "tab-new");
    expect(openExternally).not.toHaveBeenCalled();
  });

  it("falls back to the system browser when preview is unsupported or the open fails", async () => {
    previewStateMocks.isPreviewSupportedInRuntime.mockReturnValue(false);
    const openExternally = vi.fn();
    expect(
      await openUrlInThreadPreview({
        threadRef,
        url: "https://example.com/",
        openPreview: vi.fn() as never,
        openExternally,
      }),
    ).toBe("opened-externally");
    expect(openExternally).toHaveBeenCalledWith("https://example.com/");

    previewStateMocks.isPreviewSupportedInRuntime.mockReturnValue(true);
    const failing = vi.fn(async () => AsyncResult.failure(Cause.fail(new Error("open failed"))));
    expect(
      await openUrlInThreadPreview({
        threadRef,
        url: "https://example.com/",
        openPreview: failing as never,
        openExternally,
      }),
    ).toBe("opened-externally");
    expect(openExternally).toHaveBeenCalledTimes(2);
  });
});
