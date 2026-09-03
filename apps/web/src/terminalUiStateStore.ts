/**
 * Single Zustand store for terminal UI state keyed by scoped thread identity.
 *
 * Terminal UI transition helpers are intentionally private to keep the public
 * API constrained to store actions/selectors.
 */

import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  type ScopedThreadRef,
  type TerminalLayoutGroup,
  type TerminalPaneNode,
} from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { resolveStorage } from "./lib/storage";
import {
  copyLayout,
  insertTerminalBeside,
  layoutLeafIds,
  layoutsEqual,
  type ListDropPlacement,
  moveTerminalInLayout,
  normalizeGroupLayout,
  type PaneDropZone,
  removeTerminalFromLayout,
  setLayoutSizesAtPath,
  splitLayoutAtTerminal,
} from "./terminalPaneLayout";
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  BROWSER_PANE_ID,
  isBrowserPaneId,
  MAX_TERMINALS_PER_GROUP,
  type TerminalPaneLayout,
  type ThreadMainSurface,
  type ThreadTerminalGroup,
} from "./types";

interface ThreadTerminalUiState {
  mainSurface: ThreadMainSurface;
  /**
   * Opt-in tabbed single-pane chrome for terminal mode. Off by default so
   * the split/panel workspace stays the main surface.
   */
  terminalFullscreen: boolean;
  terminalHeight: number;
  /** Width of the group sidebar in pixels; clamped on normalization. */
  sidebarWidth: number;
  terminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalGroupId: string;
}

// Keep the old storage key so existing drawer layout preferences migrate.
const TERMINAL_UI_STATE_STORAGE_KEY = "t3code:terminal-state:v1";

interface PersistedTerminalUiStateStoreState {
  terminalUiStateByThreadKey?: Record<string, ThreadTerminalUiState>;
  terminalStateByThreadKey?: Record<string, ThreadTerminalUiState>;
  suppressedTerminalIdsByThreadKey?: Record<string, string[]>;
}

export function migratePersistedTerminalUiStateStoreState(
  persistedState: unknown,
  _version: number,
): PersistedTerminalUiStateStoreState {
  if (!persistedState || typeof persistedState !== "object") {
    return { terminalUiStateByThreadKey: {} };
  }

  const candidate = persistedState as PersistedTerminalUiStateStoreState;
  const persistedUiStateByThreadKey =
    candidate.terminalUiStateByThreadKey ?? candidate.terminalStateByThreadKey ?? {};
  const terminalUiStateByThreadKey = Object.fromEntries(
    Object.entries(persistedUiStateByThreadKey).flatMap(([threadKey, threadState]) => {
      if (!parseScopedThreadKey(threadKey) || !threadState || typeof threadState !== "object") {
        return [];
      }
      return [
        [threadKey, normalizeThreadTerminalUiState(threadState as ThreadTerminalUiState)] as const,
      ];
    }),
  );
  const suppressedTerminalIdsByThreadKey = Object.fromEntries(
    Object.entries(candidate.suppressedTerminalIdsByThreadKey ?? {}).flatMap(
      ([threadKey, terminalIds]) => {
        if (!parseScopedThreadKey(threadKey) || !Array.isArray(terminalIds)) {
          return [];
        }
        const normalizedTerminalIds = normalizeTerminalIds(
          terminalIds.filter((terminalId): terminalId is string => typeof terminalId === "string"),
        );
        return normalizedTerminalIds.length > 0
          ? [[threadKey, normalizedTerminalIds] as const]
          : [];
      },
    ),
  );

  return { terminalUiStateByThreadKey, suppressedTerminalIdsByThreadKey };
}

function createTerminalUiStateStorage() {
  return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);
}

function normalizeTerminalIds(terminalIds: string[]): string[] {
  const normalizedIds: string[] = [];
  const seen = new Set<string>();
  for (const id of terminalIds) {
    const trimmedId = id.trim();
    if (trimmedId.length === 0 || seen.has(trimmedId)) continue;
    seen.add(trimmedId);
    normalizedIds.push(trimmedId);
  }
  return normalizedIds;
}

function fallbackGroupId(terminalId: string): string {
  return `group-${terminalId}`;
}

function assignUniqueGroupId(baseId: string, usedGroupIds: Set<string>): string {
  let candidate = baseId;
  let index = 2;
  while (usedGroupIds.has(candidate)) {
    candidate = `${baseId}-${index}`;
    index += 1;
  }
  usedGroupIds.add(candidate);
  return candidate;
}

/**
 * Builds the canonical split tree for a group, migrating the legacy flat
 * direction/size fields when no tree is persisted yet.
 */
function groupLayout(group: ThreadTerminalGroup, terminalIds: readonly string[]) {
  return normalizeGroupLayout(group.layout, terminalIds, {
    ...(group.splitDirection !== undefined ? { splitDirection: group.splitDirection } : {}),
    ...(group.paneSizes !== undefined ? { paneSizes: group.paneSizes } : {}),
  });
}

function findGroupIndexByTerminalId(
  terminalGroups: ThreadTerminalGroup[],
  terminalId: string,
): number {
  return terminalGroups.findIndex((group) => group.terminalIds.includes(terminalId));
}

function normalizeTerminalGroupIds(terminalIds: string[]): string[] {
  return normalizeTerminalIds(terminalIds);
}

function normalizeTerminalGroups(
  terminalGroups: ThreadTerminalGroup[],
  terminalIds: string[],
): ThreadTerminalGroup[] {
  if (terminalIds.length === 0) {
    return [];
  }

  const validTerminalIdSet = new Set(terminalIds);
  const assignedTerminalIds = new Set<string>();
  const nextGroups: ThreadTerminalGroup[] = [];
  const usedGroupIds = new Set<string>();

  for (const group of terminalGroups) {
    const groupTerminalIds = normalizeTerminalGroupIds(group.terminalIds).filter((terminalId) => {
      if (!validTerminalIdSet.has(terminalId)) return false;
      if (assignedTerminalIds.has(terminalId)) return false;
      return true;
    });
    if (groupTerminalIds.length === 0) continue;
    for (const terminalId of groupTerminalIds) {
      assignedTerminalIds.add(terminalId);
    }
    const baseGroupId =
      group.id.trim().length > 0
        ? group.id.trim()
        : fallbackGroupId(groupTerminalIds[0] ?? terminalIds[0] ?? "");
    const layout = groupLayout(group, groupTerminalIds);
    const groupName =
      typeof group.name === "string" && group.name.trim().length > 0
        ? group.name.trim()
        : undefined;
    nextGroups.push({
      id: assignUniqueGroupId(baseGroupId, usedGroupIds),
      ...(groupName !== undefined ? { name: groupName } : {}),
      // Membership order mirrors the tree's leaf order so anchors, the
      // sidebar, and split caps all agree with what is on screen.
      terminalIds: layout ? layoutLeafIds(layout) : groupTerminalIds,
      ...(layout ? { layout } : {}),
    });
  }

  for (const terminalId of terminalIds) {
    if (assignedTerminalIds.has(terminalId)) continue;
    nextGroups.push({
      id: assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds),
      terminalIds: [terminalId],
    });
  }

  return nextGroups;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function terminalGroupsEqual(left: ThreadTerminalGroup[], right: ThreadTerminalGroup[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftGroup = left[index];
    const rightGroup = right[index];
    if (!leftGroup || !rightGroup) return false;
    if (leftGroup.id !== rightGroup.id) return false;
    if ((leftGroup.name ?? "") !== (rightGroup.name ?? "")) return false;
    if (!arraysEqual(leftGroup.terminalIds, rightGroup.terminalIds)) return false;
    if (!layoutsEqual(leftGroup.layout, rightGroup.layout)) return false;
  }
  return true;
}

function threadTerminalUiStateEqual(
  left: ThreadTerminalUiState,
  right: ThreadTerminalUiState,
): boolean {
  return (
    left.mainSurface === right.mainSurface &&
    left.terminalFullscreen === right.terminalFullscreen &&
    left.terminalHeight === right.terminalHeight &&
    left.sidebarWidth === right.sidebarWidth &&
    left.activeTerminalId === right.activeTerminalId &&
    left.activeTerminalGroupId === right.activeTerminalGroupId &&
    arraysEqual(left.terminalIds, right.terminalIds) &&
    terminalGroupsEqual(left.terminalGroups, right.terminalGroups)
  );
}

export const DEFAULT_TERMINAL_SIDEBAR_WIDTH = 144;
export const MIN_TERMINAL_SIDEBAR_WIDTH = 120;
export const MAX_TERMINAL_SIDEBAR_WIDTH = 480;

const DEFAULT_THREAD_TERMINAL_UI_STATE: ThreadTerminalUiState = Object.freeze({
  mainSurface: "chat" as ThreadMainSurface,
  terminalFullscreen: false,
  terminalHeight: DEFAULT_THREAD_TERMINAL_HEIGHT,
  sidebarWidth: DEFAULT_TERMINAL_SIDEBAR_WIDTH,
  terminalIds: [],
  activeTerminalId: "",
  terminalGroups: [],
  activeTerminalGroupId: "",
});

function createDefaultThreadTerminalUiState(): ThreadTerminalUiState {
  return {
    ...DEFAULT_THREAD_TERMINAL_UI_STATE,
    terminalIds: [...DEFAULT_THREAD_TERMINAL_UI_STATE.terminalIds],
    terminalGroups: copyTerminalGroups(DEFAULT_THREAD_TERMINAL_UI_STATE.terminalGroups),
  };
}

function getDefaultThreadTerminalUiState(): ThreadTerminalUiState {
  return DEFAULT_THREAD_TERMINAL_UI_STATE;
}

function normalizeThreadTerminalUiState(state: ThreadTerminalUiState): ThreadTerminalUiState {
  const nextTerminalIds = normalizeTerminalIds(state.terminalIds);
  const activeTerminalId = nextTerminalIds.includes(state.activeTerminalId)
    ? state.activeTerminalId
    : (nextTerminalIds[0] ?? "");
  const terminalGroups = normalizeTerminalGroups(state.terminalGroups, nextTerminalIds);
  const activeGroupIdFromState = terminalGroups.some(
    (group) => group.id === state.activeTerminalGroupId,
  )
    ? state.activeTerminalGroupId
    : null;
  const activeGroupIdFromTerminal =
    terminalGroups.find((group) => group.terminalIds.includes(activeTerminalId))?.id ?? null;

  const normalized: ThreadTerminalUiState = {
    mainSurface: state.mainSurface === "terminal" ? "terminal" : "chat",
    terminalFullscreen: state.terminalFullscreen === true,
    terminalHeight:
      Number.isFinite(state.terminalHeight) && state.terminalHeight > 0
        ? state.terminalHeight
        : DEFAULT_THREAD_TERMINAL_HEIGHT,
    sidebarWidth:
      Number.isFinite(state.sidebarWidth) && state.sidebarWidth > 0
        ? Math.min(
            MAX_TERMINAL_SIDEBAR_WIDTH,
            Math.max(MIN_TERMINAL_SIDEBAR_WIDTH, state.sidebarWidth),
          )
        : DEFAULT_TERMINAL_SIDEBAR_WIDTH,
    terminalIds: nextTerminalIds,
    activeTerminalId,
    terminalGroups,
    activeTerminalGroupId:
      activeGroupIdFromState ?? activeGroupIdFromTerminal ?? terminalGroups[0]?.id ?? "",
  };
  return threadTerminalUiStateEqual(state, normalized) ? state : normalized;
}

function isDefaultThreadTerminalUiState(state: ThreadTerminalUiState): boolean {
  const normalized = normalizeThreadTerminalUiState(state);
  return threadTerminalUiStateEqual(normalized, DEFAULT_THREAD_TERMINAL_UI_STATE);
}

function isValidTerminalId(terminalId: string): boolean {
  return terminalId.trim().length > 0;
}

function terminalThreadKey(threadRef: ScopedThreadRef): string {
  return scopedThreadKey(threadRef);
}

function copyTerminalGroups(groups: ThreadTerminalGroup[]): ThreadTerminalGroup[] {
  return groups.map((group) => ({
    id: group.id,
    ...(group.name !== undefined ? { name: group.name } : {}),
    terminalIds: [...group.terminalIds],
    ...(group.splitDirection === "vertical" ? { splitDirection: "vertical" as const } : {}),
    ...(group.paneSizes ? { paneSizes: [...group.paneSizes] } : {}),
    ...(group.layout ? { layout: copyLayout(group.layout) } : {}),
  }));
}

function upsertTerminalIntoGroups(
  state: ThreadTerminalUiState,
  terminalId: string,
  mode: "split" | "new",
  splitDirection: "horizontal" | "vertical" = "horizontal",
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  const effectiveMode: "split" | "new" = normalized.terminalIds.length === 0 ? "new" : mode;
  if (!isValidTerminalId(terminalId)) {
    return normalized;
  }

  const isNewTerminal = !normalized.terminalIds.includes(terminalId);
  const terminalIds = isNewTerminal
    ? [...normalized.terminalIds, terminalId]
    : normalized.terminalIds;
  const terminalGroups = copyTerminalGroups(normalized.terminalGroups);

  const existingGroupIndex = findGroupIndexByTerminalId(terminalGroups, terminalId);
  if (existingGroupIndex >= 0) {
    terminalGroups[existingGroupIndex]!.terminalIds = terminalGroups[
      existingGroupIndex
    ]!.terminalIds.filter((id) => id !== terminalId);
    if (terminalGroups[existingGroupIndex]!.terminalIds.length === 0) {
      terminalGroups.splice(existingGroupIndex, 1);
    }
  }

  if (effectiveMode === "new") {
    const usedGroupIds = new Set(terminalGroups.map((group) => group.id));
    const nextGroupId = assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds);
    terminalGroups.push({ id: nextGroupId, terminalIds: [terminalId] });
    return normalizeThreadTerminalUiState({
      ...normalized,
      terminalIds,
      activeTerminalId: terminalId,
      terminalGroups,
      activeTerminalGroupId: nextGroupId,
    });
  }

  let activeGroupIndex = terminalGroups.findIndex(
    (group) => group.id === normalized.activeTerminalGroupId,
  );
  if (activeGroupIndex < 0) {
    activeGroupIndex = findGroupIndexByTerminalId(terminalGroups, normalized.activeTerminalId);
  }
  if (activeGroupIndex < 0) {
    const usedGroupIds = new Set(terminalGroups.map((group) => group.id));
    const nextGroupId = assignUniqueGroupId(
      fallbackGroupId(normalized.activeTerminalId),
      usedGroupIds,
    );
    terminalGroups.push({ id: nextGroupId, terminalIds: [normalized.activeTerminalId] });
    activeGroupIndex = terminalGroups.length - 1;
  }

  const destinationGroup = terminalGroups[activeGroupIndex];
  if (!destinationGroup) {
    return normalized;
  }
  const destinationTerminalIdSet = new Set(destinationGroup.terminalIds);

  if (
    isNewTerminal &&
    !destinationTerminalIdSet.has(terminalId) &&
    destinationGroup.terminalIds.length >= MAX_TERMINALS_PER_GROUP
  ) {
    return normalized;
  }

  if (!destinationTerminalIdSet.has(terminalId)) {
    // Split the anchor pane only: nest the new terminal inside the active
    // pane's cell (or slot in next to it when its parent split already runs
    // in this direction). Sibling panes keep their orientation.
    const anchorTerminalId = destinationGroup.terminalIds.includes(normalized.activeTerminalId)
      ? normalized.activeTerminalId
      : (destinationGroup.terminalIds[destinationGroup.terminalIds.length - 1] ?? terminalId);
    destinationGroup.layout = splitLayoutAtTerminal(
      groupLayout(destinationGroup, destinationGroup.terminalIds),
      anchorTerminalId,
      terminalId,
      splitDirection,
    );
    const anchorIndex = destinationGroup.terminalIds.indexOf(anchorTerminalId);
    if (anchorIndex >= 0) {
      destinationGroup.terminalIds.splice(anchorIndex + 1, 0, terminalId);
    } else {
      destinationGroup.terminalIds.push(terminalId);
    }
    delete destinationGroup.splitDirection;
    delete destinationGroup.paneSizes;
  }

  return normalizeThreadTerminalUiState({
    ...normalized,
    terminalIds,
    activeTerminalId: terminalId,
    terminalGroups,
    activeTerminalGroupId: destinationGroup.id,
  });
}

function setThreadTerminalHeight(
  state: ThreadTerminalUiState,
  height: number,
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  if (!Number.isFinite(height) || height <= 0 || normalized.terminalHeight === height) {
    return normalized;
  }
  return { ...normalized, terminalHeight: height };
}

function splitThreadTerminal(
  state: ThreadTerminalUiState,
  terminalId: string,
  direction: "horizontal" | "vertical" = "horizontal",
): ThreadTerminalUiState {
  return upsertTerminalIntoGroups(state, terminalId, "split", direction);
}

function newThreadTerminal(
  state: ThreadTerminalUiState,
  terminalId: string,
): ThreadTerminalUiState {
  return upsertTerminalIntoGroups(state, terminalId, "new");
}

/**
 * Collapse every group into one split tree. The drawer presents a thread as a
 * single layout, so groups persisted by older builds (or opened as right-panel
 * surfaces) are merged side by side instead of hiding behind each other.
 */
function flattenThreadTerminalGroups(state: ThreadTerminalUiState): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  if (normalized.terminalGroups.length <= 1) {
    return normalized;
  }
  const groups = copyTerminalGroups(normalized.terminalGroups);
  const children: TerminalPaneLayout[] = groups.map((group) => {
    const layout = groupLayout(group, group.terminalIds);
    return layout ?? { kind: "terminal", terminalId: group.terminalIds[0] ?? "" };
  });
  const first = groups[0]!;
  const merged: ThreadTerminalGroup = {
    id: first.id,
    ...(first.name !== undefined ? { name: first.name } : {}),
    terminalIds: groups.flatMap((group) => group.terminalIds),
    layout: {
      kind: "split",
      direction: children.length <= 2 ? "horizontal" : "vertical",
      children,
    },
  };
  return normalizeThreadTerminalUiState({
    ...normalized,
    terminalGroups: [merged],
    activeTerminalGroupId: merged.id,
  });
}

/**
 * Open several terminals at once as a two-column grid in a fresh layout. Used
 * by the launch pad, which only shows when the thread has no panes yet.
 */
function launchThreadTerminalGrid(
  state: ThreadTerminalUiState,
  terminalIds: ReadonlyArray<string>,
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  const ids = normalizeTerminalIds([...terminalIds]).filter(
    (terminalId) => !normalized.terminalIds.includes(terminalId),
  );
  if (ids.length === 0) {
    return normalized;
  }
  const rows: TerminalPaneLayout[] = [];
  for (let index = 0; index < ids.length; index += 2) {
    const rowIds = ids.slice(index, index + 2);
    rows.push(
      rowIds.length === 1
        ? { kind: "terminal", terminalId: rowIds[0]! }
        : {
            kind: "split",
            direction: "horizontal",
            children: rowIds.map((terminalId) => ({ kind: "terminal" as const, terminalId })),
          },
    );
  }
  const layout: TerminalPaneLayout =
    rows.length === 1 ? rows[0]! : { kind: "split", direction: "vertical", children: rows };
  const usedGroupIds = new Set(normalized.terminalGroups.map((group) => group.id));
  const groupId = assignUniqueGroupId(fallbackGroupId(ids[0]!), usedGroupIds);
  return normalizeThreadTerminalUiState({
    ...normalized,
    terminalIds: [...normalized.terminalIds, ...ids],
    activeTerminalId: ids[0]!,
    terminalGroups: [
      ...copyTerminalGroups(normalized.terminalGroups),
      { id: groupId, terminalIds: [...ids], layout },
    ],
    activeTerminalGroupId: groupId,
  });
}

/** Dock the browser pane next to the active pane, or focus it when already docked. */
function addThreadBrowserPane(
  state: ThreadTerminalUiState,
  direction: "horizontal" | "vertical",
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  if (normalized.terminalIds.includes(BROWSER_PANE_ID)) {
    return setThreadActiveTerminal(normalized, BROWSER_PANE_ID);
  }
  return upsertTerminalIntoGroups(
    normalized,
    BROWSER_PANE_ID,
    normalized.terminalIds.length === 0 ? "new" : "split",
    direction,
  );
}

function setThreadActiveTerminal(
  state: ThreadTerminalUiState,
  terminalId: string,
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }
  const activeTerminalGroupId =
    normalized.terminalGroups.find((group) => group.terminalIds.includes(terminalId))?.id ??
    normalized.activeTerminalGroupId;
  if (
    normalized.activeTerminalId === terminalId &&
    normalized.activeTerminalGroupId === activeTerminalGroupId
  ) {
    return normalized;
  }
  return {
    ...normalized,
    activeTerminalId: terminalId,
    activeTerminalGroupId,
  };
}

export type TerminalSidebarPlacement =
  | { readonly type: "end" }
  | { readonly type: "before"; readonly terminalId: string }
  | { readonly type: "after"; readonly terminalId: string };

export type TerminalGroupListPlacement = {
  readonly type: ListDropPlacement;
  readonly groupId: string;
};

function clearLegacySplitFields(group: ThreadTerminalGroup): void {
  delete group.splitDirection;
  delete group.paneSizes;
}

function applyGroupLayout(group: ThreadTerminalGroup, layout: TerminalPaneLayout | undefined) {
  if (layout) {
    group.layout = layout;
    group.terminalIds = layoutLeafIds(layout);
  } else {
    delete group.layout;
  }
  clearLegacySplitFields(group);
}

function removeTerminalFromGroupList(
  groups: ThreadTerminalGroup[],
  terminalId: string,
): ThreadTerminalGroup[] {
  const next: ThreadTerminalGroup[] = [];
  for (const group of groups) {
    if (!group.terminalIds.includes(terminalId)) {
      next.push(group);
      continue;
    }
    const terminalIds = group.terminalIds.filter((id) => id !== terminalId);
    if (terminalIds.length === 0) {
      continue;
    }
    const layout = group.layout ? removeTerminalFromLayout(group.layout, terminalId) : undefined;
    const nextGroup: ThreadTerminalGroup = { ...group, terminalIds };
    applyGroupLayout(nextGroup, layout);
    if (!layout) {
      nextGroup.terminalIds = terminalIds;
    }
    next.push(nextGroup);
  }
  return next;
}

function listPlacementIsNoOp(
  terminalIds: readonly string[],
  terminalId: string,
  placement: TerminalSidebarPlacement,
): boolean {
  const fromIndex = terminalIds.indexOf(terminalId);
  if (fromIndex < 0) {
    return false;
  }
  if (placement.type === "end") {
    return fromIndex === terminalIds.length - 1;
  }
  const targetIndex = terminalIds.indexOf(placement.terminalId);
  if (targetIndex < 0) {
    return true;
  }
  if (placement.type === "before") {
    return fromIndex === targetIndex - 1;
  }
  return fromIndex === targetIndex + 1;
}

function placeTerminalInGroups(
  state: ThreadTerminalUiState,
  terminalId: string,
  destinationGroupId: string,
  placement: TerminalSidebarPlacement,
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }

  const sourceIndex = findGroupIndexByTerminalId(normalized.terminalGroups, terminalId);
  const destIndex = normalized.terminalGroups.findIndex((group) => group.id === destinationGroupId);
  if (sourceIndex < 0 || destIndex < 0) {
    return normalized;
  }

  const dest = normalized.terminalGroups[destIndex]!;
  const crossing = sourceIndex !== destIndex;
  if (crossing && dest.terminalIds.length >= MAX_TERMINALS_PER_GROUP) {
    return normalized;
  }
  if (placement.type !== "end") {
    if (placement.terminalId === terminalId) {
      return normalized;
    }
    if (!dest.terminalIds.includes(placement.terminalId)) {
      return normalized;
    }
  }
  if (!crossing && listPlacementIsNoOp(dest.terminalIds, terminalId, placement)) {
    return normalized;
  }

  let terminalGroups = copyTerminalGroups(normalized.terminalGroups);
  terminalGroups = removeTerminalFromGroupList(terminalGroups, terminalId);
  const destAfterIndex = terminalGroups.findIndex((group) => group.id === destinationGroupId);
  const destAfter = destAfterIndex >= 0 ? terminalGroups[destAfterIndex] : undefined;
  if (!destAfter) {
    return normalized;
  }

  const side: ListDropPlacement = placement.type === "end" ? "after" : placement.type;
  const anchorTerminalId =
    placement.type === "end"
      ? destAfter.terminalIds[destAfter.terminalIds.length - 1]
      : placement.terminalId;
  if (!anchorTerminalId || !destAfter.terminalIds.includes(anchorTerminalId)) {
    destAfter.terminalIds = [terminalId];
    delete destAfter.layout;
    clearLegacySplitFields(destAfter);
  } else {
    applyGroupLayout(
      destAfter,
      insertTerminalBeside(
        destAfter.layout ?? groupLayout(destAfter, destAfter.terminalIds),
        anchorTerminalId,
        terminalId,
        side,
      ),
    );
  }

  return normalizeThreadTerminalUiState({
    ...normalized,
    terminalGroups,
    activeTerminalId: terminalId,
    activeTerminalGroupId: destinationGroupId,
  });
}

function reorderTerminalGroupsInState(
  state: ThreadTerminalUiState,
  groupId: string,
  placement: TerminalGroupListPlacement,
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  if (groupId === placement.groupId) {
    return normalized;
  }
  const fromIndex = normalized.terminalGroups.findIndex((group) => group.id === groupId);
  const targetIndex = normalized.terminalGroups.findIndex(
    (group) => group.id === placement.groupId,
  );
  if (fromIndex < 0 || targetIndex < 0) {
    return normalized;
  }
  const terminalGroups = copyTerminalGroups(normalized.terminalGroups);
  const [moved] = terminalGroups.splice(fromIndex, 1);
  if (!moved) {
    return normalized;
  }
  const adjustedTarget = fromIndex < targetIndex ? targetIndex - 1 : targetIndex;
  const insertAt = placement.type === "before" ? adjustedTarget : adjustedTarget + 1;
  if (insertAt === fromIndex) {
    return normalized;
  }
  terminalGroups.splice(insertAt, 0, moved);
  return normalizeThreadTerminalUiState({ ...normalized, terminalGroups });
}

function moveTerminalInGroupState(
  state: ThreadTerminalUiState,
  groupId: string,
  terminalId: string,
  targetTerminalId: string,
  zone: PaneDropZone,
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  const destIndex = normalized.terminalGroups.findIndex((group) => group.id === groupId);
  const dest = normalized.terminalGroups[destIndex];
  if (!dest || !dest.terminalIds.includes(targetTerminalId)) {
    return normalized;
  }
  const sourceIndex = findGroupIndexByTerminalId(normalized.terminalGroups, terminalId);
  if (sourceIndex < 0) {
    return normalized;
  }

  let next = normalized;
  if (sourceIndex !== destIndex) {
    next = placeTerminalInGroups(normalized, terminalId, groupId, { type: "end" });
  }

  const groupIndex = next.terminalGroups.findIndex((group) => group.id === groupId);
  const group = next.terminalGroups[groupIndex];
  if (!group?.layout) {
    return next;
  }
  const layout = moveTerminalInLayout(group.layout, terminalId, targetTerminalId, zone);
  if (!layout) {
    return next;
  }
  const terminalGroups = copyTerminalGroups(next.terminalGroups);
  terminalGroups[groupIndex] = {
    ...terminalGroups[groupIndex]!,
    terminalIds: layoutLeafIds(layout),
    layout,
  };
  return normalizeThreadTerminalUiState({ ...next, terminalGroups });
}

function closeThreadTerminal(
  state: ThreadTerminalUiState,
  terminalId: string,
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }

  const remainingTerminalIds = normalized.terminalIds.filter((id) => id !== terminalId);
  if (remainingTerminalIds.length === 0) {
    // Closing the last terminal resets the layout but not the thread's main
    // surface choice — a terminal-mode thread stays in terminal mode.
    return {
      ...createDefaultThreadTerminalUiState(),
      mainSurface: normalized.mainSurface,
      terminalFullscreen: normalized.terminalFullscreen,
    };
  }

  const closedTerminalIndex = normalized.terminalIds.indexOf(terminalId);
  const nextActiveTerminalId =
    normalized.activeTerminalId === terminalId
      ? (remainingTerminalIds[Math.min(closedTerminalIndex, remainingTerminalIds.length - 1)] ??
        remainingTerminalIds[0] ??
        "")
      : normalized.activeTerminalId;

  const terminalGroups: ThreadTerminalGroup[] = [];
  for (const group of normalized.terminalGroups) {
    const terminalIds = group.terminalIds.filter((id) => id !== terminalId);
    if (terminalIds.length > 0) {
      terminalGroups.push({ ...group, terminalIds });
    }
  }

  const nextActiveTerminalGroupId =
    terminalGroups.find((group) => group.terminalIds.includes(nextActiveTerminalId))?.id ??
    terminalGroups[0]?.id ??
    fallbackGroupId(nextActiveTerminalId);

  return normalizeThreadTerminalUiState({
    mainSurface: normalized.mainSurface,
    terminalFullscreen: normalized.terminalFullscreen,
    terminalHeight: normalized.terminalHeight,
    sidebarWidth: normalized.sidebarWidth,
    terminalIds: remainingTerminalIds,
    activeTerminalId: nextActiveTerminalId,
    terminalGroups,
    activeTerminalGroupId: nextActiveTerminalGroupId,
  });
}

function reconcileThreadTerminalSessionIds(
  state: ThreadTerminalUiState,
  nextIds: string[],
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  if (arraysEqual(normalized.terminalIds, nextIds)) {
    return normalized;
  }

  const nextActiveTerminalId = nextIds.includes(normalized.activeTerminalId)
    ? normalized.activeTerminalId
    : (nextIds[0] ?? "");

  const terminalGroups = normalizeTerminalGroups(normalized.terminalGroups, nextIds);
  const activeGroupIdFromTerminal =
    terminalGroups.find((group) => group.terminalIds.includes(nextActiveTerminalId))?.id ?? null;

  return normalizeThreadTerminalUiState({
    ...normalized,
    terminalIds: nextIds,
    activeTerminalId: nextActiveTerminalId,
    terminalGroups,
    activeTerminalGroupId: activeGroupIdFromTerminal ?? terminalGroups[0]?.id ?? "",
  });
}

/**
 * Server layout sync. The server keeps one authoritative pane-layout
 * document per thread (`terminal.setLayout` / `subscribeTerminalLayouts`);
 * these helpers convert between that wire shape and the store's groups.
 * The projection is normalization against this client's terminal ids, so
 * two clients that know different id sets still converge: each renders the
 * document restricted to the ids it has, and only genuine user edits (a
 * local key differing from the projected document) are pushed back.
 */
function remotePaneNodeToLayout(node: TerminalPaneNode): TerminalPaneLayout {
  if (node.kind === "terminal") {
    return { kind: "terminal", terminalId: node.terminalId };
  }
  return {
    kind: "split",
    direction: node.direction,
    children: node.children.map(remotePaneNodeToLayout),
    ...(node.sizes ? { sizes: [...node.sizes] } : {}),
  };
}

function layoutToRemotePaneNode(layout: TerminalPaneLayout): TerminalPaneNode {
  if (layout.kind === "terminal") {
    return { kind: "terminal", terminalId: layout.terminalId };
  }
  return {
    kind: "split",
    direction: layout.direction,
    children: layout.children.map(layoutToRemotePaneNode),
    ...(layout.sizes ? { sizes: [...layout.sizes] } : {}),
  };
}

export function remoteTerminalGroupsToLocal(
  groups: ReadonlyArray<TerminalLayoutGroup>,
): ThreadTerminalGroup[] {
  return groups.map((group) => ({
    id: group.id,
    ...(group.name !== undefined && group.name.trim().length > 0 ? { name: group.name } : {}),
    terminalIds: [...group.terminalIds],
    ...(group.layout ? { layout: remotePaneNodeToLayout(group.layout) } : {}),
  }));
}

export function localTerminalGroupsToRemote(
  groups: ReadonlyArray<ThreadTerminalGroup>,
): TerminalLayoutGroup[] {
  return groups.map((group) => ({
    id: group.id,
    ...(group.name !== undefined ? { name: group.name } : {}),
    terminalIds: [...group.terminalIds],
    ...(group.layout ? { layout: layoutToRemotePaneNode(group.layout) } : {}),
  }));
}

export function projectRemoteTerminalGroups(
  groups: ReadonlyArray<TerminalLayoutGroup>,
  terminalIds: ReadonlyArray<string>,
): ThreadTerminalGroup[] {
  return normalizeTerminalGroups(remoteTerminalGroupsToLocal(groups), [...terminalIds]);
}

/** Stable identity for sync comparisons; ignores legacy split fields. */
export function terminalGroupsSyncKey(groups: ReadonlyArray<ThreadTerminalGroup>): string {
  return JSON.stringify(
    groups.map((group) => [group.id, group.name ?? "", group.terminalIds, group.layout ?? null]),
  );
}

const normalizedThreadTerminalUiStateCache = new WeakMap<
  ThreadTerminalUiState,
  ThreadTerminalUiState
>();

export function selectThreadTerminalUiState(
  terminalUiStateByThreadKey: Record<string, ThreadTerminalUiState>,
  threadRef: ScopedThreadRef | null | undefined,
): ThreadTerminalUiState {
  if (!threadRef || threadRef.threadId.length === 0) {
    return getDefaultThreadTerminalUiState();
  }
  const current = terminalUiStateByThreadKey[terminalThreadKey(threadRef)];
  if (!current) {
    return getDefaultThreadTerminalUiState();
  }
  const cached = normalizedThreadTerminalUiStateCache.get(current);
  if (cached) {
    return cached;
  }
  const normalized = normalizeThreadTerminalUiState(current);
  normalizedThreadTerminalUiStateCache.set(current, normalized);
  return normalized;
}

function updateTerminalUiStateByThreadKey(
  terminalUiStateByThreadKey: Record<string, ThreadTerminalUiState>,
  threadRef: ScopedThreadRef,
  updater: (state: ThreadTerminalUiState) => ThreadTerminalUiState,
): Record<string, ThreadTerminalUiState> {
  if (threadRef.threadId.length === 0) {
    return terminalUiStateByThreadKey;
  }

  const threadKey = terminalThreadKey(threadRef);
  const current = selectThreadTerminalUiState(terminalUiStateByThreadKey, threadRef);
  const next = updater(current);
  if (next === current) {
    return terminalUiStateByThreadKey;
  }

  if (isDefaultThreadTerminalUiState(next)) {
    if (terminalUiStateByThreadKey[threadKey] === undefined) {
      return terminalUiStateByThreadKey;
    }
    const { [threadKey]: _removed, ...rest } = terminalUiStateByThreadKey;
    return rest;
  }

  return {
    ...terminalUiStateByThreadKey,
    [threadKey]: next,
  };
}

function updateSuppressedTerminalId(
  suppressedTerminalIdsByThreadKey: Record<string, string[]>,
  threadRef: ScopedThreadRef,
  terminalId: string,
  suppressed: boolean,
): Record<string, string[]> {
  const normalizedTerminalId = terminalId.trim();
  if (normalizedTerminalId.length === 0) {
    return suppressedTerminalIdsByThreadKey;
  }
  const threadKey = terminalThreadKey(threadRef);
  const currentIds = suppressedTerminalIdsByThreadKey[threadKey] ?? [];
  const currentlySuppressed = currentIds.includes(normalizedTerminalId);
  if (currentlySuppressed === suppressed) {
    return suppressedTerminalIdsByThreadKey;
  }
  if (suppressed) {
    return {
      ...suppressedTerminalIdsByThreadKey,
      [threadKey]: [...currentIds, normalizedTerminalId],
    };
  }

  const remainingIds = currentIds.filter((id) => id !== normalizedTerminalId);
  if (remainingIds.length > 0) {
    return {
      ...suppressedTerminalIdsByThreadKey,
      [threadKey]: remainingIds,
    };
  }
  return removeRecordEntry(suppressedTerminalIdsByThreadKey, threadKey);
}

function removeRecordEntry<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (record[key] === undefined) {
    return record;
  }
  const { [key]: _removed, ...remaining } = record;
  return remaining;
}

interface TerminalUiStateStoreState {
  terminalUiStateByThreadKey: Record<string, ThreadTerminalUiState>;
  /**
   * Durable close intent. Closed ids stay hidden from stale metadata and are
   * retried after reconnect until the server inventory confirms removal.
   */
  suppressedTerminalIdsByThreadKey: Record<string, string[]>;
  /**
   * Ids this client just created that the server session list has not yet
   * confirmed. Reconcile keeps these as local extras; every other id missing
   * from the server list was closed elsewhere and is dropped. In-memory only:
   * after a reload the server list alone is authoritative.
   */
  pendingOpenTerminalIdsByThreadKey: Record<string, string[]>;
  setTerminalHeight: (threadRef: ScopedThreadRef, height: number) => void;
  splitTerminal: (threadRef: ScopedThreadRef, terminalId: string) => void;
  splitTerminalVertical: (threadRef: ScopedThreadRef, terminalId: string) => void;
  newTerminal: (threadRef: ScopedThreadRef, terminalId: string) => void;
  /** Merge every group of a thread into one split layout. */
  flattenTerminalGroups: (threadRef: ScopedThreadRef) => void;
  /** Open several terminals at once as a grid in a fresh layout. */
  launchTerminalGrid: (threadRef: ScopedThreadRef, terminalIds: ReadonlyArray<string>) => void;
  /** Dock the browser pane beside the active pane (or focus it when docked). */
  addBrowserPane: (threadRef: ScopedThreadRef, direction: "horizontal" | "vertical") => void;
  ensureTerminal: (
    threadRef: ScopedThreadRef,
    terminalId: string,
    options?: { active?: boolean },
  ) => void;
  setActiveTerminal: (threadRef: ScopedThreadRef, terminalId: string) => void;
  setMainSurface: (threadRef: ScopedThreadRef, surface: ThreadMainSurface) => void;
  setTerminalFullscreen: (threadRef: ScopedThreadRef, fullscreen: boolean) => void;
  /** Set a user-facing group name; an empty or whitespace name restores the positional default. */
  renameTerminalGroup: (threadRef: ScopedThreadRef, groupId: string, name: string) => void;
  setTerminalSidebarWidth: (threadRef: ScopedThreadRef, width: number) => void;
  /** Persist dragged fractions for the split node at `path` (child indices from the group's root). */
  setGroupSplitSizes: (
    threadRef: ScopedThreadRef,
    groupId: string,
    path: readonly number[],
    sizes: number[],
  ) => void;
  /** Drag-drop one pane onto another: center swaps, an edge splits the target pane on that side. */
  moveTerminalInGroup: (
    threadRef: ScopedThreadRef,
    groupId: string,
    terminalId: string,
    targetTerminalId: string,
    zone: PaneDropZone,
  ) => void;
  /** Sidebar list: reorder within a group or move a terminal into another group. */
  moveTerminalToGroup: (
    threadRef: ScopedThreadRef,
    terminalId: string,
    destinationGroupId: string,
    placement: TerminalSidebarPlacement,
  ) => void;
  /** Sidebar list: reorder groups relative to each other. */
  reorderTerminalGroups: (
    threadRef: ScopedThreadRef,
    groupId: string,
    placement: TerminalGroupListPlacement,
  ) => void;
  closeTerminal: (threadRef: ScopedThreadRef, terminalId: string) => void;
  /** Remove an optimistic pane when terminal.open fails, without suppressing that server id. */
  rejectPendingTerminalOpen: (threadRef: ScopedThreadRef, terminalId: string) => void;
  /** Adopt a server layout document, projected onto this client's terminal ids. */
  applyRemoteTerminalLayout: (
    threadRef: ScopedThreadRef,
    remoteGroups: ReadonlyArray<TerminalLayoutGroup>,
  ) => void;
  reconcileTerminalIds: (threadRef: ScopedThreadRef, nextIds: string[]) => void;
  clearTerminalUiState: (threadRef: ScopedThreadRef) => void;
  removeTerminalUiState: (threadRef: ScopedThreadRef) => void;
  removeOrphanedTerminalUiStates: (activeThreadKeys: Set<string>) => void;
}

export const useTerminalUiStateStore = create<TerminalUiStateStoreState>()(
  persist(
    (set) => {
      const updateTerminal = (
        threadRef: ScopedThreadRef,
        updater: (
          state: ThreadTerminalUiState,
          suppressedTerminalIds: readonly string[],
        ) => ThreadTerminalUiState,
        suppression?: { terminalId: string; suppressed: boolean },
      ) => {
        set((state) => {
          const threadKey = terminalThreadKey(threadRef);
          const suppressedTerminalIds = state.suppressedTerminalIdsByThreadKey[threadKey] ?? [];
          const previousUiState = selectThreadTerminalUiState(
            state.terminalUiStateByThreadKey,
            threadRef,
          );
          const nextTerminalUiStateByThreadKey = updateTerminalUiStateByThreadKey(
            state.terminalUiStateByThreadKey,
            threadRef,
            (terminalState) => updater(terminalState, suppressedTerminalIds),
          );
          const nextSuppressedTerminalIdsByThreadKey = suppression
            ? updateSuppressedTerminalId(
                state.suppressedTerminalIdsByThreadKey,
                threadRef,
                suppression.terminalId,
                suppression.suppressed,
              )
            : state.suppressedTerminalIdsByThreadKey;
          // Ids added by this update are pending until the server confirms
          // them, so reconcile keeps them instead of reading their absence
          // from the server list as a close on another machine.
          const nextUiState = selectThreadTerminalUiState(
            nextTerminalUiStateByThreadKey,
            threadRef,
          );
          const previousIdSet = new Set(previousUiState.terminalIds);
          const currentPendingIds = state.pendingOpenTerminalIdsByThreadKey[threadKey] ?? [];
          const addedPendingIds = nextUiState.terminalIds.filter(
            (terminalId) =>
              !previousIdSet.has(terminalId) &&
              !currentPendingIds.includes(terminalId) &&
              // Browser panes never get a server session to confirm them.
              !isBrowserPaneId(terminalId),
          );
          let pendingIds =
            addedPendingIds.length > 0
              ? [...currentPendingIds, ...addedPendingIds]
              : currentPendingIds;
          if (suppression?.suppressed && pendingIds.includes(suppression.terminalId)) {
            pendingIds = pendingIds.filter((id) => id !== suppression.terminalId);
          }
          const nextPendingOpenTerminalIdsByThreadKey =
            pendingIds === currentPendingIds
              ? state.pendingOpenTerminalIdsByThreadKey
              : pendingIds.length > 0
                ? { ...state.pendingOpenTerminalIdsByThreadKey, [threadKey]: pendingIds }
                : removeRecordEntry(state.pendingOpenTerminalIdsByThreadKey, threadKey);
          if (
            nextTerminalUiStateByThreadKey === state.terminalUiStateByThreadKey &&
            nextSuppressedTerminalIdsByThreadKey === state.suppressedTerminalIdsByThreadKey &&
            nextPendingOpenTerminalIdsByThreadKey === state.pendingOpenTerminalIdsByThreadKey
          ) {
            return state;
          }
          return {
            terminalUiStateByThreadKey: nextTerminalUiStateByThreadKey,
            suppressedTerminalIdsByThreadKey: nextSuppressedTerminalIdsByThreadKey,
            pendingOpenTerminalIdsByThreadKey: nextPendingOpenTerminalIdsByThreadKey,
          };
        });
      };

      return {
        terminalUiStateByThreadKey: {},
        suppressedTerminalIdsByThreadKey: {},
        pendingOpenTerminalIdsByThreadKey: {},
        setTerminalHeight: (threadRef, height) =>
          updateTerminal(threadRef, (state) => setThreadTerminalHeight(state, height)),
        splitTerminal: (threadRef, terminalId) =>
          updateTerminal(threadRef, (state) => splitThreadTerminal(state, terminalId), {
            terminalId,
            suppressed: false,
          }),
        splitTerminalVertical: (threadRef, terminalId) =>
          updateTerminal(threadRef, (state) => splitThreadTerminal(state, terminalId, "vertical"), {
            terminalId,
            suppressed: false,
          }),
        newTerminal: (threadRef, terminalId) =>
          updateTerminal(threadRef, (state) => newThreadTerminal(state, terminalId), {
            terminalId,
            suppressed: false,
          }),
        flattenTerminalGroups: (threadRef) =>
          updateTerminal(threadRef, (state) => flattenThreadTerminalGroups(state)),
        launchTerminalGrid: (threadRef, terminalIds) => {
          updateTerminal(threadRef, (state) => launchThreadTerminalGrid(state, terminalIds));
          // Each id may belong to a terminal closed earlier on this client;
          // lifting the suppression keeps reconcile from dropping it again.
          for (const terminalId of terminalIds) {
            updateTerminal(threadRef, (state) => state, { terminalId, suppressed: false });
          }
        },
        addBrowserPane: (threadRef, direction) =>
          updateTerminal(threadRef, (state) => addThreadBrowserPane(state, direction)),
        ensureTerminal: (threadRef, terminalId, options) =>
          updateTerminal(
            threadRef,
            (state) => {
              let nextState = state;
              if (!state.terminalIds.includes(terminalId)) {
                nextState = newThreadTerminal(nextState, terminalId);
              }
              if (options?.active === false) {
                nextState = {
                  ...nextState,
                  activeTerminalId: state.activeTerminalId,
                  activeTerminalGroupId: state.activeTerminalGroupId,
                };
              }
              if (options?.active ?? true) {
                nextState = setThreadActiveTerminal(nextState, terminalId);
              }
              return normalizeThreadTerminalUiState(nextState);
            },
            { terminalId, suppressed: false },
          ),
        setActiveTerminal: (threadRef, terminalId) =>
          updateTerminal(threadRef, (state) => setThreadActiveTerminal(state, terminalId)),
        setMainSurface: (threadRef, surface) =>
          updateTerminal(threadRef, (state) => {
            const normalized = normalizeThreadTerminalUiState(state);
            if (normalized.mainSurface === surface) {
              return normalized;
            }
            // Fullscreen is a terminal-mode layout, so it resets on the way
            // back to chat.
            if (surface === "chat") {
              return {
                ...normalized,
                mainSurface: surface,
                terminalFullscreen: false,
              };
            }
            // Terminal mode with no panes shows the launch pad; never seed a
            // placeholder terminal here.
            return { ...normalized, mainSurface: surface };
          }),
        setTerminalFullscreen: (threadRef, fullscreen) =>
          updateTerminal(threadRef, (state) => {
            const normalized = normalizeThreadTerminalUiState(state);
            if (normalized.terminalFullscreen === fullscreen) {
              return normalized;
            }
            return { ...normalized, terminalFullscreen: fullscreen };
          }),
        renameTerminalGroup: (threadRef, groupId, name) =>
          updateTerminal(threadRef, (state) => {
            const normalized = normalizeThreadTerminalUiState(state);
            const groupIndex = normalized.terminalGroups.findIndex((group) => group.id === groupId);
            const group = normalized.terminalGroups[groupIndex];
            if (!group) {
              return normalized;
            }
            const trimmedName = name.trim();
            if ((group.name ?? "") === trimmedName) {
              return normalized;
            }
            const terminalGroups = copyTerminalGroups(normalized.terminalGroups);
            const nextGroup = { ...terminalGroups[groupIndex]! };
            if (trimmedName.length > 0) {
              nextGroup.name = trimmedName;
            } else {
              delete nextGroup.name;
            }
            terminalGroups[groupIndex] = nextGroup;
            return normalizeThreadTerminalUiState({ ...normalized, terminalGroups });
          }),
        setTerminalSidebarWidth: (threadRef, width) =>
          updateTerminal(threadRef, (state) =>
            normalizeThreadTerminalUiState({ ...state, sidebarWidth: width }),
          ),
        setGroupSplitSizes: (threadRef, groupId, path, sizes) =>
          updateTerminal(threadRef, (state) => {
            const normalized = normalizeThreadTerminalUiState(state);
            const groupIndex = normalized.terminalGroups.findIndex((group) => group.id === groupId);
            const group = normalized.terminalGroups[groupIndex];
            if (!group?.layout) {
              return normalized;
            }
            const layout = setLayoutSizesAtPath(group.layout, path, sizes);
            if (!layout) {
              return normalized;
            }
            const terminalGroups = copyTerminalGroups(normalized.terminalGroups);
            terminalGroups[groupIndex] = { ...terminalGroups[groupIndex]!, layout };
            return normalizeThreadTerminalUiState({ ...normalized, terminalGroups });
          }),
        moveTerminalInGroup: (threadRef, groupId, terminalId, targetTerminalId, zone) =>
          updateTerminal(threadRef, (state) =>
            moveTerminalInGroupState(state, groupId, terminalId, targetTerminalId, zone),
          ),
        moveTerminalToGroup: (threadRef, terminalId, destinationGroupId, placement) =>
          updateTerminal(threadRef, (state) =>
            placeTerminalInGroups(state, terminalId, destinationGroupId, placement),
          ),
        reorderTerminalGroups: (threadRef, groupId, placement) =>
          updateTerminal(threadRef, (state) =>
            reorderTerminalGroupsInState(state, groupId, placement),
          ),
        closeTerminal: (threadRef, terminalId) =>
          updateTerminal(threadRef, (state) => closeThreadTerminal(state, terminalId), {
            terminalId,
            suppressed: true,
          }),
        rejectPendingTerminalOpen: (threadRef, terminalId) =>
          set((state) => {
            const threadKey = terminalThreadKey(threadRef);
            const pendingIds = state.pendingOpenTerminalIdsByThreadKey[threadKey] ?? [];
            if (!pendingIds.includes(terminalId)) {
              return state;
            }
            const remainingPendingIds = pendingIds.filter(
              (pendingTerminalId) => pendingTerminalId !== terminalId,
            );
            return {
              terminalUiStateByThreadKey: updateTerminalUiStateByThreadKey(
                state.terminalUiStateByThreadKey,
                threadRef,
                (terminalState) => closeThreadTerminal(terminalState, terminalId),
              ),
              pendingOpenTerminalIdsByThreadKey:
                remainingPendingIds.length > 0
                  ? {
                      ...state.pendingOpenTerminalIdsByThreadKey,
                      [threadKey]: remainingPendingIds,
                    }
                  : removeRecordEntry(state.pendingOpenTerminalIdsByThreadKey, threadKey),
            };
          }),
        applyRemoteTerminalLayout: (threadRef, remoteGroups) =>
          updateTerminal(threadRef, (state) => {
            const normalized = normalizeThreadTerminalUiState(state);
            if (normalized.terminalIds.length === 0) {
              return normalized;
            }
            const projected = normalizeTerminalGroups(
              remoteTerminalGroupsToLocal(remoteGroups),
              normalized.terminalIds,
            );
            if (terminalGroupsEqual(normalized.terminalGroups, projected)) {
              return normalized;
            }
            return normalizeThreadTerminalUiState({
              ...normalized,
              terminalGroups: projected,
            });
          }),
        reconcileTerminalIds: (threadRef, serverIds) =>
          set((state) => {
            // The server session list is authoritative: a local id it lacks
            // was closed on another machine — unless this client opened it and
            // the list hasn't caught up yet (pending). Local relative order is
            // preserved for surviving ids; genuinely new server ids append.
            const threadKey = terminalThreadKey(threadRef);
            const current = selectThreadTerminalUiState(
              state.terminalUiStateByThreadKey,
              threadRef,
            );
            const suppressedIds = new Set(state.suppressedTerminalIdsByThreadKey[threadKey] ?? []);
            const pendingIds = state.pendingOpenTerminalIdsByThreadKey[threadKey] ?? [];
            const serverIdSet = new Set(serverIds);
            const stillPendingIds = pendingIds.filter(
              (terminalId) =>
                !serverIdSet.has(terminalId) && current.terminalIds.includes(terminalId),
            );
            const stillPendingIdSet = new Set(stillPendingIds);
            const currentIdSet = new Set(current.terminalIds);
            const nextIds = [
              ...current.terminalIds.filter(
                (terminalId) =>
                  // A docked browser pane is purely local layout: the server
                  // session list never mentions it, so it survives as long as
                  // it is still in the layout.
                  isBrowserPaneId(terminalId) ||
                  ((serverIdSet.has(terminalId) || stillPendingIdSet.has(terminalId)) &&
                    !suppressedIds.has(terminalId)),
              ),
              ...serverIds.filter(
                (terminalId) => !currentIdSet.has(terminalId) && !suppressedIds.has(terminalId),
              ),
            ];
            const nextTerminalUiStateByThreadKey = updateTerminalUiStateByThreadKey(
              state.terminalUiStateByThreadKey,
              threadRef,
              (terminalState) => reconcileThreadTerminalSessionIds(terminalState, nextIds),
            );
            const nextPendingOpenTerminalIdsByThreadKey = arraysEqual(stillPendingIds, pendingIds)
              ? state.pendingOpenTerminalIdsByThreadKey
              : stillPendingIds.length > 0
                ? { ...state.pendingOpenTerminalIdsByThreadKey, [threadKey]: stillPendingIds }
                : removeRecordEntry(state.pendingOpenTerminalIdsByThreadKey, threadKey);
            // Absence from an authoritative snapshot acknowledges a close.
            // Until then this durable intent survives app/server restarts and
            // prevents a restored launch record from reappearing in the UI.
            const remainingSuppressedIds = [...suppressedIds].filter((terminalId) =>
              serverIdSet.has(terminalId),
            );
            const nextSuppressedTerminalIdsByThreadKey = arraysEqual(
              remainingSuppressedIds,
              state.suppressedTerminalIdsByThreadKey[threadKey] ?? [],
            )
              ? state.suppressedTerminalIdsByThreadKey
              : remainingSuppressedIds.length > 0
                ? {
                    ...state.suppressedTerminalIdsByThreadKey,
                    [threadKey]: remainingSuppressedIds,
                  }
                : removeRecordEntry(state.suppressedTerminalIdsByThreadKey, threadKey);
            if (
              nextTerminalUiStateByThreadKey === state.terminalUiStateByThreadKey &&
              nextPendingOpenTerminalIdsByThreadKey === state.pendingOpenTerminalIdsByThreadKey &&
              nextSuppressedTerminalIdsByThreadKey === state.suppressedTerminalIdsByThreadKey
            ) {
              return state;
            }
            return {
              terminalUiStateByThreadKey: nextTerminalUiStateByThreadKey,
              pendingOpenTerminalIdsByThreadKey: nextPendingOpenTerminalIdsByThreadKey,
              suppressedTerminalIdsByThreadKey: nextSuppressedTerminalIdsByThreadKey,
            };
          }),
        clearTerminalUiState: (threadRef) =>
          set((state) => {
            const threadKey = terminalThreadKey(threadRef);
            const nextTerminalUiStateByThreadKey = updateTerminalUiStateByThreadKey(
              state.terminalUiStateByThreadKey,
              threadRef,
              () => createDefaultThreadTerminalUiState(),
            );
            const hadSuppressedTerminalIds =
              state.suppressedTerminalIdsByThreadKey[threadKey] !== undefined;
            const hadPendingOpenTerminalIds =
              state.pendingOpenTerminalIdsByThreadKey[threadKey] !== undefined;
            if (
              nextTerminalUiStateByThreadKey === state.terminalUiStateByThreadKey &&
              !hadSuppressedTerminalIds &&
              !hadPendingOpenTerminalIds
            ) {
              return state;
            }
            return {
              terminalUiStateByThreadKey: nextTerminalUiStateByThreadKey,
              suppressedTerminalIdsByThreadKey: removeRecordEntry(
                state.suppressedTerminalIdsByThreadKey,
                threadKey,
              ),
              pendingOpenTerminalIdsByThreadKey: removeRecordEntry(
                state.pendingOpenTerminalIdsByThreadKey,
                threadKey,
              ),
            };
          }),
        removeTerminalUiState: (threadRef) =>
          set((state) => {
            const threadKey = terminalThreadKey(threadRef);
            const hadTerminalUiState = state.terminalUiStateByThreadKey[threadKey] !== undefined;
            const hadSuppressedTerminalIds =
              state.suppressedTerminalIdsByThreadKey[threadKey] !== undefined;
            const hadPendingOpenTerminalIds =
              state.pendingOpenTerminalIdsByThreadKey[threadKey] !== undefined;
            if (!hadTerminalUiState && !hadSuppressedTerminalIds && !hadPendingOpenTerminalIds) {
              return state;
            }
            return {
              terminalUiStateByThreadKey: removeRecordEntry(
                state.terminalUiStateByThreadKey,
                threadKey,
              ),
              suppressedTerminalIdsByThreadKey: removeRecordEntry(
                state.suppressedTerminalIdsByThreadKey,
                threadKey,
              ),
              pendingOpenTerminalIdsByThreadKey: removeRecordEntry(
                state.pendingOpenTerminalIdsByThreadKey,
                threadKey,
              ),
            };
          }),
        removeOrphanedTerminalUiStates: (activeThreadKeys) =>
          set((state) => {
            const orphanedIds = new Set(
              [
                ...Object.keys(state.terminalUiStateByThreadKey),
                ...Object.keys(state.suppressedTerminalIdsByThreadKey),
                ...Object.keys(state.pendingOpenTerminalIdsByThreadKey),
              ].filter((key) => !activeThreadKeys.has(key)),
            );
            if (orphanedIds.size === 0) {
              return state;
            }
            const nextTerminalUiStateByThreadKey = { ...state.terminalUiStateByThreadKey };
            const nextSuppressedTerminalIdsByThreadKey = {
              ...state.suppressedTerminalIdsByThreadKey,
            };
            const nextPendingOpenTerminalIdsByThreadKey = {
              ...state.pendingOpenTerminalIdsByThreadKey,
            };
            for (const id of orphanedIds) {
              delete nextTerminalUiStateByThreadKey[id];
              delete nextSuppressedTerminalIdsByThreadKey[id];
              delete nextPendingOpenTerminalIdsByThreadKey[id];
            }
            return {
              terminalUiStateByThreadKey: nextTerminalUiStateByThreadKey,
              suppressedTerminalIdsByThreadKey: nextSuppressedTerminalIdsByThreadKey,
              pendingOpenTerminalIdsByThreadKey: nextPendingOpenTerminalIdsByThreadKey,
            };
          }),
      };
    },
    {
      name: TERMINAL_UI_STATE_STORAGE_KEY,
      version: 7,
      storage: createJSONStorage(createTerminalUiStateStorage),
      migrate: migratePersistedTerminalUiStateStoreState,
      partialize: (state) => ({
        terminalUiStateByThreadKey: state.terminalUiStateByThreadKey,
        suppressedTerminalIdsByThreadKey: state.suppressedTerminalIdsByThreadKey,
      }),
    },
  ),
);
