import { AGENTS_PROJECT_ID, ORCHESTRATOR_PROJECT_ID } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { selectLandingProject } from "./projectLanding";

const project = (id: string, environmentId = "local", updatedAt = "2026-10-27T10:00:00Z") => ({
  id,
  environmentId,
  title: id,
  updatedAt,
});

describe("workspace landing", () => {
  it("keeps a freshly seeded environment on setup instead of opening an internal draft", () => {
    expect(
      selectLandingProject([project(ORCHESTRATOR_PROJECT_ID), project(AGENTS_PROJECT_ID)], []),
    ).toBeNull();
  });

  it("opens a user project even when an internal workspace is more recent", () => {
    const userProject = project("site");
    expect(
      selectLandingProject(
        [project(ORCHESTRATOR_PROJECT_ID, "local", "2026-10-27T12:00:00Z"), userProject],
        [],
      ),
    ).toBe(userProject);
  });

  it("keeps a pending sign-in on its requested computer", () => {
    const local = project("site");
    const remote = project("site", "remote", "2026-10-27T12:00:00Z");
    expect(selectLandingProject([local, remote], [])).toBe(remote);
    expect(selectLandingProject([local, remote], [], "local")).toBe(local);
    expect(selectLandingProject([remote], [], "local")).toBeNull();
  });
});
