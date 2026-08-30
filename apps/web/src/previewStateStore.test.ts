import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  type PreviewEvent,
  type PreviewSessionSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  __testing,
  applyPreviewDesktopState,
  applyPreviewRemoteDownloadApprovals,
  applyPreviewServerEvent as applyPreviewServerEventImpl,
  applyPreviewServerSnapshot,
  beginPreviewSessionClose,
  cancelPreviewSessionClose,
  previewStateAtom,
  readActivePreviewSessions,
  readThreadPreviewState,
  reconcilePreviewEnvironmentSessions,
  reconcilePreviewServerSessions,
  rememberPreviewUrl,
  removePreviewThread,
  resetPreviewStateForTests,
  setActivePreviewTab,
  updatePreviewServerSnapshot,
} from "./previewStateStore";

const environmentId = "env-1" as EnvironmentId;
const ref = scopeThreadRef(environmentId, ThreadId.make("thread-1"));
const otherRef = scopeThreadRef(environmentId, ThreadId.make("thread-2"));

const makeSnapshot = (overrides: Partial<PreviewSessionSnapshot> = {}): PreviewSessionSnapshot => ({
  threadId: "thread-1",
  tabId: "tab_a",
  navStatus: { _tag: "Loading", url: "http://localhost:5173/", title: "" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

type PreviewEventDraft = PreviewEvent extends infer Event
  ? Event extends { readonly revision: number }
    ? Omit<Event, "revision" | "serverEpoch">
    : never
  : never;

const serverEpoch = "server-a";
let nextServerRevision = 0;
const applyPreviewServerEvent = (eventRef: typeof ref, event: PreviewEventDraft): void => {
  nextServerRevision += 1;
  applyPreviewServerEventImpl(eventRef, {
    ...event,
    serverEpoch,
    revision: nextServerRevision,
  } as PreviewEvent);
};

beforeEach(() => {
  nextServerRevision = 0;
  resetPreviewStateForTests();
});

describe("previewStateStore (single-tab)", () => {
  it("keeps independent state atoms for each thread", () => {
    expect(previewStateAtom(scopedThreadKey(ref))).toBe(previewStateAtom(scopedThreadKey(ref)));
    expect(previewStateAtom(scopedThreadKey(ref))).not.toBe(
      previewStateAtom(scopedThreadKey(otherRef)),
    );

    applyPreviewServerSnapshot(ref, makeSnapshot());
    expect(readThreadPreviewState(ref).snapshot?.tabId).toBe("tab_a");
    expect(readThreadPreviewState(otherRef)).toEqual(__testing.EMPTY_THREAD_PREVIEW_STATE);
  });

  it("opened event seeds the snapshot and remembers the URL", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    const state = readThreadPreviewState(ref);
    expect(state.snapshot?.tabId).toBe(snapshot.tabId);
    expect(state.recentlySeenUrls).toContain("http://localhost:5173/");
  });

  it("ignores a duplicate event revision from a second renderer-wide subscriber", () => {
    const snapshot = makeSnapshot();
    const event = {
      type: "opened" as const,
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      serverEpoch,
      revision: 1,
      snapshot,
    };
    applyPreviewServerEventImpl(ref, event);
    const first = readThreadPreviewState(ref);

    applyPreviewServerEventImpl(ref, event);

    expect(readThreadPreviewState(ref)).toBe(first);
  });

  it("a second `opened` for a different tab replaces the rendered snapshot", () => {
    const a = makeSnapshot({ tabId: "tab_a" });
    const b = makeSnapshot({ tabId: "tab_b" });
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: a.tabId,
      createdAt: a.updatedAt,
      snapshot: a,
    });
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: b.tabId,
      createdAt: b.updatedAt,
      snapshot: b,
    });
    const state = readThreadPreviewState(ref);
    expect(state.snapshot?.tabId).toBe(b.tabId);
  });

  it("navigated event updates the snapshot URL", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    applyPreviewServerEvent(ref, {
      type: "navigated",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: "2026-01-01T00:00:01.000Z",
      snapshot: {
        ...snapshot,
        navStatus: { _tag: "Success", url: "http://localhost:5173/about", title: "About" },
      },
    });
    const state = readThreadPreviewState(ref);
    expect(state.snapshot?.navStatus._tag).toBe("Success");
    if (state.snapshot?.navStatus._tag === "Success") {
      expect(state.snapshot.navStatus.url).toBe("http://localhost:5173/about");
    }
  });

  it("resized event updates tab viewport without changing the active tab", () => {
    const active = makeSnapshot({ tabId: "tab_a" });
    const background = makeSnapshot({ tabId: "tab_b" });
    applyPreviewServerSnapshot(ref, background);
    applyPreviewServerSnapshot(ref, active);

    applyPreviewServerEvent(ref, {
      type: "resized",
      threadId: "thread-1",
      tabId: background.tabId,
      createdAt: "2026-01-01T00:00:01.000Z",
      snapshot: {
        ...background,
        viewport: { _tag: "preset", presetId: "pixel-8", width: 412, height: 915 },
        updatedAt: "2026-01-01T00:00:01.000Z",
      },
    });

    const state = readThreadPreviewState(ref);
    expect(state.activeTabId).toBe(active.tabId);
    expect(state.sessions[background.tabId]?.viewport).toEqual({
      _tag: "preset",
      presetId: "pixel-8",
      width: 412,
      height: 915,
    });
  });

  it("failed event flips the snapshot to LoadFailed when tabId matches", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    applyPreviewServerEvent(ref, {
      type: "failed",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: "2026-01-01T00:00:01.000Z",
      url: "http://localhost:5173/",
      title: "",
      code: -105,
      description: "ERR_NAME_NOT_RESOLVED",
    });
    const state = readThreadPreviewState(ref);
    expect(state.snapshot?.navStatus._tag).toBe("LoadFailed");
  });

  it("failed event for a non-active tab is ignored", () => {
    const snapshot = makeSnapshot({ tabId: "tab_a" });
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    applyPreviewServerEvent(ref, {
      type: "failed",
      threadId: "thread-1",
      tabId: "tab_b",
      createdAt: "2026-01-01T00:00:01.000Z",
      url: "http://localhost:9999/",
      title: "",
      code: -105,
      description: "ERR_NAME_NOT_RESOLVED",
    });
    const state = readThreadPreviewState(ref);
    expect(state.snapshot?.navStatus._tag).toBe("Loading");
  });

  it("closed event clears snapshot but retains recently-seen URLs", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    applyPreviewServerEvent(ref, {
      type: "closed",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    const state = readThreadPreviewState(ref);
    expect(state.snapshot).toBeNull();
    expect(state.recentlySeenUrls).toContain("http://localhost:5173/");
  });

  it("optimistically removes a session before the server close event arrives", () => {
    const first = makeSnapshot({ tabId: "tab_a" });
    const second = makeSnapshot({
      tabId: "tab_b",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    applyPreviewServerSnapshot(ref, first);
    applyPreviewServerSnapshot(ref, second);

    beginPreviewSessionClose(ref, second.tabId);

    const state = readThreadPreviewState(ref);
    expect(Object.keys(state.sessions)).toEqual([first.tabId]);
    expect(state.activeTabId).toBe(first.tabId);
    expect(state.snapshot?.tabId).toBe(first.tabId);
  });

  it("treats a late server close event after optimistic removal as a no-op", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerSnapshot(ref, snapshot);
    beginPreviewSessionClose(ref, snapshot.tabId);

    applyPreviewServerEvent(ref, {
      type: "closed",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: "2026-01-01T00:00:01.000Z",
    });

    const state = readThreadPreviewState(ref);
    expect(state.sessions).toEqual({});
    expect(state.snapshot).toBeNull();
  });

  it("does not resurrect an intentionally closed tab from a stale list snapshot", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerSnapshot(ref, snapshot);
    beginPreviewSessionClose(ref, snapshot.tabId);

    applyPreviewServerSnapshot(ref, snapshot);

    const state = readThreadPreviewState(ref);
    expect(state.sessions).toEqual({});
    expect(state.snapshot).toBeNull();
  });

  it("can restore a suppressed tab after a failed close", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerSnapshot(ref, snapshot);
    beginPreviewSessionClose(ref, snapshot.tabId);

    cancelPreviewSessionClose(ref, snapshot, snapshot.tabId);

    const state = readThreadPreviewState(ref);
    expect(state.sessions).toEqual({ [snapshot.tabId]: snapshot });
    expect(state.snapshot).toEqual(snapshot);
  });

  it("closed event for a different tab is a no-op", () => {
    const snapshot = makeSnapshot({ tabId: "tab_a" });
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    applyPreviewServerEvent(ref, {
      type: "closed",
      threadId: "thread-1",
      tabId: "tab_b",
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    const state = readThreadPreviewState(ref);
    expect(state.snapshot?.tabId).toBe(snapshot.tabId);
  });

  it("desktopOverlay updates independently of snapshot", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    applyPreviewDesktopState(ref, snapshot.tabId, {
      hasWebContents: true,
      canGoBack: true,
      canGoForward: false,
      loading: false,
      zoomFactor: 1,
      pictureInPicture: false,
      colorScheme: "system",
      controller: "none",
      agentActive: false,
      downloads: [],
      pendingDownloadApprovals: [],
    });
    const state = readThreadPreviewState(ref);
    expect(state.desktopOverlay?.canGoBack).toBe(true);
    expect(state.snapshot?.canGoBack).toBe(false);
  });

  it("retains multiple tabs and switches active desktop state", () => {
    const first = makeSnapshot();
    const second = { ...makeSnapshot(), tabId: "tab_2", updatedAt: "2026-01-02T00:00:00.000Z" };
    applyPreviewServerSnapshot(ref, first);
    applyPreviewServerSnapshot(ref, second);
    applyPreviewDesktopState(ref, first.tabId, {
      hasWebContents: true,
      canGoBack: true,
      canGoForward: false,
      loading: false,
      zoomFactor: 1,
      pictureInPicture: false,
      colorScheme: "system",
      controller: "none",
      agentActive: false,
      downloads: [],
      pendingDownloadApprovals: [],
    });
    setActivePreviewTab(ref, first.tabId);

    const state = readThreadPreviewState(ref);
    expect(Object.keys(state.sessions)).toEqual([first.tabId, second.tabId]);
    expect(state.snapshot?.tabId).toBe(first.tabId);
    expect(state.desktopOverlay?.canGoBack).toBe(true);
  });

  it("updates a background snapshot without changing the active tab", () => {
    const background = makeSnapshot({ tabId: "tab_a" });
    const active = makeSnapshot({
      tabId: "tab_b",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    applyPreviewServerSnapshot(ref, background);
    applyPreviewServerSnapshot(ref, active);

    const resized = {
      ...background,
      viewport: { _tag: "freeform" as const, width: 900, height: 700 },
      updatedAt: "2026-01-01T00:00:02.000Z",
    };
    updatePreviewServerSnapshot(ref, resized);

    const state = readThreadPreviewState(ref);
    expect(state.activeTabId).toBe(active.tabId);
    expect(state.snapshot?.tabId).toBe(active.tabId);
    expect(state.sessions[background.tabId]).toEqual(resized);
  });

  it("reconciles a session list without unloading an omitted live desktop tab", () => {
    const active = makeSnapshot({ tabId: "tab_a" });
    const stale = makeSnapshot({
      tabId: "tab_stale",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    applyPreviewServerSnapshot(ref, stale);
    applyPreviewServerSnapshot(ref, active);
    applyPreviewDesktopState(ref, stale.tabId, {
      hasWebContents: true,
      canGoBack: false,
      canGoForward: false,
      loading: false,
      zoomFactor: 1,
      pictureInPicture: false,
      colorScheme: "system",
      controller: "none",
      agentActive: false,
      downloads: [],
      pendingDownloadApprovals: [],
    });

    reconcilePreviewServerSessions(ref, { sessions: [active], serverEpoch, revision: 1 });

    const state = readThreadPreviewState(ref);
    expect(Object.keys(state.sessions)).toEqual([active.tabId]);
    expect(Object.keys(state.hostedSessions).toSorted()).toEqual(
      [active.tabId, stale.tabId].toSorted(),
    );
    expect(state.activeTabId).toBe(active.tabId);
    expect(state.snapshot).toEqual(active);
    expect(state.desktopByTabId[stale.tabId]?.hasWebContents).toBe(true);
  });

  it("keeps a locally known guest mounted through a transient empty list", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerSnapshot(ref, snapshot);

    reconcilePreviewServerSessions(ref, { sessions: [], serverEpoch, revision: 1 });

    const state = readThreadPreviewState(ref);
    expect(state.sessions).toEqual({});
    expect(state.hostedSessions).toEqual({ [snapshot.tabId]: snapshot });
    expect(state.activeTabId).toBeNull();
    expect(state.snapshot).toBeNull();
    expect(readActivePreviewSessions()[scopedThreadKey(ref)]?.hostedSessions).toEqual({
      [snapshot.tabId]: snapshot,
    });
  });

  it("hydrates background threads from one environment-wide reconnect list", () => {
    const first = makeSnapshot({
      tabId: "tab_9be1ed02-7d29-4b42-b73b-ebbe32462445",
    });
    const second = makeSnapshot({
      threadId: "thread-2",
      tabId: "tab_2a5b47f0-bade-4dad-9edb-65082a4a60e2",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });

    reconcilePreviewEnvironmentSessions(environmentId, {
      sessions: [first, second],
      serverEpoch,
      revision: 2,
    });

    expect(readThreadPreviewState(ref).hostedSessions[first.tabId]).toEqual(first);
    expect(readThreadPreviewState(otherRef).hostedSessions[second.tabId]).toEqual(second);
    expect(readThreadPreviewState(ref).hostSyncGeneration).toBe(1);
    expect(readThreadPreviewState(otherRef).hostSyncGeneration).toBe(1);
  });

  it("uses a fresh environment catch-up to release a close missed while disconnected", () => {
    const snapshot = makeSnapshot({
      tabId: "tab_9be1ed02-7d29-4b42-b73b-ebbe32462445",
    });
    reconcilePreviewEnvironmentSessions(environmentId, {
      sessions: [snapshot],
      serverEpoch,
      revision: 1,
    });

    reconcilePreviewEnvironmentSessions(environmentId, {
      sessions: [],
      serverEpoch,
      revision: 2,
    });

    expect(readThreadPreviewState(ref).sessions).toEqual({});
    expect(readThreadPreviewState(ref).hostedSessions).toEqual({});
    expect(readActivePreviewSessions()[scopedThreadKey(ref)]).toBeUndefined();
  });

  it("does not prune a tab from a list older than its streamed open", () => {
    const existing = makeSnapshot({
      tabId: "tab_9be1ed02-7d29-4b42-b73b-ebbe32462445",
    });
    reconcilePreviewEnvironmentSessions(environmentId, {
      sessions: [existing],
      serverEpoch,
      revision: 1,
    });
    const opened = makeSnapshot({
      tabId: "tab_2a5b47f0-bade-4dad-9edb-65082a4a60e2",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    applyPreviewServerEventImpl(ref, {
      type: "opened",
      threadId: opened.threadId,
      tabId: opened.tabId,
      createdAt: opened.updatedAt,
      serverEpoch,
      revision: 3,
      snapshot: opened,
    });

    reconcilePreviewEnvironmentSessions(environmentId, {
      sessions: [existing],
      serverEpoch,
      revision: 2,
    });

    expect(readThreadPreviewState(ref).hostedSessions[opened.tabId]).toEqual(opened);
    expect(readThreadPreviewState(ref).serverRevision).toBe(3);
  });

  it("does not let a retired server epoch overwrite a reconnect catch-up", () => {
    const old = makeSnapshot({
      tabId: "tab_9be1ed02-7d29-4b42-b73b-ebbe32462445",
    });
    reconcilePreviewEnvironmentSessions(environmentId, {
      sessions: [old],
      serverEpoch,
      revision: 1,
    });
    reconcilePreviewEnvironmentSessions(environmentId, {
      sessions: [],
      serverEpoch: "server-b",
      revision: 0,
    });

    applyPreviewServerEventImpl(otherRef, {
      type: "opened",
      threadId: "thread-2",
      tabId: old.tabId,
      createdAt: old.updatedAt,
      serverEpoch,
      revision: 2,
      snapshot: { ...old, threadId: "thread-2" },
    });

    expect(readThreadPreviewState(otherRef)).toEqual(__testing.EMPTY_THREAD_PREVIEW_STATE);
  });

  it("removes a retained tab immediately when its typed close event arrives", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerSnapshot(ref, snapshot);
    reconcilePreviewServerSessions(ref, { sessions: [], serverEpoch, revision: 1 });

    applyPreviewServerEventImpl(ref, {
      type: "closed",
      threadId: snapshot.threadId,
      tabId: snapshot.tabId,
      createdAt: "2026-01-01T00:00:01.000Z",
      serverEpoch,
      revision: 2,
    });

    const state = readThreadPreviewState(ref);
    expect(state.sessions).toEqual({});
    expect(state.hostedSessions).toEqual({});
  });

  it("preserves a durable hosted guest and desktop binding across a server epoch", () => {
    const snapshot = makeSnapshot({
      tabId: "tab_9be1ed02-7d29-4b42-b73b-ebbe32462445",
    });
    applyPreviewServerSnapshot(ref, snapshot);
    applyPreviewDesktopState(ref, snapshot.tabId, {
      hasWebContents: true,
      canGoBack: false,
      canGoForward: false,
      loading: false,
      zoomFactor: 1,
      pictureInPicture: false,
      colorScheme: "system",
      controller: "none",
      agentActive: false,
      downloads: [],
      pendingDownloadApprovals: [],
    });
    reconcilePreviewServerSessions(ref, { sessions: [snapshot], serverEpoch, revision: 1 });

    reconcilePreviewServerSessions(ref, {
      sessions: [],
      serverEpoch: "server-b",
      revision: 0,
    });

    const state = readThreadPreviewState(ref);
    expect(state.sessions).toEqual({});
    expect(state.hostedSessions).toEqual({ [snapshot.tabId]: snapshot });
    expect(state.desktopByTabId[snapshot.tabId]?.hasWebContents).toBe(true);
  });

  it("accepts a background open from a new server epoch without dropping durable guests", () => {
    const retained = makeSnapshot({
      tabId: "tab_9be1ed02-7d29-4b42-b73b-ebbe32462445",
    });
    applyPreviewServerEventImpl(ref, {
      type: "opened",
      threadId: retained.threadId,
      tabId: retained.tabId,
      createdAt: retained.updatedAt,
      serverEpoch,
      revision: 12,
      snapshot: retained,
    });
    const opened = makeSnapshot({
      tabId: "tab_2a5b47f0-bade-4dad-9edb-65082a4a60e2",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });

    applyPreviewServerEventImpl(ref, {
      type: "opened",
      threadId: opened.threadId,
      tabId: opened.tabId,
      createdAt: opened.updatedAt,
      serverEpoch: "server-b",
      revision: 1,
      snapshot: opened,
    });

    const state = readThreadPreviewState(ref);
    expect(state.sessions).toEqual({ [opened.tabId]: opened });
    expect(state.hostedSessions).toEqual({
      [retained.tabId]: retained,
      [opened.tabId]: opened,
    });
    expect(state.serverEpoch).toBe("server-b");
    expect(state.serverRevision).toBe(1);
  });

  it("ignores a list response older than the latest server event", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });

    reconcilePreviewServerSessions(ref, { sessions: [], serverEpoch, revision: 0 });

    expect(readThreadPreviewState(ref).sessions).toEqual({ [snapshot.tabId]: snapshot });
  });

  it("does not resurrect a tab from an event older than its close", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    applyPreviewServerEvent(ref, {
      type: "closed",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: "2026-01-01T00:00:01.000Z",
    });

    applyPreviewServerEventImpl(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      serverEpoch,
      revision: 1,
      snapshot,
    });

    expect(readThreadPreviewState(ref).sessions).toEqual({});
  });

  it("accepts a lower revision from a newly restarted server", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerEventImpl(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      serverEpoch,
      revision: 12,
      snapshot,
    });

    reconcilePreviewServerSessions(ref, {
      sessions: [],
      serverEpoch: "server-b",
      revision: 0,
    });

    const state = readThreadPreviewState(ref);
    expect(state.sessions).toEqual({});
    expect(state.serverEpoch).toBe("server-b");
    expect(state.serverRevision).toBe(0);
  });

  it("does not carry raw-tab state across a server restart", () => {
    const previous = makeSnapshot({
      navStatus: { _tag: "Success", url: "https://old.example", title: "Old" },
      updatedAt: "2026-01-01T00:00:02.000Z",
    });
    applyPreviewServerEventImpl(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: previous.tabId,
      createdAt: previous.updatedAt,
      serverEpoch,
      revision: 12,
      snapshot: previous,
    });
    beginPreviewSessionClose(ref, previous.tabId);
    applyPreviewDesktopState(ref, previous.tabId, {
      hasWebContents: true,
      canGoBack: false,
      canGoForward: false,
      loading: false,
      zoomFactor: 1,
      pictureInPicture: false,
      colorScheme: "system",
      controller: "none",
      agentActive: false,
      downloads: [],
      pendingDownloadApprovals: [],
    });
    const restarted = makeSnapshot({
      navStatus: { _tag: "Success", url: "https://new.example", title: "New" },
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    reconcilePreviewServerSessions(ref, {
      sessions: [restarted],
      serverEpoch: "server-b",
      revision: 0,
    });

    const state = readThreadPreviewState(ref);
    expect(state.sessions[restarted.tabId]).toEqual(restarted);
    expect(state.suppressedTabIds).toEqual(new Set());
    expect(state.desktopByTabId).toEqual({});
    expect(state.desktopOverlay).toBeNull();
  });

  it("applyServerSnapshot null clears snapshot for a thread that had one", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerSnapshot(ref, snapshot);
    applyPreviewServerSnapshot(ref, null);
    const state = readThreadPreviewState(ref);
    expect(state.snapshot).toBeNull();
  });

  it("does not replace a streamed snapshot with older SWR data", () => {
    applyPreviewServerSnapshot(
      ref,
      makeSnapshot({
        navStatus: { _tag: "Success", url: "http://localhost:5173/new", title: "New" },
        updatedAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    applyPreviewServerSnapshot(
      ref,
      makeSnapshot({
        navStatus: { _tag: "Success", url: "http://localhost:5173/old", title: "Old" },
        updatedAt: "2026-01-01T00:00:01.000Z",
      }),
    );

    const state = readThreadPreviewState(ref);
    expect(state.snapshot?.navStatus).toEqual({
      _tag: "Success",
      url: "http://localhost:5173/new",
      title: "New",
    });
  });

  it("rememberUrl dedupes and caps at limit", () => {
    for (let i = 0; i < __testing.RECENT_URL_LIMIT + 5; i += 1) {
      rememberPreviewUrl(ref, `http://localhost:${5000 + i}/`);
    }
    const state = readThreadPreviewState(ref);
    expect(state.recentlySeenUrls.length).toBeLessThanOrEqual(__testing.RECENT_URL_LIMIT);
    expect(state.recentlySeenUrls[0]).toBe(
      `http://localhost:${5000 + __testing.RECENT_URL_LIMIT + 4}/`,
    );
  });

  it("removeThread strips the entry", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerSnapshot(ref, snapshot);
    removePreviewThread(ref);
    const state = readThreadPreviewState(ref);
    expect(state).toEqual(__testing.EMPTY_THREAD_PREVIEW_STATE);
  });
});

describe("applyPreviewRemoteDownloadApprovals", () => {
  beforeEach(() => {
    resetPreviewStateForTests();
  });

  const held = [{ id: "hold-1", domain: "example.com", fileName: "report.pdf" }];

  it("records a remote hold per tab and clears it when the frame stops reporting it", () => {
    applyPreviewRemoteDownloadApprovals(ref, "tab_a", held);
    expect(readThreadPreviewState(ref).remoteApprovalsByTabId["tab_a"]).toEqual(held);

    applyPreviewRemoteDownloadApprovals(ref, "tab_a", []);
    expect(readThreadPreviewState(ref).remoteApprovalsByTabId).toEqual({});
  });

  it("an unchanged report keeps the same state object: frames tick every second", () => {
    applyPreviewRemoteDownloadApprovals(ref, "tab_a", held);
    const before = readThreadPreviewState(ref);
    applyPreviewRemoteDownloadApprovals(ref, "tab_a", [{ ...held[0]! }]);
    expect(readThreadPreviewState(ref)).toBe(before);
    // Nothing held, nothing recorded: the empty report must also not churn.
    const empty = readThreadPreviewState(otherRef);
    applyPreviewRemoteDownloadApprovals(otherRef, "tab_b", []);
    expect(readThreadPreviewState(otherRef)).toBe(empty);
  });

  it("a closed tab takes its held-download state with it", () => {
    applyPreviewServerSnapshot(ref, makeSnapshot());
    applyPreviewRemoteDownloadApprovals(ref, "tab_a", held);
    applyPreviewServerEvent(ref, {
      type: "closed",
      threadId: "thread-1",
      tabId: "tab_a",
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    expect(readThreadPreviewState(ref).remoteApprovalsByTabId).toEqual({});
  });
});
