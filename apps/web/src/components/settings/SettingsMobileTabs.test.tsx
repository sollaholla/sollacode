import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { SETTINGS_MOBILE_TABS_QUERY } from "./SettingsMobileTabs";
import { SettingsPhoneHome } from "./SettingsPhoneHome";
import { SETTINGS_NAV_GROUPS, isSettingsSectionActive } from "./SettingsSidebarNav";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_MD_CLASS } from "../../workspaceTitlebar";

vi.mock("@tanstack/react-router", () => ({
  useCanGoBack: () => false,
  useNavigate: () => () => Promise.resolve(),
}));

describe("SettingsMobileTabs", () => {
  it("keeps the settings title flush left where there is no sidebar rail", () => {
    // The desktop inset clears the collapsed rail and window controls. Phones
    // have neither, and applying it anyway left the title stranded mid-header
    // while the tabs and the panel below stayed flush left.
    expect(COLLAPSED_SIDEBAR_TITLEBAR_INSET_MD_CLASS.startsWith("md:")).toBe(true);
    // Underscores are how a Tailwind arbitrary variant spells a space; without
    // them the class compiles, ships, and silently never matches.
    expect(COLLAPSED_SIDEBAR_TITLEBAR_INSET_MD_CLASS).toContain("data-sidebar-state=collapsed]_&");
  });

  it("is scoped to portrait phones, not merely narrow windows", () => {
    // Landscape keeps the sidebar — a strip would spend the vertical room that
    // orientation is already short of. The width half must stay in step with
    // `useIsMobile` (max-md = 767px) so a slim desktop window is unaffected.
    expect(SETTINGS_MOBILE_TABS_QUERY).toContain("(orientation: portrait)");
    expect(SETTINGS_MOBILE_TABS_QUERY).toContain("(max-width: 767px)");
  });

  it("lists every section by category, each saying what lives there", () => {
    const markup = renderToStaticMarkup(<SettingsPhoneHome />);
    for (const group of SETTINGS_NAV_GROUPS) {
      expect(markup).toContain(`aria-label="${group.label}"`);
      for (const item of group.items) {
        expect(markup).toContain(`data-settings-phone-section="${item.to}"`);
        expect(markup).toContain(item.description);
      }
    }
  });

  it("keeps a section marked on the pages beneath it", () => {
    expect(isSettingsSectionActive("/settings/projects/env/project", "/settings/projects")).toBe(
      true,
    );
    expect(isSettingsSectionActive("/settings/projects", "/settings/general")).toBe(false);
  });

  it("files every section under exactly one category", () => {
    const paths = SETTINGS_NAV_GROUPS.flatMap((group) => group.items.map((item) => item.to));
    expect(new Set(paths).size).toBe(paths.length);
  });
});
