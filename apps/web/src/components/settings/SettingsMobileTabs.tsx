import { useMediaQuery } from "~/hooks/useMediaQuery";

/**
 * Phone-held-upright only.
 *
 * Landscape keeps the sidebar: there is width for it there. The width half
 * matches `useIsMobile` (max-md), so a narrow desktop window does not
 * pick up a phone affordance.
 */
export const SETTINGS_MOBILE_TABS_QUERY = "(max-width: 767px) and (orientation: portrait)";

export function useSettingsMobileTabs(): boolean {
  return useMediaQuery(SETTINGS_MOBILE_TABS_QUERY);
}
