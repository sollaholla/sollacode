import { create } from "zustand";

interface StartupResumeState {
  readonly pendingStartedAtByThreadKey: Readonly<Record<string, string>>;
  readonly markPending: (threadKeys: ReadonlyArray<string>, startedAt?: string) => void;
  readonly clearPending: (threadKey: string) => void;
}

/** Session-local visibility for startup turns submitted outside any ChatView. */
export const useStartupResumeStore = create<StartupResumeState>((set) => ({
  pendingStartedAtByThreadKey: {},
  markPending: (threadKeys, startedAt) =>
    set((state) => {
      if (threadKeys.length === 0) return state;
      const stamp = startedAt ?? new Date().toISOString();
      const next = { ...state.pendingStartedAtByThreadKey };
      for (const threadKey of threadKeys) {
        next[threadKey] ??= stamp;
      }
      return { pendingStartedAtByThreadKey: next };
    }),
  clearPending: (threadKey) =>
    set((state) => {
      if (state.pendingStartedAtByThreadKey[threadKey] === undefined) return state;
      const next = { ...state.pendingStartedAtByThreadKey };
      delete next[threadKey];
      return { pendingStartedAtByThreadKey: next };
    }),
}));
