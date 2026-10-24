import { useAtomValue } from "@effect/atom-react";
import {
  createProjectStatisticsAtomFamily,
  joinProjectStatistics,
  projectStatisticsStatus,
  type ProjectOverview,
  type ProjectStatisticsEnvironmentState,
} from "@t3tools/client-runtime/state/project-statistics";
import { makeArchivedThreadsEnvironmentKey } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { appAtomRegistry } from "./atom-registry";
import { useProjects } from "./entities";
import { orchestrationEnvironment } from "./orchestration";
import { useAtomCommand } from "./use-atom-command";

function statisticsAtom(environmentId: EnvironmentId) {
  return orchestrationEnvironment.projectStatistics({ environmentId, input: {} });
}

function foldersAtom(environmentId: EnvironmentId) {
  return orchestrationEnvironment.projectFolders({ environmentId, input: {} });
}

const projectStatisticsAtom = createProjectStatisticsAtomFamily({
  getStatisticsAtom: statisticsAtom,
  getFoldersAtom: foldersAtom,
  labelPrefix: "mobile:project-statistics",
});

export interface ProjectOverviewsView {
  readonly overviews: ReadonlyArray<ProjectOverview>;
  readonly environments: ReadonlyArray<ProjectStatisticsEnvironmentState>;
  readonly isLoading: boolean;
  readonly error: string | null;
  /** The earliest turn any environment counted; null until one has. */
  readonly tokenTrackingSince: string | null;
  /** Loads the numbers again and measures the folders anew: these projects', or every one. */
  readonly refresh: (projectIds?: ReadonlyArray<ProjectId>) => void;
}

/** Every live project across connected environments, with what it holds and has used. */
export function useProjectOverviews(): ProjectOverviewsView {
  const projects = useProjects();
  const environmentIds = useMemo(
    () => [...new Set(projects.map((project) => project.environmentId))],
    [projects],
  );
  const environmentKey = useMemo(
    () => makeArchivedThreadsEnvironmentKey(environmentIds),
    [environmentIds],
  );
  const environments = useAtomValue(projectStatisticsAtom(environmentKey));
  const overviews = useMemo(
    () => joinProjectStatistics(projects, environments),
    [environments, projects],
  );
  const measureFolders = useAtomCommand(orchestrationEnvironment.measureProjectFolders, {
    reportFailure: false,
  });
  const refresh = useCallback(
    (projectIds?: ReadonlyArray<ProjectId>) => {
      for (const environmentId of environmentIds) {
        appAtomRegistry.refresh(statisticsAtom(environmentId));
        const ids = projects
          .filter(
            (project) =>
              project.environmentId === environmentId &&
              (projectIds === undefined || projectIds.includes(project.id)),
          )
          .map((project) => project.id);
        if (ids.length > 0) void measureFolders({ environmentId, input: { projectIds: ids } });
      }
    },
    [environmentIds, measureFolders, projects],
  );

  return useMemo(
    () => ({ overviews, environments, ...projectStatisticsStatus(environments), refresh }),
    [environments, overviews, refresh],
  );
}
