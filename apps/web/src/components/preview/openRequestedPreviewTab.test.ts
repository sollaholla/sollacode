import type { PreviewOpenInput, PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { resetPreviewStateForTests } from "~/previewStateStore";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

import { openRequestedPreviewTab } from "./openRequestedPreviewTab";

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};

const snapshot: PreviewSessionSnapshot = {
  threadId: threadRef.threadId,
  tabId: "tab-new",
  navStatus: { _tag: "Loading", url: "https://example.com/next", title: "" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-08-25T12:00:00.000Z",
};

beforeEach(() => {
  resetPreviewStateForTests();
  useRightPanelStore.setState({ byThreadKey: {}, pendingSideChatSpawnsByThreadKey: {} });
});

describe("openRequestedPreviewTab", () => {
  it("opens and selects a sibling tab in the source thread", async () => {
    const open = vi.fn(async (_input: PreviewOpenInput) => AsyncResult.success(snapshot));

    const outcome = await openRequestedPreviewTab({
      sourceRuntimeTabId: "runtime-source",
      url: "https://example.com/next",
      sessions: [{ runtimeTabId: "runtime-source", threadRef }],
      openPreview: ({ input }) => open(input),
    });

    expect(outcome).toBe("opened");
    expect(open).toHaveBeenCalledWith({
      threadId: "thread-1",
      url: "https://example.com/next",
    });
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef),
    ).toMatchObject({
      isOpen: true,
      activeSurfaceId: "browser:tab-new",
    });
  });

  it("does not create a tab when the source runtime tab is stale", async () => {
    const open = vi.fn();

    const outcome = await openRequestedPreviewTab({
      sourceRuntimeTabId: "missing",
      url: "https://example.com/next",
      sessions: [{ runtimeTabId: "runtime-source", threadRef }],
      openPreview: open,
    });

    expect(outcome).toBe("source-missing");
    expect(open).not.toHaveBeenCalled();
  });
});
