import { createFileRoute, redirect } from "@tanstack/react-router";

import { SETTINGS_MOBILE_TABS_QUERY } from "../components/settings/SettingsMobileTabs";
import { SettingsPhoneHome } from "../components/settings/SettingsPhoneHome";

/** Phones open on the category list. Elsewhere the sidebar is that list. */
export const Route = createFileRoute("/settings/")({
  beforeLoad: () => {
    if (typeof window !== "undefined" && window.matchMedia(SETTINGS_MOBILE_TABS_QUERY).matches) {
      return;
    }
    throw redirect({ to: "/settings/general", replace: true });
  },
  component: SettingsPhoneHome,
});
