import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";
import { useTerminalUiStateStore } from "../terminalUiStateStore";

/** Both the main terminal and sidebar must maintain the shared session list. */
export function useTerminalSessionReconciliation(
  threadRef: ScopedThreadRef,
  serverTerminalIds: readonly string[],
  localTerminalIds: readonly string[],
  metadataLoaded: boolean,
) {
  const reconcile = useTerminalUiStateStore((state) => state.reconcileTerminalIds);
  useEffect(() => {
    // Loading is not an authoritative empty list. The store also preserves
    // pending local opens until metadata confirms them or the RPC rejects them.
    if (metadataLoaded) reconcile(threadRef, [...serverTerminalIds]);
  }, [reconcile, threadRef, serverTerminalIds, localTerminalIds, metadataLoaded]);
}
