import type { PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";

import type { OpenPreviewMutation } from "~/browser/openFileInPreview";
import {
  isPreviewSupportedInRuntime,
  readThreadPreviewState,
  setActivePreviewTab,
} from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

import { openPreviewSession } from "./openPreviewSession";

/**
 * The preview tab currently showing exactly `url`, if any. Both sides are
 * compared after `normalizePreviewUrl` so `example.com` matches the
 * `https://example.com/` a tab actually reports. A tab that has since
 * navigated elsewhere (redirect, user browsing) intentionally does not match
 * — reuse only applies when the page on screen is the one being requested.
 */
export function findPreviewTabAtUrl(
  sessions: Record<string, PreviewSessionSnapshot>,
  url: string,
): string | null {
  let target: string;
  try {
    target = normalizePreviewUrl(url);
  } catch {
    return null;
  }
  for (const session of Object.values(sessions)) {
    if (session.navStatus._tag === "Idle") continue;
    try {
      if (normalizePreviewUrl(session.navStatus.url) === target) return session.tabId;
    } catch {
      // A malformed reported URL never matches; keep scanning.
    }
  }
  return null;
}

export type OpenUrlInThreadPreviewOutcome = "reused-tab" | "opened-tab" | "opened-externally";

/**
 * Show `url` in the thread's collaborative preview browser: focus the tab
 * already at that exact URL when one exists, otherwise open a new tab there.
 * Falls back to the system browser when the runtime has no preview webview or
 * the URL is not previewable (non-http scheme, malformed).
 */
export async function openUrlInThreadPreview<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly url: string;
  readonly openPreview: OpenPreviewMutation<E>;
  readonly openExternally: (url: string) => void;
}): Promise<OpenUrlInThreadPreviewOutcome> {
  const supported = (() => {
    if (!isPreviewSupportedInRuntime()) return false;
    try {
      normalizePreviewUrl(input.url);
      return true;
    } catch {
      return false;
    }
  })();
  if (!supported) {
    input.openExternally(input.url);
    return "opened-externally";
  }

  const existingTabId = findPreviewTabAtUrl(
    readThreadPreviewState(input.threadRef).sessions,
    input.url,
  );
  if (existingTabId !== null) {
    setActivePreviewTab(input.threadRef, existingTabId);
    useRightPanelStore.getState().openBrowser(input.threadRef, existingTabId);
    return "reused-tab";
  }

  const result = await openPreviewSession({
    openPreview: input.openPreview,
    threadRef: input.threadRef,
    url: input.url,
  });
  if (result._tag === "Failure") {
    input.openExternally(input.url);
    return "opened-externally";
  }
  useRightPanelStore.getState().openBrowser(input.threadRef, result.value.tabId);
  return "opened-tab";
}
