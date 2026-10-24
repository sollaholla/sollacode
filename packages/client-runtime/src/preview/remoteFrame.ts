import type {
  PreviewRemoteSnapshotInput,
  PreviewRemoteSnapshotResult,
  PreviewRemoteSnapshotUnchangedResult,
} from "@t3tools/contracts";

export type RemoteSnapshot = PreviewRemoteSnapshotResult | PreviewRemoteSnapshotUnchangedResult;

/**
 * The request for the next frame of a tab. When the viewer already holds a
 * frame of this tab it says which, so the server can answer "same picture"
 * instead of sending the JPEG again.
 */
export function remoteSnapshotRequest(
  base: Pick<PreviewRemoteSnapshotInput, "threadId" | "tabId">,
  held: PreviewRemoteSnapshotResult | null,
): PreviewRemoteSnapshotInput {
  return held !== null && held.tabId === base.tabId && held.frameId !== undefined
    ? { ...base, unchangedSince: held.frameId }
    : base;
}

/**
 * Folds an incoming snapshot into the frame the viewer holds. A full frame
 * replaces it. An "unchanged" answer keeps the held picture and takes the rest
 * (address, title, agent cursor, pending approvals), which is current. One that
 * arrives after the viewer has moved to another frame or tab is dropped: it
 * describes a picture the viewer no longer holds, and the next poll fetches
 * whatever is now true.
 */
export function mergeRemoteSnapshot(
  held: PreviewRemoteSnapshotResult | null,
  incoming: RemoteSnapshot,
): PreviewRemoteSnapshotResult | null {
  if (!("unchanged" in incoming)) {
    return incoming;
  }
  if (held === null || held.tabId !== incoming.tabId || held.frameId !== incoming.frameId) {
    return held;
  }
  const { unchanged: _unchanged, ...current } = incoming;
  return { ...held, ...current };
}
