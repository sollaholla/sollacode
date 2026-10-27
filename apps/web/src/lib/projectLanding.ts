import { isAgentsProjectId, isOrchestratorProjectId } from "@t3tools/contracts";

import { sortScopedProjectsForSidebar } from "../components/Sidebar.logic";

type LandingProject = Parameters<typeof sortScopedProjectsForSidebar>[0][number];
type LandingThread = Parameters<typeof sortScopedProjectsForSidebar>[1][number];

/** Internal workspaces are explicit destinations, never the first project opened for a user. */
export function selectLandingProject<TProject extends LandingProject>(
  projects: readonly TProject[],
  threads: readonly LandingThread[],
  requestedEnvironmentId?: string,
): TProject | null {
  return (
    sortScopedProjectsForSidebar(
      projects.filter(
        (project) =>
          !isOrchestratorProjectId(project.id) &&
          !isAgentsProjectId(project.id) &&
          (requestedEnvironmentId === undefined ||
            project.environmentId === requestedEnvironmentId),
      ),
      threads,
      "updated_at",
    )[0] ?? null
  );
}
