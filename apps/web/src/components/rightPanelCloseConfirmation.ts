import type { RightPanelSurface } from "../rightPanelStore";

export interface RightPanelCloseConfirmation {
  readonly message: string;
  readonly confirmLabel: string;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * What to ask before a person closes right-panel tabs, or null when nothing
 * they would lose is among them.
 *
 * Only tabs holding live state ask: a browser tab with a page open, and a
 * terminal, whose process and history are deleted with it. Files, diffs, the
 * plan and artifacts reopen from their source, side chats have their own
 * archive confirmation, and a blank new browser tab has nothing in it.
 *
 * This runs only for closes the person starts (the tab's X, middle-click, its
 * menu). An agent's `preview_close` and a tab expiring never come through here.
 */
export function describeRightPanelCloseConfirmation(
  surfaces: ReadonlyArray<RightPanelSurface>,
): RightPanelCloseConfirmation | null {
  let browserTabs = 0;
  let terminals = 0;
  for (const surface of surfaces) {
    if (surface.kind === "preview" && surface.resourceId !== null) browserTabs += 1;
    if (surface.kind === "terminal") terminals += Math.max(1, surface.terminalIds.length);
  }
  if (browserTabs === 0 && terminals === 0) return null;

  const only = browserTabs + terminals === 1;
  const subjects: string[] = [];
  if (browserTabs > 0) {
    subjects.push(only ? "browser tab" : plural(browserTabs, "browser tab", "browser tabs"));
  }
  if (terminals > 0) {
    subjects.push(only ? "terminal" : plural(terminals, "terminal", "terminals"));
  }
  const consequences: string[] = [];
  if (browserTabs > 0) {
    consequences.push(browserTabs === 1 ? "the open page is closed" : "the open pages are closed");
  }
  if (terminals > 0) {
    consequences.push(
      terminals === 1
        ? "its running processes and history are deleted"
        : "their running processes and history are deleted",
    );
  }
  return {
    message: `Close ${only ? "this " : ""}${subjects.join(" and ")}? ${consequences
      .join(" and ")
      .replace(/^./, (first) => first.toUpperCase())}.`,
    confirmLabel: "Close",
  };
}
