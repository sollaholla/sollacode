import { describe, expect, it } from "vite-plus/test";

import { buildHostRepairPrompt, hostRepairWorkspaceName } from "./hostRepair.ts";

describe("host repair onboarding", () => {
  it("turns the environment label into a cross-platform workspace name", () => {
    expect(hostRepairWorkspaceName(" Soloman/Main: Mac* ")).toBe("Soloman-Main- Mac-");
    expect(hostRepairWorkspaceName("   ")).toBe("Solla Computer Repair");
  });

  it("gives the repair agent bounded autonomous cleanup rules", () => {
    const prompt = buildHostRepairPrompt({
      environmentLabel: "SolomansComputer",
      platform: "darwin/arm64",
      triggeringError: "thread/resume timed out",
    });

    expect(prompt).toContain("approval-required access");
    expect(prompt).toContain("thread/resume timed out");
    expect(prompt).toContain("Never kill by a broad name/path pattern");
    expect(prompt).toContain("live userdata database as read-only");
    expect(prompt).toContain("exact before/after measurements");
  });
});
