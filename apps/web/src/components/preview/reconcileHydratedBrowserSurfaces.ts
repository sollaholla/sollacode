import type { ScopedThreadRef } from "@t3tools/contracts";

import type { ThreadPreviewState } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

/**
 * Reconcile persisted Browser surfaces only after preview.list has established
 * which server process and sessions are authoritative.
 */
export function reconcileHydratedBrowserSurfaces(
  threadRef: ScopedThreadRef,
  previewState: Pick<ThreadPreviewState, "serverEpoch" | "sessions">,
): void {
  if (previewState.serverEpoch === null) return;
  useRightPanelStore
    .getState()
    .reconcileBrowserSurfaces(threadRef, Object.keys(previewState.sessions));
}
