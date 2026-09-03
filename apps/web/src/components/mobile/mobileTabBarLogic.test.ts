import { describe, expect, it } from "vite-plus/test";

import {
  MOBILE_TABS,
  resolveActiveMobileTab,
  resolveMobileTabSidebarAnchor,
} from "./mobileTabBarLogic";

describe("resolveActiveMobileTab", () => {
  it("maps each route family to its tab", () => {
    expect(resolveActiveMobileTab("/")).toBe("projects");
    expect(resolveActiveMobileTab("/settings")).toBe("settings");
    expect(resolveActiveMobileTab("/settings/appearance")).toBe("settings");
    expect(resolveActiveMobileTab("/agents/env-1/agent-1")).toBe("agents");
    expect(resolveActiveMobileTab("/env-1/thread-1")).toBe("threads");
    expect(resolveActiveMobileTab("/draft/draft-1")).toBe("threads");
  });

  it("lights nothing for routes it does not know", () => {
    expect(resolveActiveMobileTab("/pair")).toBeNull();
    expect(resolveActiveMobileTab("/orchestrator")).toBeNull();
  });
});

describe("resolveMobileTabSidebarAnchor", () => {
  it("scrolls the sheet to the section for navigation tabs only", () => {
    expect(resolveMobileTabSidebarAnchor("agents")).toBe("agents-section-toggle");
    expect(resolveMobileTabSidebarAnchor("threads")).toBe("sidebar-v2-threads-section-toggle");
    expect(resolveMobileTabSidebarAnchor("projects")).toBe("command-palette-trigger");
    expect(resolveMobileTabSidebarAnchor("search")).toBeNull();
    expect(resolveMobileTabSidebarAnchor("settings")).toBeNull();
  });
});

describe("MOBILE_TABS", () => {
  it("is the five-tab bar from the design in order", () => {
    expect(MOBILE_TABS.map((tab) => tab.label)).toEqual([
      "Projects",
      "Agents",
      "Threads",
      "Search",
      "Settings",
    ]);
  });
});
