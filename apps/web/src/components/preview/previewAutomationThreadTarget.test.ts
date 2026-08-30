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
    remoteApprovalsByTabId: {},
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
    ).toEqual({
      threadRef: visibleThreadRef,
      tabId: PreviewTabId.make("tab-visible"),
    });
  });

  it("never answers a named tab with a different guest", () => {
    // A mirror viewer on another machine asks its host for one specific tab.
    // When the host has no session for it, substituting the guest it happens
    // to be showing sends back a picture of the wrong page under the viewer's
    // correct address bar — observed 2026-08-29 with Windows mirroring a Mac,
    // which rendered the Mac's own window. Hand the named tab back and let the
    // caller's session sync resolve or fail it.
    const visibleState = state("tab-visible");
    expect(
      resolvePreviewAutomationThreadTarget({
        environmentId,
        requestThreadRef,
        requestedTabId: PreviewTabId.make("tab-not-on-this-host"),
        previewByThreadKey: { [scopedThreadKey(visibleThreadRef)]: visibleState },
        presentationsByRuntimeTabId: {
          [previewRuntimeTabId(visibleThreadRef, visibleState.serverEpoch, "tab-visible")]:
            presentation(),
        },
      }),
    ).toEqual({
      threadRef: requestThreadRef,
      tabId: PreviewTabId.make("tab-not-on-this-host"),
    });
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
    ).toEqual({
      threadRef: visibleThreadRef,
      tabId: PreviewTabId.make("tab-visible"),
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
        previewByThreadKey: { [scopedThreadKey(visibleThreadRef)]: hostedState },
        presentationsByRuntimeTabId: {
          [previewRuntimeTabId(visibleThreadRef, hostedState.serverEpoch, "tab-visible")]:
            presentation(),
        },
      }),
    ).toEqual({
      threadRef: visibleThreadRef,
      tabId: PreviewTabId.make("tab-visible"),
    });
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
    ).toEqual({
      threadRef: visibleThreadRef,
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
        requestThreadId: ThreadId.make("agent-work"),
        ownerThreadId: ThreadId.make("agent-channel"),
        profiles: {
          "agent-work": agentHome("agent-work"),
          "agent-channel": agentHome("agent-channel"),
        },
      }),
    ).toBe(false);
  });

  it("lets a delegated project thread keep using its creating agent's profile", () => {
    expect(
      canReusePreviewAutomationBrowser({
        requestThreadId: ThreadId.make("project-thread"),
        ownerThreadId: ThreadId.make("agent-work"),
        profiles: {
          "project-thread": {
            profileRootThreadId: ThreadId.make("agent-work"),
            exclusiveAgentBrowser: false,
          },
          "agent-work": agentHome("agent-work"),
        },
      }),
    ).toBe(true);
  });
});

describe("resolvePreviewAutomationThreadTarget agent isolation", () => {
  const workAgentRef = scopeThreadRef(environmentId, ThreadId.make("agent-work"));
  const channelRef = scopeThreadRef(environmentId, ThreadId.make("agent-channel"));
  const profiles = {
    "agent-work": agentHome("agent-work"),
    "agent-channel": agentHome("agent-channel"),
  };

  it("ignores an explicit tab from another custom agent's dedicated browser", () => {
    const channelState = state("tab_70d23993-1e1d-4caf-b190-0265822665c4");
    const workAgentState = state("tab-work-gmail");
    expect(
      resolvePreviewAutomationThreadTarget({
        environmentId,
        requestThreadRef: workAgentRef,
        requestedTabId: PreviewTabId.make("tab_70d23993-1e1d-4caf-b190-0265822665c4"),
        previewByThreadKey: {
          [scopedThreadKey(workAgentRef)]: workAgentState,
          [scopedThreadKey(channelRef)]: channelState,
        },
        presentationsByRuntimeTabId: {
          [previewRuntimeTabId(workAgentRef, workAgentState.serverEpoch, "tab-work-gmail")]: presentation({
            interactive: true,
            updatedAt: 2,
          }),
          [previewRuntimeTabId(
            channelRef,
            channelState.serverEpoch,
            "tab_70d23993-1e1d-4caf-b190-0265822665c4",
          )]: presentation({ interactive: true, updatedAt: 1 }),
        },
        profiles,
      }),
    ).toEqual({
      threadRef: workAgentRef,
      tabId: undefined,
      foreignAgentTabId: PreviewTabId.make("tab_70d23993-1e1d-4caf-b190-0265822665c4"),
    });
  });

  it("does not default a custom agent onto another agent's visible browser", () => {
    const channelState = state("tab-channel-gmail");
    expect(
      resolvePreviewAutomationThreadTarget({
        environmentId,
        requestThreadRef: workAgentRef,
        requestedTabId: undefined,
        previewByThreadKey: { [scopedThreadKey(channelRef)]: channelState },
        presentationsByRuntimeTabId: {
          [previewRuntimeTabId(channelRef, channelState.serverEpoch, "tab-channel-gmail")]:
            presentation(),
        },
        profiles,
      }),
    ).toEqual({
      threadRef: workAgentRef,
      tabId: undefined,
    });
  });
});
