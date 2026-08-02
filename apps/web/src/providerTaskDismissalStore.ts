import { create } from "zustand";

import { createMemoryStorage, isStateStorage, type StateStorage } from "./lib/storage";
import { pruneProviderTaskDismissals, type ProviderTaskDismissals } from "./providerTasks";

/**
 * Which background tasks the user has hidden.
 *
 * The panel's rows are folded from an append-only activity stream, so a task
 * cannot be deleted — only hidden — and the record of hiding it belongs to the
 * client. It is persisted because the case this exists for is a task whose
 * runtime died without ever reporting completion: that row would otherwise come
 * back on every reload, forever.
 */

export const PROVIDER_TASK_DISMISSALS_STORAGE_KEY = "t3code:provider-task-dismissals:v1";

/**
 * Node >= 22 defines a `localStorage` global that throws unless the process was
 * started with a backing file, so presence alone is not enough — the shape is
 * checked before it is trusted.
 */
function resolveStorage(): StateStorage {
  try {
    if (typeof localStorage !== "undefined" && isStateStorage(localStorage)) {
      return localStorage;
    }
  } catch {
    // Fall through to the in-memory store.
  }
  return createMemoryStorage();
}

const storage = resolveStorage();

function readPersisted(): ProviderTaskDismissals {
  try {
    const raw = storage.getItem(PROVIDER_TASK_DISMISSALS_STORAGE_KEY);
    // The storage interface allows an async implementation; both backings here
    // are synchronous, and a promise would mean an empty first render anyway.
    if (typeof raw !== "string" || raw.length === 0) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const entries: Record<string, string> = {};
    for (const [taskId, dismissedAt] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof dismissedAt === "string" && dismissedAt.length > 0) {
        entries[taskId] = dismissedAt;
      }
    }
    // Prune on read: a record for a task that has aged out can never be used.
    return pruneProviderTaskDismissals(entries);
  } catch {
    // A corrupt or unreadable record must not stop the panel from rendering.
    return {};
  }
}

function persist(dismissals: ProviderTaskDismissals): void {
  try {
    storage.setItem(PROVIDER_TASK_DISMISSALS_STORAGE_KEY, JSON.stringify(dismissals));
  } catch {
    // Quota or a locked-down storage: the dismissal still applies this session.
  }
}

interface ProviderTaskDismissalState {
  readonly dismissals: ProviderTaskDismissals;
  readonly dismissTasks: (taskIds: ReadonlyArray<string>, dismissedAt?: string) => void;
  readonly restoreTask: (taskId: string) => void;
  readonly clearDismissals: () => void;
}

export const useProviderTaskDismissalStore = create<ProviderTaskDismissalState>((set) => ({
  dismissals: readPersisted(),
  dismissTasks: (taskIds, dismissedAt) =>
    set((state) => {
      if (taskIds.length === 0) return state;
      const stamp = dismissedAt ?? new Date().toISOString();
      const next = { ...state.dismissals };
      for (const taskId of taskIds) next[taskId] = stamp;
      const pruned = pruneProviderTaskDismissals(next);
      persist(pruned);
      return { dismissals: pruned };
    }),
  restoreTask: (taskId) =>
    set((state) => {
      if (state.dismissals[taskId] === undefined) return state;
      const next = { ...state.dismissals };
      delete next[taskId];
      persist(next);
      return { dismissals: next };
    }),
  clearDismissals: () =>
    set(() => {
      persist({});
      return { dismissals: {} };
    }),
}));
