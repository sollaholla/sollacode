import type { PreviewAutomationOpenInput, PreviewSessionSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  previewAutomationOpenNeedsOverlay,
  previewPresentationNotice,
  shouldOpenPreviewMiniPlayer,
} from "./previewAutomationOpenReadiness";

const snapshot = (navStatus: PreviewSessionSnapshot["navStatus"]): PreviewSessionSnapshot => ({
  threadId: "thread-1",
  tabId: "tab-1",
  navStatus,
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-06-26T00:00:00.000Z",
});

describe("preview automation open readiness", () => {
  it("opens the inline preview by default", () => {
    expect(shouldOpenPreviewMiniPlayer({} as PreviewAutomationOpenInput)).toBe(true);
  });

  it("supports explicit opt-out and the legacy show alias", () => {
    expect(shouldOpenPreviewMiniPlayer({ open: false } as PreviewAutomationOpenInput)).toBe(false);
    expect(shouldOpenPreviewMiniPlayer({ show: false } as PreviewAutomationOpenInput)).toBe(false);
    expect(
      shouldOpenPreviewMiniPlayer({ open: true, show: false } as PreviewAutomationOpenInput),
    ).toBe(true);
  });

  it("does not wait for a desktop overlay when opening an empty tab", () => {
    expect(
      previewAutomationOpenNeedsOverlay(
        {} as PreviewAutomationOpenInput,
        snapshot({ _tag: "Idle" }),
      ),
    ).toBe(false);
  });

  it("waits when an empty tab is immediately given a URL", () => {
    expect(
      previewAutomationOpenNeedsOverlay(
        { url: "https://example.com" } as PreviewAutomationOpenInput,
        snapshot({ _tag: "Idle" }),
      ),
    ).toBe(true);
  });

  it("waits for existing tabs that already have rendered content", () => {
    expect(
      previewAutomationOpenNeedsOverlay(
        {} as PreviewAutomationOpenInput,
        snapshot({
          _tag: "Success",
          url: "https://example.com/",
          title: "Example",
        }),
      ),
    ).toBe(true);
  });
});

describe("previewPresentationNotice", () => {
  it("says a not-on-screen tab is still driveable", () => {
    const notice = previewPresentationNotice({ requestedPresentation: true, visible: false });
    expect(notice).toContain("not a blocker");
    expect(notice).toContain("nothing went wrong");
    expect(notice).toContain("keep driving this tab");
  });

  it("stays silent when the tab is presented or presentation was not requested", () => {
    expect(previewPresentationNotice({ requestedPresentation: true, visible: true })).toBe("");
    expect(previewPresentationNotice({ requestedPresentation: false, visible: false })).toBe("");
  });
});
