import type { ScopedThreadRef } from "@t3tools/contracts";

import { setActivePreviewTab } from "~/previewStateStore";
import { usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { useRightPanelStore } from "~/rightPanelStore";

/**
 * Put the agent's tab in the thread's Browser panel, the same way a user
 * click or `target=_blank` does.
 *
 * `preview_open` used to only spawn the floating mini-player. That left the
 * panel on a different page (often an authenticated YouTube/Gmail guest)
 * while automation drove a hidden tab that reported `visible: false` and an
 * empty login — observed 2026-08-28 on Pawstalgia vs Instagram.
 */
export function presentPreviewAutomationTab(threadRef: ScopedThreadRef, tabId: string): void {
  setActivePreviewTab(threadRef, tabId);
  useRightPanelStore.getState().openBrowser(threadRef, tabId);
  usePreviewMiniPlayerStore.getState().close(threadRef);
}
