import { describe, expect, it } from "vite-plus/test";

import { isSettingsPath, settingsCloseStep } from "./closeSettings";

describe("closing settings", () => {
  it("steps back past every settings page to the screen it was opened from", () => {
    // Opened from a chat at entry 4, then General, Projects, and one project.
    expect(settingsCloseStep(7, { index: 4, href: "/env/thread" })).toBe(-3);
    expect(settingsCloseStep(5, { index: 4, href: "/env/thread" })).toBe(-1);
  });

  it("has nowhere to step back to when settings was the first page loaded", () => {
    expect(settingsCloseStep(0, null)).toBeNull();
    expect(settingsCloseStep(2, null)).toBeNull();
    // The recorded screen is not behind this entry, such as after a reload.
    expect(settingsCloseStep(2, { index: 2, href: "/" })).toBeNull();
    expect(settingsCloseStep(2, { index: 5, href: "/" })).toBeNull();
  });

  it("tells settings pages from the rest of the app", () => {
    expect(isSettingsPath("/settings")).toBe(true);
    expect(isSettingsPath("/settings/projects/env/project")).toBe(true);
    expect(isSettingsPath("/settingsy")).toBe(false);
    expect(isSettingsPath("/env/thread")).toBe(false);
  });
});
