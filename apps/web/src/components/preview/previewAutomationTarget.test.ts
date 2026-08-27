import type { PreviewSessionSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  findPreviewAutomationDomainTabs,
  needsPreviewAutomationSessionSync,
  previewAutomationDomainKey,
  resolvePreviewAutomationClosePlan,
  resolvePreviewAutomationOpenTab,
  resolvePreviewAutomationTarget,
} from "./previewAutomationTarget";

const snapshot = (
  tabId: string,
  navStatus: PreviewSessionSnapshot["navStatus"] = { _tag: "Idle" },
): PreviewSessionSnapshot => ({
  threadId: "thread-1",
  tabId,
  navStatus,
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("preview automation target selection", () => {
  it("refreshes authoritative sessions whenever the caller relies on the active tab", () => {
    const active = snapshot("tab-active");
    expect(
      needsPreviewAutomationSessionSync(
        { snapshot: active, sessions: { [active.tabId]: active } },
        undefined,
      ),
    ).toBe(true);
  });

  it("refreshes an explicit tab only when it is absent locally", () => {
    const active = snapshot("tab-active");
    const state = { snapshot: active, sessions: { [active.tabId]: active } };
    expect(needsPreviewAutomationSessionSync(state, active.tabId)).toBe(false);
    expect(needsPreviewAutomationSessionSync(state, "tab-missing")).toBe(true);
  });

  it("does not report the active tab under an unknown requested tab id", () => {
    const active = snapshot("tab-active");
    expect(
      resolvePreviewAutomationTarget(
        { snapshot: active, sessions: { [active.tabId]: active } },
        "tab-missing",
      ),
    ).toEqual({ tabId: null, snapshot: null });
  });

  it("can address a retained hosted guest while server metadata reconnects", () => {
    const hosted = snapshot("tab-hosted", {
      _tag: "Success",
      url: "https://example.com/",
      title: "Example",
    });

    expect(
      resolvePreviewAutomationTarget(
        { snapshot: null, sessions: {}, hostedSessions: { [hosted.tabId]: hosted } },
        hosted.tabId,
      ),
    ).toEqual({ tabId: hosted.tabId, snapshot: hosted });
    expect(
      findPreviewAutomationDomainTabs(
        { snapshot: null, sessions: {}, hostedSessions: { [hosted.tabId]: hosted } },
        "https://example.com/account",
      ),
    ).toEqual([
      {
        tabId: hosted.tabId,
        url: "https://example.com/",
        title: "Example",
        loading: false,
      },
    ]);
  });

  it("treats a tab missing from the authoritative close snapshot as already closed", () => {
    const active = snapshot("tab-active");
    expect(
      resolvePreviewAutomationClosePlan(
        { snapshot: active, sessions: { [active.tabId]: active } },
        "tab-closed-elsewhere",
      ),
    ).toEqual({ outcome: "already-closed", activeTabId: active.tabId });
  });

  it("counts authoritative pre-close tabs so a preexisting blank survivor is not a replacement", () => {
    const active = snapshot("tab-active", {
      _tag: "Success",
      url: "https://example.com/",
      title: "Example",
    });
    const blank = snapshot("tab-blank");

    expect(
      resolvePreviewAutomationClosePlan(
        {
          snapshot: active,
          sessions: { [active.tabId]: active, [blank.tabId]: blank },
        },
        active.tabId,
      ),
    ).toEqual({ outcome: "close", snapshot: active, previousSessionCount: 2 });
  });

  it("reuses the provider session's pinned tab instead of the mutable UI tab", () => {
    const uiActive = snapshot("tab-ui-active");
    const agentTab = snapshot("tab-opened-by-agent");
    const state = {
      snapshot: uiActive,
      sessions: { [uiActive.tabId]: uiActive, [agentTab.tabId]: agentTab },
    };

    expect(resolvePreviewAutomationOpenTab(state, agentTab.tabId, true)).toBe(agentTab.tabId);
    expect(resolvePreviewAutomationOpenTab(state, undefined, true)).toBe(uiActive.tabId);
    expect(resolvePreviewAutomationOpenTab(state, agentTab.tabId, false)).toBeNull();
  });

  it("reuses a retained hosted tab instead of creating a duplicate during reconnect", () => {
    const hosted = snapshot("tab-hosted");
    const state = {
      snapshot: null,
      sessions: {},
      hostedSessions: { [hosted.tabId]: hosted },
    };

    expect(resolvePreviewAutomationOpenTab(state, undefined, true, hosted.tabId)).toBe(
      hosted.tabId,
    );
    expect(resolvePreviewAutomationOpenTab(state, hosted.tabId, true)).toBe(hosted.tabId);
    expect(resolvePreviewAutomationOpenTab(state, undefined, false, hosted.tabId)).toBeNull();
  });

  it("matches public domains after removing www while keeping subdomains distinct", () => {
    expect(previewAutomationDomainKey("https://www.YouTube.com/watch?v=1")).toBe("youtube.com");
    expect(previewAutomationDomainKey("https://youtube.com/results")).toBe("youtube.com");
    expect(previewAutomationDomainKey("https://studio.youtube.com/video/1")).toBe(
      "studio.youtube.com",
    );
  });

  it("keeps loopback ports distinct", () => {
    expect(previewAutomationDomainKey("http://localhost:3000/a")).toBe("localhost:3000");
    expect(previewAutomationDomainKey("http://localhost:5173/b")).toBe("localhost:5173");
    expect(previewAutomationDomainKey("http://127.0.0.2:3000/a")).toBe("127.0.0.2:3000");
    expect(previewAutomationDomainKey("file:///tmp/index.html")).toBeNull();
  });

  it("lists every allocated matching-domain tab but excludes blank and other subdomains", () => {
    const matchingLoading = snapshot("tab-b", {
      _tag: "Loading",
      url: "https://www.youtube.com/results?q=oldies",
      title: "YouTube results",
    });
    const matchingFailed = snapshot("tab-a", {
      _tag: "LoadFailed",
      url: "https://youtube.com/watch?v=1",
      title: "YouTube",
      code: -1,
      description: "offline",
    });
    const studio = snapshot("tab-studio", {
      _tag: "Success",
      url: "https://studio.youtube.com/",
      title: "YouTube Studio",
    });
    const blank = snapshot("tab-blank");

    expect(
      findPreviewAutomationDomainTabs(
        {
          snapshot: matchingLoading,
          sessions: {
            [matchingLoading.tabId]: matchingLoading,
            [matchingFailed.tabId]: matchingFailed,
            [studio.tabId]: studio,
            [blank.tabId]: blank,
          },
        },
        "https://youtube.com/",
      ),
    ).toEqual([
      {
        tabId: "tab-a",
        url: "https://youtube.com/watch?v=1",
        title: "YouTube",
        loading: false,
      },
      {
        tabId: "tab-b",
        url: "https://www.youtube.com/results?q=oldies",
        title: "YouTube results",
        loading: true,
      },
    ]);
  });
});
