import { describe, expect, it } from "vite-plus/test";

import { decideRerun } from "./rerun-unassigned-jobs.ts";

const unassigned = { name: "Build macOS arm64", conclusion: "cancelled", steps: [] };

describe("decideRerun", () => {
  it("reruns a job no runner picked up", () => {
    expect(
      decideRerun([{ name: "Preflight", conclusion: "success", steps: [{}] }, unassigned]),
    ).toEqual({
      action: "rerun",
      jobs: ["Build macOS arm64"],
    });
  });

  it("leaves a real failure for a person, even beside a job waiting for a runner", () => {
    expect(
      decideRerun([{ name: "Test server", conclusion: "failure", steps: [{}] }, unassigned]),
    ).toMatchObject({ action: "stop", reason: expect.stringContaining("Test server") });
  });

  it("does not rerun a job cancelled after it started", () => {
    expect(decideRerun([{ name: "Build", conclusion: "cancelled", steps: [{}] }])).toMatchObject({
      action: "stop",
    });
  });

  it("stops once everything has passed", () => {
    expect(decideRerun([{ name: "Build", conclusion: "success", steps: [{}] }])).toMatchObject({
      action: "stop",
    });
  });
});
