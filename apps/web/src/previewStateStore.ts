/**
 * Per-thread preview UI state.
 *
 * Each thread owns an independent atom. Most consumers read exactly one
 * thread; the desktop browser host uses the aggregate session atom because it
 * is the one place that must enumerate every live preview tab.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  type DesktopPreviewColorScheme,
  type EnvironmentId,
  type PreviewDownload,
  type PreviewEvent,
  type PreviewListResult,
  type PreviewDownloadApproval,
  type PreviewSessionSnapshot,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { hasStablePreviewTabIdentity } from "./browser/previewRuntimeTabId";
import { PREVIEW_RECENT_URL_LIMIT } from "./components/preview/previewConstants";
import { appAtomRegistry } from "./rpc/atomRegistry";

export interface DesktopPreviewOverlay {
  hasWebContents: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  zoomFactor: number;
  pictureInPicture: boolean;
  colorScheme: DesktopPreviewColorScheme;
  controller: "human" | "agent" | "none" | "waiting-for-user";
  /** Sticky between an agent's individual actions, unlike `controller`. */
  agentActive: boolean;
  /** Finished downloads for this tab, newest first. */
  downloads: ReadonlyArray<PreviewDownload>;
  /** Downloads held on this tab until the user allows or denies the site. */
  pendingDownloadApprovals: ReadonlyArray<PreviewDownloadApproval>;
}

export interface ThreadPreviewState {
  snapshot: PreviewSessionSnapshot | null;
  /** Server-confirmed tab metadata used by UI and automation routing. */
  sessions: Record<string, PreviewSessionSnapshot>;
  /**
   * Renderer-owned Electron guests. A cached thread-local omission never
   * removes these because unmounting destroys the live page and authentication.
   * A fresh environment-wide adoption pass may remove a confirmed closed tab.
   */
  hostedSessions: Record<string, PreviewSessionSnapshot>;
  /** Tabs intentionally closed by this client. Stale list snapshots must not resurrect them. */
  suppressedTabIds: ReadonlySet<string>;
  activeTabId: string | null;
  desktopOverlay: DesktopPreviewOverlay | null;
  desktopByTabId: Record<string, DesktopPreviewOverlay>;
  /**
   * Downloads a REMOTE host is holding for approval, keyed by tab, as
   * reported by the frames the mirror polls. Kept apart from desktopByTabId:
   * that map describes this machine's own guests, and a viewer with no guest
   * at all still needs somewhere for the Allow/Deny state to live.
   */
  remoteApprovalsByTabId: Record<string, ReadonlyArray<PreviewDownloadApproval>>;
  recentlySeenUrls: string[];
  /** Server process currently authoritative for revision ordering. */
  serverEpoch: string | null;
  /** Latest ordered server revision applied from a list response or event. */
  serverRevision: number;
  /** Re-registers a stable native guest after an environment transport reconnect. */
  hostSyncGeneration: number;
}

const EMPTY_THREAD_PREVIEW_STATE: ThreadPreviewState = Object.freeze({
  snapshot: null,
  sessions: {},
  hostedSessions: {},
  suppressedTabIds: new Set<string>(),
  activeTabId: null,
  desktopOverlay: null,
  desktopByTabId: {},
  remoteApprovalsByTabId: {},
  recentlySeenUrls: [] as string[],
  serverEpoch: null,
  serverRevision: 0,
  hostSyncGeneration: 0,
});

const emptyPreviewStateAtom = Atom.make<ThreadPreviewState>(EMPTY_THREAD_PREVIEW_STATE).pipe(
  Atom.withLabel("preview:empty-thread"),
);

export const previewStateAtom = Atom.family((threadKey: string) =>
  Atom.make<ThreadPreviewState>(EMPTY_THREAD_PREVIEW_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`preview:thread:${threadKey}`),
  ),
);

// Only the Electron browser host needs a cross-thread view. Keep that index
// separate so thread-local readers never subscribe to unrelated previews.
interface ActivePreviewThreadIndex {
  readonly keys: ReadonlySet<string>;
}

const activePreviewThreadKeysAtom = Atom.make<ActivePreviewThreadIndex>({
  keys: new Set<string>(),
}).pipe(Atom.keepAlive, Atom.withLabel("preview:active-thread-keys"));

const activePreviewSessionsAtom = Atom.make((get) => {
  const byThreadKey: Record<string, ThreadPreviewState> = {};
  for (const threadKey of get(activePreviewThreadKeysAtom).keys) {
    const state = get(previewStateAtom(threadKey));
    if (Object.keys(state.hostedSessions).length > 0) {
      byThreadKey[threadKey] = state;
    }
  }
  return byThreadKey;
}).pipe(Atom.withLabel("preview:active-sessions"));

const changedPreviewThreadKeys = new Set<string>();

interface PreviewEnvironmentClock {
  readonly currentEpoch: string;
  readonly retiredEpochs: ReadonlySet<string>;
  readonly catchupRevision: number;
}

const previewEnvironmentClocks = new Map<string, PreviewEnvironmentClock>();

const transitionPreviewEnvironmentEpoch = (
  environmentId: EnvironmentId,
  serverEpoch: string,
): PreviewEnvironmentClock | null => {
  const key = String(environmentId);
  const current = previewEnvironmentClocks.get(key);
  if (!current) {
    const initial = {
      currentEpoch: serverEpoch,
      retiredEpochs: new Set<string>(),
      catchupRevision: -1,
    } satisfies PreviewEnvironmentClock;
    previewEnvironmentClocks.set(key, initial);
    return initial;
  }
  if (current.currentEpoch === serverEpoch) return current;
  if (current.retiredEpochs.has(serverEpoch)) return null;
  const retiredEpochs = new Set(current.retiredEpochs);
  retiredEpochs.add(current.currentEpoch);
  const next = {
    currentEpoch: serverEpoch,
    retiredEpochs,
    catchupRevision: -1,
  } satisfies PreviewEnvironmentClock;
  previewEnvironmentClocks.set(key, next);
  return next;
};

const acceptsPreviewEvent = (ref: ScopedThreadRef, event: PreviewEvent): boolean => {
  const clock = transitionPreviewEnvironmentEpoch(ref.environmentId, event.serverEpoch);
  return clock !== null && event.revision > clock.catchupRevision;
};

const acceptsPreviewList = (ref: ScopedThreadRef, result: PreviewListResult): boolean => {
  const clock = transitionPreviewEnvironmentEpoch(ref.environmentId, result.serverEpoch);
  return clock !== null && result.revision >= clock.catchupRevision;
};

const recordPreviewEnvironmentCatchup = (
  environmentId: EnvironmentId,
  result: PreviewListResult,
): boolean => {
  const clock = transitionPreviewEnvironmentEpoch(environmentId, result.serverEpoch);
  if (clock === null || result.revision < clock.catchupRevision) return false;
  previewEnvironmentClocks.set(String(environmentId), {
    ...clock,
    catchupRevision: result.revision,
  });
  return true;
};

function syncActivePreviewThread(threadKey: string, state: ThreadPreviewState): void {
  const active = Object.keys(state.hostedSessions).length > 0;
  appAtomRegistry.update(activePreviewThreadKeysAtom, (current) => {
    if (current.keys.has(threadKey) === active) return current;
    const next = new Set(current.keys);
    if (active) next.add(threadKey);
    else next.delete(threadKey);
    return { keys: next };
  });
}

function updateThreadPreviewState(
  ref: ScopedThreadRef,
  update: (current: ThreadPreviewState) => ThreadPreviewState,
): void {
  const threadKey = scopedThreadKey(ref);
  const atom = previewStateAtom(threadKey);
  let nextState = appAtomRegistry.get(atom);
  const changed = appAtomRegistry.modify(atom, (current) => {
    nextState = update(current);
    return [nextState !== current, nextState];
  });
  if (!changed) return;
  changedPreviewThreadKeys.add(threadKey);
  syncActivePreviewThread(threadKey, nextState);
}

const dedupeRecentUrls = (existing: string[], url: string): string[] => {
  const next = [url, ...existing.filter((entry) => entry !== url)];
  return next.slice(0, PREVIEW_RECENT_URL_LIMIT);
};

const rememberSnapshotUrl = (
  recentlySeenUrls: string[],
  snapshot: PreviewSessionSnapshot,
): string[] =>
  snapshot.navStatus._tag === "Idle"
    ? recentlySeenUrls
    : dedupeRecentUrls(recentlySeenUrls, snapshot.navStatus.url);

const latestSnapshot = (
  sessions: Record<string, PreviewSessionSnapshot>,
): PreviewSessionSnapshot | null =>
  Object.values(sessions)
    .toSorted((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .at(-1) ?? null;

const removeSession = (current: ThreadPreviewState, tabId: string): ThreadPreviewState => {
  if (!current.sessions[tabId] && !current.hostedSessions[tabId]) return current;
  const { [tabId]: _closed, ...sessions } = current.sessions;
  const { [tabId]: _hosted, ...hostedSessions } = current.hostedSessions;
  const { [tabId]: _desktop, ...desktopByTabId } = current.desktopByTabId;
  const { [tabId]: _remoteApprovals, ...remoteApprovalsByTabId } = current.remoteApprovalsByTabId;
  const nextSnapshot = latestSnapshot(sessions);
  const activeTabId =
    current.activeTabId === tabId ? (nextSnapshot?.tabId ?? null) : current.activeTabId;
  const snapshot = activeTabId ? (sessions[activeTabId] ?? nextSnapshot) : nextSnapshot;
  return {
    ...current,
    sessions,
    hostedSessions,
    desktopByTabId,
    remoteApprovalsByTabId,
    activeTabId: snapshot?.tabId ?? null,
    snapshot,
    desktopOverlay: snapshot ? (desktopByTabId[snapshot.tabId] ?? null) : null,
  };
};

export function useThreadPreviewState(ref: ScopedThreadRef | null | undefined): ThreadPreviewState {
  const atom = ref ? previewStateAtom(scopedThreadKey(ref)) : emptyPreviewStateAtom;
  return useAtomValue(atom);
}

export function useActivePreviewSessions(): Record<string, ThreadPreviewState> {
  return useAtomValue(activePreviewSessionsAtom);
}

/** Imperative counterpart for environment-wide automation target resolution. */
export function readActivePreviewSessions(): Record<string, ThreadPreviewState> {
  return appAtomRegistry.get(activePreviewSessionsAtom);
}

export function readThreadPreviewState(ref: ScopedThreadRef): ThreadPreviewState {
  return appAtomRegistry.get(previewStateAtom(scopedThreadKey(ref)));
}

export function subscribeThreadPreviewState(
  ref: ScopedThreadRef,
  listener: (state: ThreadPreviewState, previous: ThreadPreviewState) => void,
): () => void {
  const atom = previewStateAtom(scopedThreadKey(ref));
  let previous = appAtomRegistry.get(atom);
  return appAtomRegistry.subscribe(atom, (state) => {
    const prior = previous;
    previous = state;
    listener(state, prior);
  });
}

const transitionPreviewServerEpoch = (
  current: ThreadPreviewState,
  serverEpoch: string,
): ThreadPreviewState => {
  if (current.serverEpoch === null || current.serverEpoch === serverEpoch) return current;
  const hostedSessions = Object.fromEntries(
    Object.entries(current.hostedSessions).filter(([tabId]) => hasStablePreviewTabIdentity(tabId)),
  );
  const desktopByTabId = Object.fromEntries(
    Object.entries(current.desktopByTabId).filter(([tabId]) => hostedSessions[tabId] !== undefined),
  );
  return {
    ...current,
    snapshot: null,
    sessions: {},
    hostedSessions,
    suppressedTabIds: new Set(),
    activeTabId: null,
    desktopOverlay: null,
    desktopByTabId,
    remoteApprovalsByTabId: {},
    serverEpoch,
    serverRevision: 0,
  };
};

export function applyPreviewServerEvent(ref: ScopedThreadRef, event: PreviewEvent): void {
  if (!acceptsPreviewEvent(ref, event)) return;
  updateThreadPreviewState(ref, (current) => {
    const base = transitionPreviewServerEpoch(current, event.serverEpoch);
    if (base.serverEpoch === event.serverEpoch && event.revision <= base.serverRevision) {
      return base;
    }
    const next = (() => {
      switch (event.type) {
        case "opened":
        case "navigated":
        case "resized": {
          const snapshot = event.snapshot;
          if (base.suppressedTabIds.has(snapshot.tabId)) return base;
          const recentlySeenUrls =
            snapshot.navStatus._tag === "Idle"
              ? base.recentlySeenUrls
              : dedupeRecentUrls(base.recentlySeenUrls, snapshot.navStatus.url);
          const sessions = { ...base.sessions, [snapshot.tabId]: snapshot };
          const hostedSessions = { ...base.hostedSessions, [snapshot.tabId]: snapshot };
          const activeTabId = event.type === "opened" ? snapshot.tabId : base.activeTabId;
          const activeSnapshot = sessions[activeTabId ?? snapshot.tabId] ?? snapshot;
          return {
            ...base,
            sessions,
            hostedSessions,
            activeTabId: activeTabId ?? snapshot.tabId,
            snapshot: activeSnapshot,
            desktopOverlay: base.desktopByTabId[activeSnapshot.tabId] ?? null,
            recentlySeenUrls,
          };
        }
        case "failed": {
          const existing = base.sessions[event.tabId] ?? base.hostedSessions[event.tabId];
          if (!existing) return base;
          const failedSnapshot = {
            ...existing,
            navStatus: {
              _tag: "LoadFailed" as const,
              url: event.url,
              title: event.title,
              code: event.code,
              description: event.description,
            },
            updatedAt: event.createdAt,
          };
          const sessions = { ...base.sessions, [event.tabId]: failedSnapshot };
          return {
            ...base,
            sessions,
            hostedSessions: { ...base.hostedSessions, [event.tabId]: failedSnapshot },
            snapshot: base.activeTabId === event.tabId ? failedSnapshot : base.snapshot,
          };
        }
        case "closed": {
          const closed = removeSession(base, event.tabId);
          if (!closed.suppressedTabIds.has(event.tabId)) return closed;
          const suppressedTabIds = new Set(closed.suppressedTabIds);
          suppressedTabIds.delete(event.tabId);
          return { ...closed, suppressedTabIds };
        }
      }
    })();
    return next.serverRevision === event.revision && next.serverEpoch === event.serverEpoch
      ? next
      : {
          ...next,
          serverEpoch: event.serverEpoch,
          serverRevision: event.revision,
        };
  });
}

export function applyPreviewServerSnapshot(
  ref: ScopedThreadRef,
  snapshot: PreviewSessionSnapshot | null,
): void {
  updateThreadPreviewState(ref, (current) => {
    if (
      !snapshot &&
      current.snapshot === null &&
      Object.keys(current.hostedSessions).length === 0
    ) {
      return current;
    }
    if (!snapshot) {
      return {
        ...current,
        snapshot: null,
        sessions: {},
        hostedSessions: {},
        activeTabId: null,
        desktopOverlay: null,
        desktopByTabId: {},
      };
    }
    if (current.suppressedTabIds.has(snapshot.tabId)) return current;
    const existing = current.sessions[snapshot.tabId] ?? current.hostedSessions[snapshot.tabId];
    if (existing && existing.updatedAt > snapshot.updatedAt) return current;
    const recentlySeenUrls = rememberSnapshotUrl(current.recentlySeenUrls, snapshot);
    return {
      ...current,
      snapshot,
      sessions: { ...current.sessions, [snapshot.tabId]: snapshot },
      hostedSessions: { ...current.hostedSessions, [snapshot.tabId]: snapshot },
      activeTabId: snapshot.tabId,
      desktopOverlay: current.desktopByTabId[snapshot.tabId] ?? null,
      recentlySeenUrls,
    };
  });
}

/**
 * Merge a server mutation without changing which tab the user is viewing.
 *
 * Commands such as resize can target background tabs. Their response is
 * authoritative for that tab, but it is not a request to focus the tab.
 */
export function updatePreviewServerSnapshot(
  ref: ScopedThreadRef,
  snapshot: PreviewSessionSnapshot,
): void {
  updateThreadPreviewState(ref, (current) => {
    if (current.suppressedTabIds.has(snapshot.tabId)) return current;
    const existing = current.sessions[snapshot.tabId] ?? current.hostedSessions[snapshot.tabId];
    if (existing && existing.updatedAt > snapshot.updatedAt) return current;
    const sessions = { ...current.sessions, [snapshot.tabId]: snapshot };
    const activeTabId =
      current.activeTabId && sessions[current.activeTabId] ? current.activeTabId : snapshot.tabId;
    const activeSnapshot = sessions[activeTabId] ?? snapshot;
    return {
      ...current,
      sessions,
      hostedSessions: { ...current.hostedSessions, [snapshot.tabId]: snapshot },
      activeTabId,
      snapshot: activeSnapshot,
      desktopOverlay: current.desktopByTabId[activeTabId] ?? null,
      recentlySeenUrls: rememberSnapshotUrl(current.recentlySeenUrls, snapshot),
    };
  });
}

/**
 * Reconcile server metadata without using list omission as a guest-close event.
 *
 * A cached or reconnecting `preview.list` can briefly omit a live desktop
 * guest. Removing it here unmounts Electron's `<webview>` and destroys the
 * authenticated page before the stream catches up. `sessions` remains the
 * authoritative UI/automation index; `hostedSessions` owns Electron lifetime.
 * Explicit close commands and typed `closed` events remove both. Durable UUID
 * guests also survive a server epoch change because the server restores those
 * exact ids from its session store.
 */
export function reconcilePreviewServerSessions(
  ref: ScopedThreadRef,
  result: PreviewListResult,
): void {
  if (!acceptsPreviewList(ref, result)) return;
  updateThreadPreviewState(ref, (current) => {
    const serverAlreadyKnown = current.serverEpoch !== null;
    const sameServer = !serverAlreadyKnown || current.serverEpoch === result.serverEpoch;
    if (serverAlreadyKnown && sameServer && result.revision < current.serverRevision)
      return current;
    const snapshots = result.sessions;
    const sessions: Record<string, PreviewSessionSnapshot> = {};
    const currentSuppressedTabIds = sameServer ? current.suppressedTabIds : new Set<string>();
    let recentlySeenUrls = current.recentlySeenUrls;
    for (const snapshot of snapshots) {
      if (currentSuppressedTabIds.has(snapshot.tabId)) continue;
      const existing = sameServer
        ? (current.sessions[snapshot.tabId] ?? current.hostedSessions[snapshot.tabId])
        : undefined;
      const next = existing && existing.updatedAt > snapshot.updatedAt ? existing : snapshot;
      sessions[next.tabId] = next;
      recentlySeenUrls = rememberSnapshotUrl(recentlySeenUrls, next);
    }

    const hostedSessions: Record<string, PreviewSessionSnapshot> = {};
    for (const existing of Object.values(current.hostedSessions)) {
      if (currentSuppressedTabIds.has(existing.tabId)) continue;
      if (!sameServer && !hasStablePreviewTabIdentity(existing.tabId)) continue;
      hostedSessions[existing.tabId] = existing;
    }
    for (const snapshot of Object.values(sessions)) {
      hostedSessions[snapshot.tabId] = snapshot;
    }

    const fallback = latestSnapshot(sessions);
    const activeTabId =
      current.activeTabId && sessions[current.activeTabId]
        ? current.activeTabId
        : (fallback?.tabId ?? null);
    const snapshot = activeTabId ? (sessions[activeTabId] ?? null) : null;
    const desktopByTabId = Object.fromEntries(
      Object.entries(current.desktopByTabId).filter(
        ([tabId]) =>
          hostedSessions[tabId] !== undefined && (sameServer || hasStablePreviewTabIdentity(tabId)),
      ),
    );
    const suppressedTabIds = new Set(
      [...currentSuppressedTabIds].filter((tabId) =>
        snapshots.some((snapshot) => snapshot.tabId === tabId),
      ),
    );
    return {
      ...current,
      sessions,
      hostedSessions,
      suppressedTabIds,
      activeTabId,
      snapshot,
      desktopByTabId,
      desktopOverlay: activeTabId ? (desktopByTabId[activeTabId] ?? null) : null,
      recentlySeenUrls,
      serverEpoch: result.serverEpoch,
      serverRevision: result.revision,
    };
  });
}

/**
 * Hydrate every persisted guest from one environment-wide list response.
 * The query reruns for each transport generation, so an open event missed
 * while disconnected is still materialized without routing to its thread.
 */
export function reconcilePreviewEnvironmentSessions(
  environmentId: EnvironmentId,
  result: PreviewListResult,
): void {
  if (!recordPreviewEnvironmentCatchup(environmentId, result)) return;
  const sessionsByThreadId = new Map<string, PreviewSessionSnapshot[]>();
  for (const snapshot of result.sessions) {
    const sessions = sessionsByThreadId.get(snapshot.threadId);
    if (sessions) sessions.push(snapshot);
    else sessionsByThreadId.set(snapshot.threadId, [snapshot]);
  }

  const threadIds = new Set(sessionsByThreadId.keys());
  for (const threadKey of Object.keys(readActivePreviewSessions())) {
    const ref = parseScopedThreadKey(threadKey);
    if (ref?.environmentId === environmentId) threadIds.add(ref.threadId);
  }

  for (const threadId of threadIds) {
    const ref = scopeThreadRef(environmentId, ThreadId.make(threadId));
    const sessions = sessionsByThreadId.get(threadId) ?? [];
    reconcilePreviewServerSessions(ref, {
      ...result,
      sessions,
    });
    const listedTabIds = new Set(sessions.map((snapshot) => snapshot.tabId));
    updateThreadPreviewState(ref, (current) => {
      if (current.serverEpoch === result.serverEpoch && current.serverRevision > result.revision) {
        return {
          ...current,
          hostSyncGeneration: current.hostSyncGeneration + 1,
        };
      }
      let adopted = current;
      for (const tabId of Object.keys(adopted.hostedSessions)) {
        if (!listedTabIds.has(tabId)) adopted = removeSession(adopted, tabId);
      }
      return {
        ...adopted,
        hostSyncGeneration: current.hostSyncGeneration + 1,
      };
    });
  }
}

export function applyPreviewDesktopState(
  ref: ScopedThreadRef,
  tabId: string,
  overlay: DesktopPreviewOverlay | null,
): void {
  updateThreadPreviewState(ref, (current) => {
    const desktopByTabId = { ...current.desktopByTabId };
    if (overlay) desktopByTabId[tabId] = overlay;
    else delete desktopByTabId[tabId];
    return {
      ...current,
      desktopByTabId,
      desktopOverlay: current.activeTabId === tabId ? overlay : current.desktopOverlay,
    };
  });
}

/**
 * Records the held downloads a remote frame reported for one tab.
 *
 * Called on every mirror tick, so an unchanged answer must not produce a new
 * state object — the prompt and the composer banner would re-render at the
 * frame cadence for nothing.
 */
export function applyPreviewRemoteDownloadApprovals(
  ref: ScopedThreadRef,
  tabId: string,
  approvals: ReadonlyArray<PreviewDownloadApproval>,
): void {
  updateThreadPreviewState(ref, (current) => {
    const existing = current.remoteApprovalsByTabId[tabId];
    const unchanged =
      (existing === undefined && approvals.length === 0) ||
      (existing !== undefined &&
        existing.length === approvals.length &&
        existing.every((held, index) => held.id === approvals[index]?.id));
    if (unchanged) return current;
    const remoteApprovalsByTabId = { ...current.remoteApprovalsByTabId };
    if (approvals.length === 0) delete remoteApprovalsByTabId[tabId];
    else remoteApprovalsByTabId[tabId] = approvals;
    return { ...current, remoteApprovalsByTabId };
  });
}

export function beginPreviewSessionClose(ref: ScopedThreadRef, tabId: string): void {
  updateThreadPreviewState(ref, (current) => {
    const suppressedTabIds = new Set(current.suppressedTabIds);
    suppressedTabIds.add(tabId);
    return {
      ...removeSession(current, tabId),
      suppressedTabIds,
    };
  });
}

export function cancelPreviewSessionClose(
  ref: ScopedThreadRef,
  snapshot: PreviewSessionSnapshot | null,
  tabId: string,
): void {
  updateThreadPreviewState(ref, (current) => {
    if (!current.suppressedTabIds.has(tabId)) return current;
    const suppressedTabIds = new Set(current.suppressedTabIds);
    suppressedTabIds.delete(tabId);
    if (!snapshot) {
      return { ...current, suppressedTabIds };
    }
    const recentlySeenUrls =
      snapshot.navStatus._tag !== "Idle"
        ? dedupeRecentUrls(current.recentlySeenUrls, snapshot.navStatus.url)
        : current.recentlySeenUrls;
    return {
      ...current,
      snapshot,
      sessions: { ...current.sessions, [snapshot.tabId]: snapshot },
      hostedSessions: { ...current.hostedSessions, [snapshot.tabId]: snapshot },
      suppressedTabIds,
      activeTabId: snapshot.tabId,
      desktopOverlay: current.desktopByTabId[snapshot.tabId] ?? null,
      recentlySeenUrls,
    };
  });
}

export function setActivePreviewTab(ref: ScopedThreadRef, tabId: string): void {
  updateThreadPreviewState(ref, (current) => {
    const snapshot = current.sessions[tabId];
    if (!snapshot || current.activeTabId === tabId) return current;
    return {
      ...current,
      activeTabId: tabId,
      snapshot,
      desktopOverlay: current.desktopByTabId[tabId] ?? null,
    };
  });
}

export function rememberPreviewUrl(ref: ScopedThreadRef, url: string): void {
  if (url.trim().length === 0) return;
  updateThreadPreviewState(ref, (current) => ({
    ...current,
    recentlySeenUrls: dedupeRecentUrls(current.recentlySeenUrls, url),
  }));
}

export function removePreviewThread(ref: ScopedThreadRef): void {
  const threadKey = scopedThreadKey(ref);
  appAtomRegistry.set(previewStateAtom(threadKey), EMPTY_THREAD_PREVIEW_STATE);
  syncActivePreviewThread(threadKey, EMPTY_THREAD_PREVIEW_STATE);
  changedPreviewThreadKeys.delete(threadKey);
}

/**
 * Whether this runtime can show a browser preview at all.
 *
 * It used to mean "does this client have a desktop bridge", because a guest
 * was an Electron `<webview>` and a client without one had nothing to render.
 * A client with no guest of its own now mirrors the machine that is hosting
 * it, so the browser is available here too — what a plain browser lacks is a
 * guest of its own, not a way to see one.
 */
export function isPreviewSupportedInRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return true;
}

export function resetPreviewStateForTests(): void {
  for (const threadKey of changedPreviewThreadKeys) {
    appAtomRegistry.set(previewStateAtom(threadKey), EMPTY_THREAD_PREVIEW_STATE);
  }
  changedPreviewThreadKeys.clear();
  previewEnvironmentClocks.clear();
  appAtomRegistry.set(activePreviewThreadKeysAtom, { keys: new Set<string>() });
}

export const __testing = {
  EMPTY_THREAD_PREVIEW_STATE,
  RECENT_URL_LIMIT: PREVIEW_RECENT_URL_LIMIT,
};
