/**
 * The phone shell's bottom tab bar.
 *
 * Five destinations, matching the Obsidian & Gold mockup: Projects, Agents and
 * Threads open the navigation sheet at their section (the sheet IS the
 * navigation on a phone — the docked sidebar has nowhere to live); Search opens
 * the command palette; Settings is a route.
 */
export type MobileTab = "projects" | "agents" | "threads" | "search" | "settings";

export interface MobileTabDefinition {
  readonly id: MobileTab;
  readonly label: string;
}

export const MOBILE_TABS: ReadonlyArray<MobileTabDefinition> = [
  { id: "projects", label: "Projects" },
  { id: "agents", label: "Agents" },
  { id: "threads", label: "Threads" },
  { id: "search", label: "Search" },
  { id: "settings", label: "Settings" },
];

/**
 * Which tab the current route belongs to. Search is a palette, never a route,
 * so it is never the active tab. The home route lists projects; an agent
 * workspace is an agent; anything with an environment and thread id is a
 * thread. Unknown routes light nothing up rather than guessing.
 */
export function resolveActiveMobileTab(pathname: string): MobileTab | null {
  if (pathname === "/") return "projects";
  if (pathname === "/settings" || pathname.startsWith("/settings/")) return "settings";
  if (pathname === "/agents" || pathname.startsWith("/agents/")) return "agents";
  if (pathname.startsWith("/draft/")) return "threads";
  if (/^\/[^/]+\/[^/]+\/?$/.test(pathname)) return "threads";
  return null;
}

/**
 * The sidebar section a navigation tab scrolls to once the sheet is open, by
 * the `data-testid` the sidebar already carries on that section's header.
 */
export function resolveMobileTabSidebarAnchor(tab: MobileTab): string | null {
  switch (tab) {
    case "agents":
      return "agents-section-toggle";
    case "threads":
      return "sidebar-v2-threads-section-toggle";
    case "projects":
      return "command-palette-trigger";
    default:
      return null;
  }
}
