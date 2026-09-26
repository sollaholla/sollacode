import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { SETTINGS_MOBILE_TABS_QUERY, SettingsMobileTabs } from "./SettingsMobileTabs";
import { visibleSettingsNavItems } from "./SettingsSidebarNav";
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

  it("offers every section the sidebar does, so the two cannot drift", () => {
    const markup = renderToStaticMarkup(<SettingsMobileTabs pathname="/settings/general" />);
    for (const item of visibleSettingsNavItems()) {
      expect(markup).toContain(`data-settings-mobile-tab="${item.to}"`);
      expect(markup).toContain(item.label);
    }
  });

  it("marks the open section for assistive tech", () => {
    const markup = renderToStaticMarkup(<SettingsMobileTabs pathname="/settings/providers" />);
    // Navigation, not ARIA tabs: `aria-current` is the honest description of a
    // link set that changes the route, and it carries no tabpanel promise.
    expect(markup).toContain('aria-current="page"');
    expect(markup).not.toContain('role="tab"');
    expect(markup).toContain('aria-label="Settings sections"');
  });

  it("scrolls horizontally without leaving a scrollbar across the strip", () => {
    const markup = renderToStaticMarkup(<SettingsMobileTabs pathname="/settings/general" />);
    expect(markup).toContain("overflow-x-auto");
    // Tabs must not wrap onto a second row — the strip is one line that scrolls.
    expect(markup).toContain("whitespace-nowrap");
    expect(markup).toContain("[&amp;::-webkit-scrollbar]:hidden");
  });
});
