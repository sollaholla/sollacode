import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  AGENTS_PROJECT_ID,
  EnvironmentId,
  PreviewTabId,
  ThreadId,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { BrowserSurfacePresentation } from "~/browser/browserSurfaceStore";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import type { ThreadPreviewState } from "~/previewStateStore";

import {
  canReusePreviewAutomationBrowser,
  isExclusiveAgentBrowserProfile,
  previewAutomationBrowserProfileRoot,
  resolvePreviewAutomationThreadTarget,
  type PreviewAutomationThreadProfile,
} from "./previewAutomationThreadTarget";

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
    hostedSessions: { [session.tabId]: session },
    suppressedTabIds: new Set(),
    activeTabId: session.tabId,
    desktopOverlay: null,
    desktopByTabId: {},
    recentlySeenUrls: [],
    serverEpoch: "epoch-1",
    serverRevision: 1,
    hostSyncGeneration: 0,
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
  it("uses an explicitly or persistently selected tab owned by the requesting thread", () => {
    const ownState = state("tab-own");
    expect(
      resolvePreviewAutomationThreadTarget({
        environmentId,
        requestThreadRef,
        requestedTabId: PreviewTabId.make("tab-own"),
        previewByThreadKey: { [scopedThreadKey(requestThreadRef)]: ownState },
        presentationsByRuntimeTabId: {},
      }),
    ).toEqual({
      threadRef: requestThreadRef,
      tabId: PreviewTabId.make("tab-own"),
    });
  });

  it("reports an explicitly selected tab owned by another thread as foreign", () => {
    // Tab ownership is keyed to the thread, never to a provider session or a
    // visible panel: a tab another thread opened is not usable here even when
    // it is the one on screen.
    const visibleState = state("tab-visible");
    expect(
      resolvePreviewAutomationThreadTarget({
        environmentId,
        requestThreadRef,
        requestedTabId: PreviewTabId.make("tab-visible"),
        previewByThreadKey: { [scopedThreadKey(visibleThreadRef)]: visibleState },
        presentationsByRuntimeTabId: {
          [previewRuntimeTabId(visibleThreadRef, visibleState.serverEpoch, "tab-visible")]:
            presentation(),
        },
      }),
    ).toEqual({
      threadRef: requestThreadRef,
      tabId: undefined,
      foreignAgentTabId: PreviewTabId.make("tab-visible"),
    });
  });

  it("defaults to the requesting thread's visible interactive browser, ignoring other threads and environments", () => {
    const ownState = state("tab-own");
    const visibleState = state("tab-visible");
    const foreignState = state("tab-foreign");
    expect(
      resolvePreviewAutomationThreadTarget({
        environmentId,
        requestThreadRef,
        requestedTabId: undefined,
        previewByThreadKey: {
          [scopedThreadKey(requestThreadRef)]: ownState,
          [scopedThreadKey(visibleThreadRef)]: visibleState,
          [scopedThreadKey(otherEnvironmentThreadRef)]: foreignState,
        },
        presentationsByRuntimeTabId: {
          [previewRuntimeTabId(requestThreadRef, ownState.serverEpoch, "tab-own")]: presentation({
            updatedAt: 1,
          }),
          [previewRuntimeTabId(visibleThreadRef, visibleState.serverEpoch, "tab-visible")]:
            presentation({ updatedAt: 2 }),
          [previewRuntimeTabId(otherEnvironmentThreadRef, foreignState.serverEpoch, "tab-foreign")]:
            presentation({ updatedAt: 3 }),
        },
      }),
    ).toEqual({
      threadRef: requestThreadRef,
      tabId: PreviewTabId.make("tab-own"),
    });
  });

  it("keeps targeting a visible hosted guest while server metadata reconnects", () => {
    const hostedState = state("tab-visible");
    hostedState.sessions = {};
    hostedState.snapshot = null;
    hostedState.activeTabId = null;

    expect(
      resolvePreviewAutomationThreadTarget({
        environmentId,
        requestThreadRef,
        requestedTabId: undefined,
        previewByThreadKey: { [scopedThreadKey(requestThreadRef)]: hostedState },
        presentationsByRuntimeTabId: {
          [previewRuntimeTabId(requestThreadRef, hostedState.serverEpoch, "tab-visible")]:
            presentation(),
        },
      }),
    ).toEqual({
      threadRef: requestThreadRef,
      tabId: PreviewTabId.make("tab-visible"),
    });
  });

  it("prefers the interactive panel over a newer visible thumbnail", () => {
    const panelState = state("tab-panel");
    const thumbnail = snapshot("tab-thumbnail");
    panelState.sessions = { ...panelState.sessions, [thumbnail.tabId]: thumbnail };
    panelState.hostedSessions = { ...panelState.hostedSessions, [thumbnail.tabId]: thumbnail };
    expect(
      resolvePreviewAutomationThreadTarget({
        environmentId,
        requestThreadRef,
        requestedTabId: undefined,
        previewByThreadKey: { [scopedThreadKey(requestThreadRef)]: panelState },
        presentationsByRuntimeTabId: {
          [previewRuntimeTabId(requestThreadRef, panelState.serverEpoch, "tab-panel")]:
            presentation({ interactive: true, updatedAt: 1 }),
          [previewRuntimeTabId(requestThreadRef, panelState.serverEpoch, "tab-thumbnail")]:
            presentation({ interactive: false, updatedAt: 2 }),
        },
      }),
    ).toEqual({
      threadRef: requestThreadRef,
      tabId: PreviewTabId.make("tab-panel"),
    });
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
    ).toEqual({
      threadRef: requestThreadRef,
      tabId: undefined,
    });
  });
});

const agentHome = (threadId: string): PreviewAutomationThreadProfile => ({
  profileRootThreadId: ThreadId.make(threadId),
  exclusiveAgentBrowser: true,
});

describe("canReusePreviewAutomationBrowser", () => {
  it("keeps a custom agent's dedicated browser private from sibling agents", () => {
    expect(isExclusiveAgentBrowserProfile(AGENTS_PROJECT_ID, null)).toBe(true);
    expect(
      previewAutomationBrowserProfileRoot(ThreadId.make("agent-a"), ThreadId.make("agent-a")),
    ).toEqual(ThreadId.make("agent-a"));
    expect(
      canReusePreviewAutomationBrowser({
        requestThreadId: ThreadId.make("agent-veera"),
        ownerThreadId: ThreadId.make("agent-pawstalgia"),
        profiles: {
          "agent-veera": agentHome("agent-veera"),
          "agent-pawstalgia": agentHome("agent-pawstalgia"),
        },
      }),
    ).toBe(false);
  });

  it("does not let a different thread reuse a tab merely because it shares a browser profile", () => {
    expect(
      canReusePreviewAutomationBrowser({
        requestThreadId: ThreadId.make("project-thread"),
        ownerThreadId: ThreadId.make("agent-veera"),
        profiles: {
          "project-thread": {
            profileRootThreadId: ThreadId.make("agent-veera"),
            exclusiveAgentBrowser: false,
          },
          "agent-veera": agentHome("agent-veera"),
        },
      }),
    ).toBe(false);
  });
});

describe("resolvePreviewAutomationThreadTarget agent isolation", () => {
  const veeraRef = scopeThreadRef(environmentId, ThreadId.make("agent-veera"));
  const pawstalgiaRef = scopeThreadRef(environmentId, ThreadId.make("agent-pawstalgia"));
  const profiles = {
    "agent-veera": agentHome("agent-veera"),
    "agent-pawstalgia": agentHome("agent-pawstalgia"),
  };

  it("ignores an explicit tab from another custom agent's dedicated browser", () => {
    const pawstalgiaState = state("tab_70d23993-1e1d-4caf-b190-0265822665c4");
    const veeraState = state("tab-veera-gmail");
    expect(
      resolvePreviewAutomationThreadTarget({
        environmentId,
        requestThreadRef: veeraRef,
        requestedTabId: PreviewTabId.make("tab_70d23993-1e1d-4caf-b190-0265822665c4"),
        previewByThreadKey: {
          [scopedThreadKey(veeraRef)]: veeraState,
          [scopedThreadKey(pawstalgiaRef)]: pawstalgiaState,
        },
        presentationsByRuntimeTabId: {
          [previewRuntimeTabId(veeraRef, veeraState.serverEpoch, "tab-veera-gmail")]: presentation({
            interactive: true,
            updatedAt: 2,
          }),
          [previewRuntimeTabId(
            pawstalgiaRef,
            pawstalgiaState.serverEpoch,
            "tab_70d23993-1e1d-4caf-b190-0265822665c4",
          )]: presentation({ interactive: true, updatedAt: 1 }),
        },
        profiles,
      }),
    ).toEqual({
      threadRef: veeraRef,
      tabId: undefined,
      foreignAgentTabId: PreviewTabId.make("tab_70d23993-1e1d-4caf-b190-0265822665c4"),
    });
  });

  it("does not default a thread onto another thread's visible browser", () => {
    const pawstalgiaState = state("tab-pawstalgia-gmail");
    expect(
      resolvePreviewAutomationThreadTarget({
        environmentId,
        requestThreadRef: veeraRef,
        requestedTabId: undefined,
        previewByThreadKey: { [scopedThreadKey(pawstalgiaRef)]: pawstalgiaState },
        presentationsByRuntimeTabId: {
          [previewRuntimeTabId(pawstalgiaRef, pawstalgiaState.serverEpoch, "tab-pawstalgia-gmail")]:
            presentation(),
        },
        profiles,
      }),
    ).toEqual({
      threadRef: veeraRef,
      tabId: undefined,
    });
  });
});
