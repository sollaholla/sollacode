export const RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 980px)";
export const RIGHT_PANEL_SHEET_CLASS_NAME =
  "h-full w-full min-w-0 max-w-none border-s-0 p-0 outline-none pt-[env(safe-area-inset-top)] ps-[env(safe-area-inset-left)] pe-[env(safe-area-inset-right)] wco:mt-[env(titlebar-area-height)] wco:h-[calc(100%-env(titlebar-area-height))] wco:max-h-[calc(100%-env(titlebar-area-height))] wco:pt-0";

/**
 * Bottom inset for the full-window sheet's content. The sheet leaves the home
 * indicator area to each surface: a side chat's composer already reserves it in
 * the chat's own background, so padding it again left a second, lighter band
 * under the composer. Every other surface gets the plain safe-area padding.
 */
export function rightPanelSheetContentInsetClassName(activeSurfaceKind: string | null): string {
  return activeSurfaceKind === "side-chat" ? "" : "pb-safe";
}
