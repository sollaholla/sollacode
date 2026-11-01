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

  it("can find every setting on every page", () => {
    // These read as status messages or live on a per-project page with no fixed
    // address, so there is nothing to jump to.
    const notSettings = new Set([
      "Chats",
      "Nearby devices are already connected",
      "Searching this network",
    ]);
    const indexed = new Set(SETTINGS_SEARCH_INDEX.map((entry) => entry.title));
    const missing: string[] = [];
    const sources = import.meta.glob("./*.tsx", {
      eager: true,
      query: "?raw",
      import: "default",
    }) as Record<string, string>;
    for (const [file, source] of Object.entries(sources)) {
      if (file.includes(".test.")) continue;
      for (const match of source.matchAll(/<SettingsRow[^>]*?\btitle="([^"]+)"/gs)) {
        const title = match[1]!;
        if (!indexed.has(title) && !notSettings.has(title)) missing.push(`${file}: ${title}`);
      }
      for (const match of source.matchAll(/<SettingsSection[^>]*?\btitle="([^"]+)"/gs)) {
        const title = match[1]!;
        const known =
          indexed.has(title) ||
          notSettings.has(title) ||
          SETTINGS_SEARCH_INDEX.some((entry) => entry.section === title);
        if (!known) missing.push(`${file}: ${title}`);
      }
    }
    expect(missing).toEqual([]);
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

  it("finds project management by what people call it", () => {
    for (const query of ["delete project", "token spend", "rename project"]) {
      expect(searchSettings(query)[0]?.tab).toBe("/settings/projects");
    }
    expect(searchSettings("storage")[0]?.tab).toBe("/settings/storage");
  });

  it("finds saved passwords on every client, since any device can manage them", () => {
    expect(searchSettings("saved passwords")[0]?.tab).toBe("/settings/credentials");
  });
});
