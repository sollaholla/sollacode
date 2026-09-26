import type { ScopedThreadRef } from "@t3tools/contracts";
import { selectActiveRightPanelSurface, useRightPanelStore } from "../rightPanelStore";

/** Reveal a sender without removing the side-chat tabs or interrupting their work. */
export function collapseSenderSideChats(
  route: ScopedThreadRef | null,
  destination: ScopedThreadRef,
) {
  for (const ref of [route, destination]) {
    if (!ref) continue;
    const store = useRightPanelStore.getState();
    if (selectActiveRightPanelSurface(store.byThreadKey, ref)?.kind === "side-chat") {
      store.setOpen(ref, false);
    }
  }
}
