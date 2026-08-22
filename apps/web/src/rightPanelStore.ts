/**
 * Thread-scoped right-panel surface state.
 *
 * This is intentionally a shallow workspace model: it owns an ordered set of
 * surface descriptors and the active surface, while each feature continues to
 * own its durable resource state. Browser surfaces point at preview tab ids,
 * terminal surfaces point at terminal session ids, file surfaces point at
 * workspace paths, and diff/plan/files remain singleton surfaces.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export const RIGHT_PANEL_KINDS = [
  "plan",
  "diff",
  "files",
  "file",
  "preview",
  "terminal",
  "side-chat",
  "artifact",
] as const;
export type RightPanelKind = (typeof RIGHT_PANEL_KINDS)[number];

type RightPanelSurfaceDescriptor =
  | { id: `browser:${string}`; kind: "preview"; resourceId: string }
  | { id: "browser:new"; kind: "preview"; resourceId: null }
  | {
      id: `terminal:${string}`;
      kind: "terminal";
      resourceId: string;
      terminalIds: string[];
      activeTerminalId: string;
      splitDirection?: "horizontal" | "vertical";
    }
  | { id: "diff"; kind: "diff" }
  | { id: "files"; kind: "files" }
  | { id: `side-chat:${string}`; kind: "side-chat"; resourceId: string; title: string }
  | {
      id: `artifact:${string}`;
      kind: "artifact";
      resourceId: string;
      revision: number;
      title: string;
    }
  | {
      id: `file:${string}`;
      kind: "file";
      relativePath: string;
      revealLine: number | null;
      revealRequestId: number;
    }
  | { id: "plan"; kind: "plan" };

export type RightPanelSurface = RightPanelSurfaceDescriptor & {
  /** User-owned tab title. Missing means the live resource-derived title wins. */
  customTitle?: string;
};

const RIGHT_PANEL_STORAGE_KEY = "t3code:right-panel-state:v2";
const RIGHT_PANEL_STORAGE_VERSION = 10;

export interface ThreadRightPanelState {
  isOpen: boolean;
  activeSurfaceId: string | null;
  surfaces: RightPanelSurface[];
}

interface RightPanelStoreState {
  byThreadKey: Record<string, ThreadRightPanelState>;
  /**
   * Side chats opened locally that the server shell list has not confirmed
   * yet, keyed by thread key then side-chat thread id → spawn timestamp (ms).
   * Reconciliation keeps these surfaces alive during the projection gap so a
   * freshly spawned tab is not dropped (and its activation reverted) by a
   * reconcile pass that runs off a stale shell list. Not persisted.
   */
  pendingSideChatSpawnsByThreadKey: Record<string, Record<string, number>>;
  open: (
    ref: ScopedThreadRef,
    kind: Exclude<RightPanelKind, "file" | "terminal" | "side-chat" | "artifact">,
  ) => void;
  /**
   * Opens the panel without adding a surface. The agents & tasks section lives
   * in this column and outlives every tab, so it needs a way in that does not
   * fabricate a browser or terminal to hold the door.
   */
  setOpen: (ref: ScopedThreadRef, open: boolean) => void;
  openBrowser: (ref: ScopedThreadRef, tabId: string | null) => void;
  openFile: (ref: ScopedThreadRef, relativePath: string, line?: number) => void;
  openTerminal: (ref: ScopedThreadRef, terminalId: string) => void;
  openSideChat: (ref: ScopedThreadRef, sideChatThreadId: string, title: string) => void;
  openArtifact: (ref: ScopedThreadRef, artifactId: string, revision: number, title: string) => void;
  updateArtifactRevision: (
    ref: ScopedThreadRef,
    artifactId: string,
    revision: number,
    title: string,
  ) => void;
  splitTerminal: (
    ref: ScopedThreadRef,
    surfaceId: string,
    terminalId: string,
    direction?: "horizontal" | "vertical",
  ) => void;
  activateTerminal: (ref: ScopedThreadRef, surfaceId: string, terminalId: string) => void;
  closeTerminal: (ref: ScopedThreadRef, surfaceId: string, terminalId: string) => void;
  activateSurface: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeSurface: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeOtherSurfaces: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeSurfacesToRight: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeAllSurfaces: (ref: ScopedThreadRef) => void;
  renameSurface: (ref: ScopedThreadRef, surfaceId: string, title: string) => void;
  /**
   * Moves a tab so it lands where `overSurfaceId` currently sits. Tab order is
   * the `surfaces` array order, which already persists, so dragging needs no
   * companion store.
   */
  reorderSurface: (ref: ScopedThreadRef, surfaceId: string, overSurfaceId: string) => void;
  reconcileBrowserSurfaces: (ref: ScopedThreadRef, tabIds: readonly string[]) => void;
  reconcileFileSurfaces: (ref: ScopedThreadRef, workspaceAvailable: boolean) => void;
  reconcileSideChatSurfaces: (
    ref: ScopedThreadRef,
    sideChats: ReadonlyArray<{ threadId: string; title: string }>,
    now?: number,
  ) => void;
  show: (ref: ScopedThreadRef) => void;
  close: (ref: ScopedThreadRef) => void;
  toggleVisibility: (ref: ScopedThreadRef) => void;
  toggle: (
    ref: ScopedThreadRef,
    kind: Exclude<RightPanelKind, "file" | "terminal" | "side-chat" | "artifact">,
  ) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

const EMPTY_THREAD_STATE: ThreadRightPanelState = {
  isOpen: false,
  activeSurfaceId: null,
  surfaces: [],
};

const singletonSurface = (
  kind: Exclude<RightPanelKind, "file" | "preview" | "terminal" | "side-chat" | "artifact">,
): RightPanelSurface => {
  switch (kind) {
    case "diff":
      return { id: "diff", kind };
    case "files":
      return { id: "files", kind };
    case "plan":
      return { id: "plan", kind };
  }
};

const browserSurface = (tabId: string | null): RightPanelSurface =>
  tabId
    ? { id: `browser:${tabId}`, kind: "preview", resourceId: tabId }
    : { id: "browser:new", kind: "preview", resourceId: null };

const fileSurface = (
  relativePath: string,
  revealLine: number | null,
  revealRequestId: number,
): RightPanelSurface => ({
  id: `file:${relativePath}`,
  kind: "file",
  relativePath,
  revealLine,
  revealRequestId,
});

const terminalSurface = (terminalId: string): RightPanelSurface => ({
  id: `terminal:${terminalId}`,
  kind: "terminal",
  resourceId: terminalId,
  terminalIds: [terminalId],
  activeTerminalId: terminalId,
});

type SideChatSurface = Extract<RightPanelSurface, { kind: "side-chat" }>;

/**
 * How long a locally opened side chat may stay unconfirmed by the server
 * shell list before reconciliation is allowed to drop its surface. The fork
 * mutation ack races the thread-shell projection, and the reconcile effect
 * re-runs on every unrelated shell update, so without this grace window a
 * freshly spawned side chat is routinely removed (and its tab deactivated)
 * before its own shell event lands.
 */
export const SIDE_CHAT_SPAWN_CONFIRMATION_GRACE_MS = 30_000;

const sideChatSurface = (threadId: string, title: string): SideChatSurface => ({
  id: `side-chat:${threadId}`,
  kind: "side-chat",
  resourceId: threadId,
  title,
});

const artifactSurface = (
  artifactId: string,
  revision: number,
  title: string,
): Extract<RightPanelSurface, { kind: "artifact" }> => ({
  id: `artifact:${artifactId}`,
  kind: "artifact",
  resourceId: artifactId,
  revision,
  title,
});

/**
 * Moves `surfaceId` to the index `overSurfaceId` occupies, shifting the tabs
 * in between. Returns the original array when either id is unknown or the move
 * is a no-op so callers can skip a store write.
 */
export function reorderSurfaces(
  surfaces: readonly RightPanelSurface[],
  surfaceId: string,
  overSurfaceId: string,
): readonly RightPanelSurface[] {
  const from = surfaces.findIndex((surface) => surface.id === surfaceId);
  const to = surfaces.findIndex((surface) => surface.id === overSurfaceId);
  if (from < 0 || to < 0 || from === to) return surfaces;
  const next = [...surfaces];
  const [moved] = next.splice(from, 1);
  if (!moved) return surfaces;
  next.splice(to, 0, moved);
  return next;
}

const upsertSurface = (
  current: ThreadRightPanelState,
  surface: RightPanelSurface,
  activate = true,
): ThreadRightPanelState => ({
  isOpen: true,
  surfaces: current.surfaces.some((entry) => entry.id === surface.id)
    ? current.surfaces
    : [...current.surfaces, surface],
  activeSurfaceId: activate ? surface.id : current.activeSurfaceId,
});

const updateThread = (
  byThreadKey: Record<string, ThreadRightPanelState>,
  threadKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
): Record<string, ThreadRightPanelState> => {
  const current = byThreadKey[threadKey] ?? EMPTY_THREAD_STATE;
  const next = updater(current);
  if (!next.isOpen && next.activeSurfaceId === null && next.surfaces.length === 0) {
    if (!(threadKey in byThreadKey)) return byThreadKey;
    const { [threadKey]: _removed, ...rest } = byThreadKey;
    return rest;
  }
  if (next === current) return byThreadKey;
  return { ...byThreadKey, [threadKey]: next };
};

function normalizeRevealLine(line: number | undefined): number | null {
  if (line === undefined || !Number.isFinite(line)) return null;
  return Math.max(1, Math.trunc(line));
}

function withCustomSurfaceTitle(surface: RightPanelSurface, title: string): RightPanelSurface {
  const customTitle = title.trim();
  if (customTitle.length > 0) {
    return surface.customTitle === customTitle ? surface : { ...surface, customTitle };
  }
  if (surface.customTitle === undefined) return surface;
  const { customTitle: _customTitle, ...defaultTitledSurface } = surface;
  return defaultTitledSurface as RightPanelSurface;
}

function normalizePersistedSurfaceCustomTitle(surface: RightPanelSurface): RightPanelSurface {
  return withCustomSurfaceTitle(
    surface,
    typeof surface.customTitle === "string" ? surface.customTitle : "",
  );
}

export function migratePersistedRightPanelState(persistedState: unknown): {
  byThreadKey: Record<string, ThreadRightPanelState>;
} {
  if (!persistedState || typeof persistedState !== "object") {
    return { byThreadKey: {} };
  }
  const byThreadKey =
    "byThreadKey" in persistedState &&
    persistedState.byThreadKey &&
    typeof persistedState.byThreadKey === "object"
      ? Object.fromEntries(
          Object.entries(persistedState.byThreadKey as Record<string, ThreadRightPanelState>).map(
            ([threadKey, threadState]) => {
              const validThreadState =
                threadState && typeof threadState === "object" ? threadState : null;
              const surfaces = Array.isArray(validThreadState?.surfaces)
                ? validThreadState.surfaces
                    .flatMap<RightPanelSurface>((surface) => {
                      if (surface.kind === "file") {
                        const revealLine =
                          typeof surface.revealLine === "number" &&
                          Number.isFinite(surface.revealLine)
                            ? Math.max(1, Math.trunc(surface.revealLine))
                            : null;
                        const revealRequestId =
                          typeof surface.revealRequestId === "number" &&
                          Number.isSafeInteger(surface.revealRequestId) &&
                          surface.revealRequestId >= 0
                            ? surface.revealRequestId
                            : 0;
                        return [{ ...surface, revealLine, revealRequestId }];
                      }
                      if (surface.kind === "side-chat") {
                        if (
                          !("resourceId" in surface) ||
                          typeof surface.resourceId !== "string" ||
                          surface.id !== `side-chat:${surface.resourceId}` ||
                          !("title" in surface) ||
                          typeof surface.title !== "string"
                        ) {
                          return [];
                        }
                        return [surface];
                      }
                      if (surface.kind === "artifact") {
                        if (
                          !("resourceId" in surface) ||
                          typeof surface.resourceId !== "string" ||
                          surface.resourceId.length === 0 ||
                          surface.id !== `artifact:${surface.resourceId}` ||
                          !("revision" in surface) ||
                          typeof surface.revision !== "number" ||
                          !Number.isSafeInteger(surface.revision) ||
                          surface.revision < 1 ||
                          !("title" in surface) ||
                          typeof surface.title !== "string" ||
                          surface.title.trim().length === 0
                        ) {
                          return [];
                        }
                        return [{ ...surface, title: surface.title.trim() }];
                      }
                      if (surface.kind !== "terminal") return [surface];
                      if (
                        !("resourceId" in surface) ||
                        typeof surface.resourceId !== "string" ||
                        surface.id !== `terminal:${surface.resourceId}`
                      ) {
                        return [];
                      }
                      const terminalIds =
                        "terminalIds" in surface && Array.isArray(surface.terminalIds)
                          ? [
                              ...new Set(
                                surface.terminalIds.filter(
                                  (terminalId): terminalId is string =>
                                    typeof terminalId === "string",
                                ),
                              ),
                            ]
                          : [surface.resourceId];
                      const activeTerminalId =
                        "activeTerminalId" in surface &&
                        typeof surface.activeTerminalId === "string" &&
                        terminalIds.includes(surface.activeTerminalId)
                          ? surface.activeTerminalId
                          : (terminalIds[0] ?? surface.resourceId);
                      return [
                        {
                          ...surface,
                          terminalIds: terminalIds.length > 0 ? terminalIds : [surface.resourceId],
                          activeTerminalId,
                        },
                      ];
                    })
                    .map(normalizePersistedSurfaceCustomTitle)
                : [];
              const activeSurfaceId = surfaces.some(
                (surface) => surface.id === validThreadState?.activeSurfaceId,
              )
                ? (validThreadState?.activeSurfaceId ?? null)
                : null;
              const isOpen =
                typeof validThreadState?.isOpen === "boolean"
                  ? validThreadState.isOpen
                  : activeSurfaceId !== null;
              return [threadKey, { isOpen, surfaces, activeSurfaceId }];
            },
          ),
        )
      : {};
  return { byThreadKey };
}

export const useRightPanelStore = create<RightPanelStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      pendingSideChatSpawnsByThreadKey: {},
      open: (ref, kind) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            if (kind === "preview") {
              const existing = current.surfaces.find((surface) => surface.kind === "preview");
              return upsertSurface(current, existing ?? browserSurface(null));
            }
            return upsertSurface(current, singletonSurface(kind));
          }),
        })),
      setOpen: (ref, open) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            current.isOpen === open ? current : { ...current, isOpen: open },
          ),
        })),
      openBrowser: (ref, tabId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const surface = browserSurface(tabId);
            const withoutPlaceholder = tabId
              ? current.surfaces.filter((entry) => entry.id !== "browser:new")
              : current.surfaces;
            return upsertSurface({ ...current, surfaces: withoutPlaceholder }, surface);
          }),
        })),
      openFile: (ref, relativePath, line) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const withoutStandaloneExplorer = current.surfaces.filter(
              (surface) => surface.kind !== "files",
            );
            const surfaceId = `file:${relativePath}` as const;
            const existing = withoutStandaloneExplorer.find(
              (surface): surface is Extract<RightPanelSurface, { kind: "file" }> =>
                surface.id === surfaceId && surface.kind === "file",
            );
            const nextSurface = fileSurface(
              relativePath,
              normalizeRevealLine(line),
              (existing?.revealRequestId ?? 0) + 1,
            );
            const surface = existing?.customTitle
              ? { ...nextSurface, customTitle: existing.customTitle }
              : nextSurface;
            return {
              isOpen: true,
              activeSurfaceId: surface.id,
              surfaces: existing
                ? withoutStandaloneExplorer.map((entry) =>
                    entry.id === surface.id ? surface : entry,
                  )
                : [...withoutStandaloneExplorer, surface],
            };
          }),
        })),
      openTerminal: (ref, terminalId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            upsertSurface(current, terminalSurface(terminalId)),
          ),
        })),
      openSideChat: (ref, sideChatThreadId, title) => {
        const threadKey = scopedThreadKey(ref);
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, threadKey, (current) =>
            upsertSurface(current, sideChatSurface(sideChatThreadId, title)),
          ),
          pendingSideChatSpawnsByThreadKey: {
            ...state.pendingSideChatSpawnsByThreadKey,
            [threadKey]: {
              ...state.pendingSideChatSpawnsByThreadKey[threadKey],
              [sideChatThreadId]: Date.now(),
            },
          },
        }));
      },
      openArtifact: (ref, artifactId, revision, title) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const surface = artifactSurface(artifactId, revision, title);
            const existing = current.surfaces.find((entry) => entry.id === surface.id);
            if (!existing || existing.kind !== "artifact") return upsertSurface(current, surface);
            return {
              ...current,
              isOpen: true,
              activeSurfaceId: existing.id,
              surfaces: current.surfaces.map((entry) =>
                entry.id === existing.id
                  ? {
                      ...existing,
                      title,
                      revision: Math.max(existing.revision, revision),
                    }
                  : entry,
              ),
            };
          }),
        })),
      updateArtifactRevision: (ref, artifactId, revision, title) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => ({
            ...current,
            isOpen: true,
            activeSurfaceId: `artifact:${artifactId}`,
            surfaces: current.surfaces.some(
              (entry) => entry.kind === "artifact" && entry.resourceId === artifactId,
            )
              ? current.surfaces.map((entry) =>
                  entry.kind === "artifact" && entry.resourceId === artifactId
                    ? { ...entry, revision, title }
                    : entry,
                )
              : [...current.surfaces, artifactSurface(artifactId, revision, title)],
          })),
        })),
      splitTerminal: (ref, surfaceId, terminalId, direction = "horizontal") =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => ({
            ...current,
            isOpen: true,
            activeSurfaceId: surfaceId,
            surfaces: current.surfaces.map((surface) => {
              if (surface.id !== surfaceId || surface.kind !== "terminal") return surface;
              const { splitDirection: _splitDirection, ...baseSurface } = surface;
              return {
                ...baseSurface,
                terminalIds: surface.terminalIds.includes(terminalId)
                  ? surface.terminalIds
                  : [...surface.terminalIds, terminalId],
                activeTerminalId: terminalId,
                ...(direction === "vertical" ? { splitDirection: "vertical" as const } : {}),
              };
            }),
          })),
        })),
      activateTerminal: (ref, surfaceId, terminalId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => ({
            ...current,
            activeSurfaceId: surfaceId,
            surfaces: current.surfaces.map((surface) =>
              surface.id === surfaceId &&
              surface.kind === "terminal" &&
              surface.terminalIds.includes(terminalId)
                ? { ...surface, activeTerminalId: terminalId }
                : surface,
            ),
          })),
        })),
      closeTerminal: (ref, surfaceId, terminalId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const surface = current.surfaces.find(
              (entry) => entry.id === surfaceId && entry.kind === "terminal",
            );
            if (!surface || surface.kind !== "terminal") return current;
            const terminalIds = surface.terminalIds.filter((id) => id !== terminalId);
            if (terminalIds.length === 0) {
              const index = current.surfaces.findIndex((entry) => entry.id === surfaceId);
              const surfaces = current.surfaces.filter((entry) => entry.id !== surfaceId);
              const fallback = surfaces[Math.min(index, surfaces.length - 1)] ?? null;
              return {
                ...current,
                isOpen: current.isOpen,
                surfaces,
                activeSurfaceId:
                  current.activeSurfaceId === surfaceId
                    ? (fallback?.id ?? null)
                    : current.activeSurfaceId,
              };
            }
            return {
              ...current,
              surfaces: current.surfaces.map((entry) =>
                entry.id === surfaceId && entry.kind === "terminal"
                  ? {
                      ...entry,
                      terminalIds,
                      activeTerminalId:
                        entry.activeTerminalId === terminalId
                          ? (terminalIds.at(-1) ?? terminalIds[0]!)
                          : entry.activeTerminalId,
                    }
                  : entry,
              ),
            };
          }),
        })),
      activateSurface: (ref, surfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            current.surfaces.some((surface) => surface.id === surfaceId)
              ? { ...current, isOpen: true, activeSurfaceId: surfaceId }
              : current,
          ),
        })),
      closeSurface: (ref, surfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (index < 0) return current;
            const surfaces = current.surfaces.filter((surface) => surface.id !== surfaceId);
            if (current.activeSurfaceId !== surfaceId) {
              return { ...current, isOpen: current.isOpen, surfaces };
            }
            const fallback = surfaces[Math.min(index, surfaces.length - 1)] ?? null;
            return {
              ...current,
              isOpen: current.isOpen,
              surfaces,
              activeSurfaceId: fallback?.id ?? null,
            };
          }),
        })),
      closeOtherSurfaces: (ref, surfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const surface = current.surfaces.find((entry) => entry.id === surfaceId);
            if (!surface || current.surfaces.length === 1) return current;
            return {
              ...current,
              isOpen: true,
              surfaces: [surface],
              activeSurfaceId: surface.id,
            };
          }),
        })),
      closeSurfacesToRight: (ref, surfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (index < 0 || index === current.surfaces.length - 1) return current;
            const surfaces = current.surfaces.slice(0, index + 1);
            const activeStillExists = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            );
            return {
              ...current,
              surfaces,
              activeSurfaceId: activeStillExists ? current.activeSurfaceId : surfaceId,
            };
          }),
        })),
      closeAllSurfaces: (ref) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            // Deliberately keeps isOpen: the agents & tasks section lives in
            // this column and persists across every tab closing, so emptying
            // the tabs must not take the column with it.
            current.surfaces.length === 0
              ? current
              : { ...current, surfaces: [], activeSurfaceId: null },
          ),
        })),
      renameSurface: (ref, surfaceId, title) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const surfaceIndex = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (surfaceIndex < 0) return current;
            const surface = current.surfaces[surfaceIndex];
            if (!surface) return current;
            const renamedSurface = withCustomSurfaceTitle(surface, title);
            if (renamedSurface === surface) return current;
            const surfaces = [...current.surfaces];
            surfaces[surfaceIndex] = renamedSurface;
            return { ...current, surfaces };
          }),
        })),
      reorderSurface: (ref, surfaceId, overSurfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const surfaces = reorderSurfaces(current.surfaces, surfaceId, overSurfaceId);
            return surfaces === current.surfaces
              ? current
              : { ...current, surfaces: [...surfaces] };
          }),
        })),
      reconcileBrowserSurfaces: (ref, tabIds) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const validIds = new Set(tabIds.map((tabId) => `browser:${tabId}`));
            const nonBrowser = current.surfaces.filter((surface) => surface.kind !== "preview");
            const existingBrowser = current.surfaces.filter(
              (surface): surface is Extract<RightPanelSurface, { kind: "preview" }> =>
                surface.kind === "preview" &&
                surface.id !== "browser:new" &&
                validIds.has(surface.id),
            );
            const knownIds = new Set(existingBrowser.map((surface) => surface.id));
            const added = tabIds
              .filter((tabId) => !knownIds.has(`browser:${tabId}`))
              .map((tabId) => browserSurface(tabId));
            const surfaces = [...nonBrowser, ...existingBrowser, ...added];
            const activeStillExists = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            );
            const fallbackBrowser = surfaces.find((surface) => surface.kind === "preview");
            return {
              ...current,
              surfaces,
              activeSurfaceId: activeStillExists
                ? current.activeSurfaceId
                : (fallbackBrowser?.id ?? surfaces[0]?.id ?? null),
            };
          }),
        })),
      reconcileFileSurfaces: (ref, workspaceAvailable) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            if (workspaceAvailable) return current;
            const surfaces = current.surfaces.filter(
              (surface) => surface.kind !== "files" && surface.kind !== "file",
            );
            if (surfaces.length === current.surfaces.length) return current;
            const activeStillExists = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            );
            return {
              ...current,
              isOpen: current.isOpen,
              surfaces,
              activeSurfaceId: activeStillExists
                ? current.activeSurfaceId
                : (surfaces.at(-1)?.id ?? null),
            };
          }),
        })),
      reconcileSideChatSurfaces: (ref, sideChats, now = Date.now()) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const expectedById = new Map<SideChatSurface["id"], SideChatSurface>(
            sideChats.map((sideChat) => [
              `side-chat:${sideChat.threadId}` as const,
              sideChatSurface(sideChat.threadId, sideChat.title),
            ]),
          );
          // Locally spawned side chats stay pending until the server shell
          // list confirms them (or the grace window lapses). The reconcile
          // effect re-runs on every unrelated shell update, so without this
          // a fresh spawn is dropped — and its activation reverted — while
          // its shell event is still in flight.
          const pending = state.pendingSideChatSpawnsByThreadKey[threadKey] ?? {};
          const nextPending: Record<string, number> = {};
          for (const [threadId, spawnedAt] of Object.entries(pending)) {
            if (expectedById.has(`side-chat:${threadId}`)) continue; // confirmed
            if (now - spawnedAt > SIDE_CHAT_SPAWN_CONFIRMATION_GRACE_MS) continue; // expired
            nextPending[threadId] = spawnedAt;
          }
          const pendingChanged = Object.keys(pending).length !== Object.keys(nextPending).length;
          const pendingSideChatSpawnsByThreadKey = pendingChanged
            ? Object.keys(nextPending).length > 0
              ? { ...state.pendingSideChatSpawnsByThreadKey, [threadKey]: nextPending }
              : (({ [threadKey]: _removed, ...rest }) => rest)(
                  state.pendingSideChatSpawnsByThreadKey,
                )
            : state.pendingSideChatSpawnsByThreadKey;
          const byThreadKey = updateThread(state.byThreadKey, threadKey, (current) => {
            // The server shell list is authoritative for confirmed side
            // chats. Keeping a missing confirmed side chat turns a completed
            // delete into a zombie composer: the stale surface can still
            // dispatch commands to a tombstoned thread, but no provider
            // reactor can ever adopt that turn. Unconfirmed pending spawns
            // are the one exception, bounded by the grace window above.
            const surfaces: RightPanelSurface[] = [];
            for (const surface of current.surfaces) {
              if (surface.kind !== "side-chat") {
                surfaces.push(surface);
                continue;
              }
              const expected = expectedById.get(surface.id);
              if (!expected) {
                if (nextPending[surface.resourceId] !== undefined) surfaces.push(surface);
                continue;
              }
              surfaces.push(
                expected.title === surface.title
                  ? surface
                  : surface.customTitle
                    ? { ...expected, customTitle: surface.customTitle }
                    : expected,
              );
            }
            const knownIds = new Set(surfaces.map((surface) => surface.id));
            for (const [surfaceId, surface] of expectedById) {
              if (!knownIds.has(surfaceId)) surfaces.push(surface);
            }
            const activeStillExists = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            );
            if (
              surfaces.length === current.surfaces.length &&
              activeStillExists &&
              surfaces.every((surface, index) => surface === current.surfaces[index])
            ) {
              return current;
            }
            return {
              ...current,
              surfaces,
              activeSurfaceId: activeStillExists
                ? current.activeSurfaceId
                : (surfaces.at(-1)?.id ?? null),
            };
          });
          return { byThreadKey, pendingSideChatSpawnsByThreadKey };
        }),
      show: (ref) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            current.isOpen ? current : { ...current, isOpen: true },
          ),
        })),
      close: (ref) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            current.isOpen ? { ...current, isOpen: false } : current,
          ),
        })),
      toggleVisibility: (ref) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => ({
            ...current,
            isOpen: !current.isOpen,
          })),
        })),
      toggle: (ref, kind) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const active = current.surfaces.find(
              (surface) => surface.id === current.activeSurfaceId,
            );
            if (current.isOpen && active?.kind === kind) {
              return { ...current, isOpen: false };
            }
            if (kind === "preview") {
              const existing = current.surfaces.find((surface) => surface.kind === "preview");
              return upsertSurface(current, existing ?? browserSurface(null));
            }
            return upsertSurface(current, singletonSurface(kind));
          }),
        })),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (!(threadKey in state.byThreadKey)) return state;
          const { [threadKey]: _removed, ...rest } = state.byThreadKey;
          return { byThreadKey: rest };
        }),
    }),
    {
      name: RIGHT_PANEL_STORAGE_KEY,
      version: RIGHT_PANEL_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byThreadKey: state.byThreadKey }),
      migrate: migratePersistedRightPanelState,
    },
  ),
);

export function selectThreadRightPanelState(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): ThreadRightPanelState {
  if (!ref) return EMPTY_THREAD_STATE;
  return byThreadKey[scopedThreadKey(ref)] ?? EMPTY_THREAD_STATE;
}

export function selectActiveRightPanel(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelKind | null {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  if (!state.isOpen) return null;
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId)?.kind ?? null;
}

export function selectActiveRightPanelSurface(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelSurface | null {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  if (!state.isOpen) return null;
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId) ?? null;
}
