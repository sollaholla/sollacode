import type { ScopedThreadRef } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const previewStateMocks = vi.hoisted(() => ({ setActivePreviewTab: vi.fn() }));
const rightPanelMocks = vi.hoisted(() => ({ openBrowser: vi.fn() }));
const miniPlayerMocks = vi.hoisted(() => ({ close: vi.fn() }));

vi.mock("~/previewStateStore", () => previewStateMocks);
vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: { getState: () => rightPanelMocks },
}));
vi.mock("~/previewMiniPlayerStore", () => ({
  usePreviewMiniPlayerStore: { getState: () => miniPlayerMocks },
}));

import { presentPreviewAutomationTab } from "./presentPreviewAutomationTab";

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-pawstalgia" as ScopedThreadRef["threadId"],
};

describe("presentPreviewAutomationTab", () => {
  it("selects the tab in the Browser panel instead of leaving it in a hidden mini-player", () => {
    presentPreviewAutomationTab(threadRef, "tab_5d2ab3a4");

    expect(previewStateMocks.setActivePreviewTab).toHaveBeenCalledWith(threadRef, "tab_5d2ab3a4");
    expect(rightPanelMocks.openBrowser).toHaveBeenCalledWith(threadRef, "tab_5d2ab3a4");
    expect(miniPlayerMocks.close).toHaveBeenCalledWith(threadRef);
  });
});
