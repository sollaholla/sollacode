import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  PreviewTabId,
  ThreadId,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { BrowserSurfacePresentation } from "~/browser/browserSurfaceStore";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import type { ThreadPreviewState } from "~/previewStateStore";

import { resolvePreviewAutomationThreadTarget } from "./previewAutomationThreadTarget";

const environmentId = EnvironmentId.make("environment-1");
const requestThreadRef = scopeThreadRef(environmentId, ThreadId.make("thread-request"));
const visibleThreadRef = scopeThreadRef(environmentId, ThreadId.make("thread-visible"));
const otherEnvironmentThreadRef = scopeThreadRef(
  EnvironmentId.make("environment-2"),
  ThreadId.make("thread-foreign"),
);

const snapshot = (tabId: string): PreviewSessionSnapshot => ({
  threadId: "thread-owner",
  tabId: PreviewTabId.make(tabId),
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  viewport: { _tag: "fill" },
  updatedAt: "2026-08-27T00:00:00.000Z",
});

const state = (tabId: string): ThreadPreviewState => {
  const session = snapshot(tabId);
  return {
    snapshot: session,
    sessions: { [session.tabId]: session },
    suppressedTabIds: new Set(),
    activeTabId: session.tabId,
    desktopOverlay: null,
    desktopByTabId: {},
    recentlySeenUrls: [],
    serverEpoch: "epoch-1",
    serverRevision: 1,
  };
};

const presentation = (
  overrides: Partial<BrowserSurfacePresentation> = {},
): BrowserSurfacePresentation => ({
  rect: { x: 0, y: 0, width: 800, height: 600 },
  visible: true,
  audible: true,
  interactive: true,
  content: null,
  fittedSourceContent: null,
  fitSourceContent: false,
  cornerRadius: 0,
  updatedAt: 1,
  owner: null,
  ...overrides,
});

describe("resolvePreviewAutomationThreadTarget", () => {
  it("uses an explicitly or persistently selected tab across thread ownership", () => {
    const visibleState = state("tab-visible");
    expect(
      resolvePreviewAutomationThreadTarget({
        environmentId,
        requestThreadRef,
        requestedTabId: PreviewTabId.make("tab-visible"),
        previewByThreadKey: { [scopedThreadKey(visibleThreadRef)]: visibleState },
        presentationsByRuntimeTabId: {},
      }),
    ).toEqual(visibleThreadRef);
  });

  it("defaults a fresh agent to the visible interactive browser in its environment", () => {
    const visibleState = state("tab-visible");
    const foreignState = state("tab-foreign");
    expect(
      resolvePreviewAutomationThreadTarget({
        environmentId,
        requestThreadRef,
        requestedTabId: undefined,
        previewByThreadKey: {
          [scopedThreadKey(visibleThreadRef)]: visibleState,
          [scopedThreadKey(otherEnvironmentThreadRef)]: foreignState,
        },
        presentationsByRuntimeTabId: {
          [previewRuntimeTabId(visibleThreadRef, visibleState.serverEpoch, "tab-visible")]:
            presentation(),
          [previewRuntimeTabId(otherEnvironmentThreadRef, foreignState.serverEpoch, "tab-foreign")]:
            presentation({ updatedAt: 2 }),
        },
      }),
    ).toEqual(visibleThreadRef);
  });

  it("prefers the interactive panel over a newer visible thumbnail", () => {
    const panelState = state("tab-panel");
    const thumbnailThreadRef = scopeThreadRef(environmentId, ThreadId.make("thread-thumbnail"));
    const thumbnailState = state("tab-thumbnail");
    expect(
      resolvePreviewAutomationThreadTarget({
        environmentId,
        requestThreadRef,
        requestedTabId: undefined,
        previewByThreadKey: {
          [scopedThreadKey(visibleThreadRef)]: panelState,
          [scopedThreadKey(thumbnailThreadRef)]: thumbnailState,
        },
        presentationsByRuntimeTabId: {
          [previewRuntimeTabId(visibleThreadRef, panelState.serverEpoch, "tab-panel")]:
            presentation({ interactive: true, updatedAt: 1 }),
          [previewRuntimeTabId(thumbnailThreadRef, thumbnailState.serverEpoch, "tab-thumbnail")]:
            presentation({ interactive: false, updatedAt: 2 }),
        },
      }),
    ).toEqual(visibleThreadRef);
  });

  it("falls back to the requesting thread when no browser is presented", () => {
    expect(
      resolvePreviewAutomationThreadTarget({
        environmentId,
        requestThreadRef,
        requestedTabId: undefined,
        previewByThreadKey: {},
        presentationsByRuntimeTabId: {},
      }),
    ).toEqual(requestThreadRef);
  });
});
