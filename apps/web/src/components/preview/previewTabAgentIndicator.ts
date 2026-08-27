import type { DesktopPreviewOverlay } from "../../previewStateStore";

export type PreviewTabAgentIndicator = "agent" | "waiting" | null;

/**
 * Whether a preview tab should wear the agent cursor in the tab strip.
 *
 * With several browser tabs open there was no way to tell which one an agent
 * was actually working in without opening each — the cursor only exists inside
 * the page it is moving in. Badging the tab puts that answer in the strip.
 *
 * `controller` alone is not enough, and the first version of this got that
 * wrong: it is only "agent" while a single CDP command is in flight, so the
 * badge appeared for a fraction of a second per tool call and was invisible
 * between them. `agentActive` is the sticky mark the desktop keeps on the tab
 * an agent is working in, and it is what makes the badge stay put for the
 * length of a turn.
 *
 * "waiting" is its own state rather than nothing: an agent holding off for the
 * user still owns that tab's queue, and showing nothing there would read as
 * "no agent here" at the exact moment the user is deciding whether to click
 * into it.
 */
export function resolvePreviewTabAgentIndicator(
  overlay:
    | {
        readonly controller: DesktopPreviewOverlay["controller"];
        readonly agentActive?: boolean;
      }
    | undefined,
): PreviewTabAgentIndicator {
  if (overlay === undefined) return null;
  if (overlay.controller === "waiting-for-user") return "waiting";
  // A tab the human has taken over is the one place the badge would be a lie,
  // even if an agent drove it a moment ago.
  if (overlay.controller === "human") return null;
  if (overlay.controller === "agent") return "agent";
  return overlay.agentActive === true ? "agent" : null;
}
