import { create } from "zustand";

/**
 * The phone top bar's trailing slot. A screen that folds its own header away
 * (an agent's card, collapsed to its avatar) portals the controls it keeps
 * into this element. `null` while no phone top bar is mounted — from `md` up
 * the bar is hidden and screens keep their full headers.
 */
export const useMobileTopBarTrailingSlot = create<{
  readonly element: HTMLElement | null;
  readonly setElement: (element: HTMLElement | null) => void;
}>((set) => ({
  element: null,
  setElement: (element) => set((state) => (state.element === element ? state : { element })),
}));
