import { create } from "zustand";

interface IntentionalShutdownState {
  readonly active: boolean;
  begin: () => void;
}

export const useIntentionalShutdownStore = create<IntentionalShutdownState>((set) => ({
  active: false,
  begin: () => set({ active: true }),
}));

export function beginIntentionalShutdown(): void {
  useIntentionalShutdownStore.getState().begin();
}

export function resetIntentionalShutdownForTests(): void {
  useIntentionalShutdownStore.setState({ active: false });
}
