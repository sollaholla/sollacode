import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

// Keep the opening gesture across the lazy terminal mount. A restored pane
// has no request and remains a passive viewer of the current owner's grid.
let pendingActivation: {
  threadKey: string;
  terminalId: string | undefined;
  surface: TerminalGeometrySurface;
  requestedAt: number;
} | null = null;

export type TerminalGeometrySurface = "drawer" | "right-panel";

export function requestTerminalGeometryActivation(
  threadRef: ScopedThreadRef,
  terminalId?: string,
  surface: TerminalGeometrySurface = "drawer",
): void {
  pendingActivation = {
    threadKey: scopedThreadKey(threadRef),
    terminalId,
    surface,
    requestedAt: Date.now(),
  };
}

/** Only the latest deliberate terminal activation may claim the shared PTY. */
export function consumeTerminalGeometryActivation(
  threadRef: ScopedThreadRef,
  terminalId: string,
  surface: TerminalGeometrySurface = "drawer",
): boolean {
  if (!pendingActivation) return false;
  if (Date.now() - pendingActivation.requestedAt > 30_000) {
    pendingActivation = null;
    return false;
  }
  if (
    pendingActivation.threadKey !== scopedThreadKey(threadRef) ||
    pendingActivation.surface !== surface ||
    (pendingActivation.terminalId !== undefined && pendingActivation.terminalId !== terminalId)
  ) {
    return false;
  }
  pendingActivation = null;
  return true;
}
