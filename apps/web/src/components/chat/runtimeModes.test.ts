import { describe, expect, it } from "vite-plus/test";

import { runtimeModeConfig, runtimeModeDangerClasses } from "./runtimeModes";

describe("runtime mode presentation", () => {
  it("marks only Full access as dangerous", () => {
    expect(runtimeModeConfig["full-access"].tone).toBe("danger");
    expect(runtimeModeConfig["approval-required"].tone).toBe("default");
    expect(runtimeModeConfig["auto-accept-edits"].tone).toBe("default");
    expect(runtimeModeConfig.auto.tone).toBe("default");
  });

  it("tints the selected control, its compact icon, and menu row red", () => {
    expect(runtimeModeDangerClasses.control).toContain("text-destructive");
    expect(runtimeModeDangerClasses.control).toContain("bg-destructive");
    expect(runtimeModeDangerClasses.icon).toContain("text-destructive");
    expect(runtimeModeDangerClasses.item).toContain("data-selected:bg-destructive");
    expect(runtimeModeDangerClasses.compactItem).toContain("data-checked:bg-destructive");
  });
});
