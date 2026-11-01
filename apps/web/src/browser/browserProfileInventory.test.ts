import { AGENTS_PROJECT_ID, EnvironmentId, ThreadId, isAgentsProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildBrowserProfileInventory } from "./browserProfileInventory";

const environmentId = EnvironmentId.make("env-1");
const id = (value: string) => ThreadId.make(value);

const build = (input: {
  readonly threads: Parameters<typeof buildBrowserProfileInventory>[0]["threads"];
  readonly projectIds?: ReadonlyArray<string>;
  readonly complete?: boolean;
}) =>
  buildBrowserProfileInventory({
    environmentId,
    hostedEnvironmentIds: [environmentId],
    projectIds: input.projectIds ?? [],
    threads: input.threads,
    isAgentsProject: isAgentsProjectId,
    complete: input.complete ?? true,
  });

describe("buildBrowserProfileInventory", () => {
  it("separates project threads from agents", () => {
    expect(
      build({
        projectIds: ["project-1", AGENTS_PROJECT_ID],
        threads: [
          { id: id("t1"), projectId: "project-1" },
          { id: id("agent"), projectId: AGENTS_PROJECT_ID },
          { id: id("task"), projectId: AGENTS_PROJECT_ID, browserProfileThreadId: id("agent") },
        ],
      }),
    ).toMatchObject({
      projects: [{ projectId: "project-1", threadIds: ["t1"] }],
      agentRootThreadIds: ["agent"],
    });
  });

  it("keeps a project with no threads, so its profile is not treated as dead", () => {
    expect(build({ projectIds: ["empty"], threads: [] })?.projects).toEqual([
      { projectId: "empty", threadIds: [] },
    ]);
  });

  it("leaves a thread an agent opened in a project to the agent", () => {
    expect(
      build({
        projectIds: ["project-1"],
        threads: [
          { id: id("agent"), projectId: AGENTS_PROJECT_ID },
          { id: id("t1"), projectId: "project-1", browserProfileThreadId: id("agent") },
        ],
      }),
    ).toMatchObject({
      projects: [{ projectId: "project-1", threadIds: [] }],
      agentRootThreadIds: ["agent"],
    });
  });

  it("folds a side chat's parent folder with its project", () => {
    expect(
      build({
        projectIds: ["project-1"],
        threads: [
          { id: id("parent"), projectId: "project-1" },
          { id: id("side"), projectId: "project-1", browserProfileThreadId: id("parent") },
        ],
      })?.projects,
    ).toEqual([{ projectId: "project-1", threadIds: ["parent", "side"] }]);
  });

  it("reports nothing when the list is partial, so nothing looks deleted", () => {
    expect(build({ threads: [], complete: false })).toBeNull();
  });
});
