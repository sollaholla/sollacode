import type { DesktopPreviewTabState } from "@t3tools/contracts";

type PreviewNavStatus = DesktopPreviewTabState["navStatus"];

/**
 * Whether a nav-status change should drop the agent cursor.
 *
 * Clicks and SPA routers often fire `did-start-loading` without leaving the
 * page. Treating that as a new document unmounted the cursor after the click
 * ping, which is why it seemed to vanish at random. Only a real URL change
 * (or the tab going idle) invalidates the last point.
 */
export function shouldClearBrowserPointer(
  previous: PreviewNavStatus | null,
  current: PreviewNavStatus,
): boolean {
  if (current.kind === "Idle") return previous !== null && previous.kind !== "Idle";
  if (!previous || previous.kind === "Idle") return false;
  return current.url !== previous.url;
}
