import { describe, expect, it } from "vite-plus/test";

import { SETTINGS_NAV_ITEMS } from "./SettingsSidebarNav";
import { SETTINGS_SEARCH_INDEX, searchSettings, settingsRowAnchor } from "./settingsSearchIndex";

describe("settingsSearchIndex", () => {
  it("derives stable row anchors from titles", () => {
    expect(settingsRowAnchor("Glass opacity")).toBe("setting-glass-opacity");
    expect(settingsRowAnchor("Let me interrupt by talking over it")).toBe(
      "setting-let-me-interrupt-by-talking-over-it",
    );
  });

  it("only points at tabs the sidebar can navigate to", () => {
    const navPaths = new Set<string>([
      ...SETTINGS_NAV_ITEMS.map((item) => item.to),
      "/settings/permissions",
    ]);
    for (const entry of SETTINGS_SEARCH_INDEX) {
      expect(navPaths.has(entry.tab)).toBe(true);
    }
  });

  it("keeps anchors unique within a tab", () => {
    const seen = new Set<string>();
    for (const entry of SETTINGS_SEARCH_INDEX) {
      const key = `${entry.tab}#${entry.anchor ?? settingsRowAnchor(entry.title)}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("ranks title matches above keyword matches and requires every token", () => {
    const [first] = searchSettings("theme");
    expect(first?.title).toBe("Theme");
    expect(first?.tab).toBe("/settings/appearance");
    expect(searchSettings("whitespace diff").map((result) => result.title)).toEqual([
      "Hide whitespace changes",
    ]);
    expect(searchSettings("quota")[0]?.title).toBe("Provider usage bar");
    expect(searchSettings("")).toEqual([]);
    expect(searchSettings("zzzz-nothing")).toEqual([]);
  });

  it("hides desktop-only entries unless asked", () => {
    expect(
      searchSettings("permissions").some((result) => result.tab === "/settings/permissions"),
    ).toBe(false);
    expect(
      searchSettings("permissions", SETTINGS_SEARCH_INDEX, { includeDesktopOnly: true }).some(
        (result) => result.tab === "/settings/permissions",
      ),
    ).toBe(true);
  });
});
