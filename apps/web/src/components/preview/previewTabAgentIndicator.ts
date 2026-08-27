import type { DesktopPreviewOverlay } from "../../previewStateStore";

export type PreviewTabAgentIndicator = "agent" | "waiting" | null;

/**
 * Whether a preview tab should wear the agent cursor in the tab strip.
 *
 * With several browser tabs open there was no way to tell which one an agent
 * was actually working in without opening each — the cursor only exists inside
 * the page it is moving in. Badging the tab puts that answer in the strip.
 *
 * "waiting" is its own state rather than nothing: an agent holding off for the
 * user still owns that tab's queue, and showing nothing there would read as
 * "no agent here" at the exact moment the user is deciding whether to click
 * into it.
 */
export function resolvePreviewTabAgentIndicator(
  controller: DesktopPreviewOverlay["controller"] | undefined,
): PreviewTabAgentIndicator {
  switch (controller) {
    case "agent":
      return "agent";
    case "waiting-for-user":
      return "waiting";
    // A tab the human is driving is the one place the badge would be a lie.
    default:
      return null;
  }
}
