import { create } from "zustand";

/** Opens the tour over whatever screen someone is on, from Settings or the palette. */
export const useWelcomeTourReplayStore = create<{
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
}>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export function openWelcomeTourReplay(): void {
  useWelcomeTourReplayStore.getState().setOpen(true);
}

/**
 * While someone is in first-run or the replayed tour, nothing else should talk
 * over it. Prompts such as provider updates wait until this clears.
 */
export const useFirstRunActiveStore = create<{
  readonly active: boolean;
  readonly setActive: (active: boolean) => void;
}>((set) => ({
  active: false,
  setActive: (active) => set({ active }),
}));
