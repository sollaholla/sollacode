import type { ScopedThreadRef } from "@t3tools/contracts";

const PERSISTED_PREVIEW_TAB_ID =
  /^tab_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function hasStablePreviewTabIdentity(tabId: string): boolean {
  return PERSISTED_PREVIEW_TAB_ID.test(tabId);
}

/**
 * Current servers persist UUID tab ids across process restarts. Keep the
 * Electron guest keyed to that durable identity so reconnecting the server
 * cannot reload the page or swap its browser partition. Legacy servers used
 * process-local ids such as `tab_1`; retain the epoch fence for those ids.
 */
export function previewRuntimeTabId(
  threadRef: ScopedThreadRef,
  serverEpoch: string | null,
  tabId: string,
): string {
  return JSON.stringify([
    threadRef.environmentId,
    threadRef.threadId,
    hasStablePreviewTabIdentity(tabId) ? null : serverEpoch,
    tabId,
  ]);
}

export function isCurrentPreviewRuntimeTab(
  threadRef: ScopedThreadRef,
  serverEpoch: string | null,
  tabId: string,
  runtimeTabId: string,
): boolean {
  return previewRuntimeTabId(threadRef, serverEpoch, tabId) === runtimeTabId;
}
