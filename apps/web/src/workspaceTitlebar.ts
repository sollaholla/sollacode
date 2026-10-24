/** Room the macOS window buttons take at the top left of a desktop window, outside full screen. */
export const MACOS_TRAFFIC_LIGHTS_LEFT_INSET = "90px";

export const COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS =
  "[[data-sidebar-state=collapsed]_&]:pl-[var(--workspace-titlebar-content-left)]";

/**
 * The same inset, but only where a docked sidebar rail actually exists.
 *
 * Below `md` the sidebar is a drawer and the phone top bar carries navigation,
 * so there is no rail or window control to clear — the padding just pushed the
 * header's title into the middle of nowhere while everything under it stayed
 * flush left.
 */
export const COLLAPSED_SIDEBAR_TITLEBAR_INSET_MD_CLASS =
  "md:[[data-sidebar-state=collapsed]_&]:pl-[var(--workspace-titlebar-content-left)]";
