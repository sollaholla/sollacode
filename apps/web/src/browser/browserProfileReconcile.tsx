"use client";

import { isAgentsProjectId, type EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";
import { create } from "zustand";

import { previewBridge } from "~/components/preview/previewBridge";
import { isDesktopOwnedConnectionTarget } from "~/connection/desktopLocal";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { orchestrationEnvironment } from "~/state/orchestration";

import { buildBrowserProfileInventory } from "./browserProfileInventory";

const useReadyStore = create<{
  readonly ready: ReadonlySet<string>;
  readonly markReady: (environmentId: string) => void;
}>((set) => ({
  ready: new Set(),
  markReady: (environmentId) =>
    set((state) =>
      state.ready.has(environmentId) ? state : { ready: new Set([...state.ready, environmentId]) },
    ),
}));

/** Environments whose browser guests may attach: their old folders have been folded. */
export function useBrowserProfilesReady(): ReadonlySet<string> {
  return useReadyStore((state) => state.ready);
}

/**
 * Tells the desktop what exists in one environment. The first report folds the
 * environment's old per-thread folders, and later ones let it retire the profile
 * of a project or agent that has gone. Archived threads count: an archived agent
 * can come back, and its logins should still be there.
 */
function EnvironmentProfileReconciler(props: {
  readonly environmentId: EnvironmentId;
  readonly hostedEnvironmentIds: ReadonlyArray<EnvironmentId>;
}) {
  const { environmentId, hostedEnvironmentIds } = props;
  const threadShells = useThreadShells();
  const projects = useProjects();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const archivedAtom = useMemo(
    () => orchestrationEnvironment.archivedShellSnapshot({ environmentId, input: {} }),
    [environmentId],
  );
  const archived = useEnvironmentQuery(archivedAtom);
  const archivedThreads = archived.data?.threads;
  const archivedFailed = archived.error !== null;
  const markReady = useReadyStore((state) => state.markReady);

  const inventory = useMemo(() => {
    if (!bootstrapped || (archivedThreads === undefined && !archivedFailed)) return null;
    return buildBrowserProfileInventory({
      environmentId,
      hostedEnvironmentIds,
      projectIds: projects
        .filter((project) => project.environmentId === environmentId)
        .map((project) => project.id),
      threads: [
        ...threadShells.filter((shell) => shell.environmentId === environmentId),
        ...(archivedThreads ?? []),
      ],
      isAgentsProject: isAgentsProjectId,
      // Without the archived list, a live project or agent could look deleted.
      complete: !archivedFailed,
    });
  }, [
    archivedFailed,
    archivedThreads,
    bootstrapped,
    environmentId,
    hostedEnvironmentIds,
    projects,
    threadShells,
  ]);
  // Thread lists change constantly; only the set of owners matters after the fold.
  const ownersKey = inventory
    ? JSON.stringify([
        inventory.projects.map((project) => project.projectId),
        inventory.agentRootThreadIds,
      ])
    : null;

  useEffect(() => {
    if (ownersKey === null || inventory === null) {
      // The archived list could not be read: guests still have to attach, and
      // an unfolded project just starts signed out until the next launch.
      if (bootstrapped && archivedFailed) markReady(environmentId);
      return;
    }
    const bridge = previewBridge;
    if (!bridge) {
      markReady(environmentId);
      return;
    }
    let cancelled = false;
    void bridge
      .reconcileBrowserProfiles(inventory)
      .catch((error: unknown) => {
        console.error("Could not reconcile browser profiles.", error);
      })
      .finally(() => {
        if (!cancelled) markReady(environmentId);
      });
    return () => {
      cancelled = true;
    };
    // `inventory` is read for its value at the moment the owners last changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [archivedFailed, bootstrapped, environmentId, markReady, ownersKey]);

  return null;
}

export function BrowserProfileReconcilers() {
  const { environments } = useEnvironments();
  const hosted = useMemo(
    () =>
      environments
        .filter((environment) => isDesktopOwnedConnectionTarget(environment.entry.target))
        .map((environment) => environment.environmentId),
    [environments],
  );
  return (
    <>
      {hosted.map((environmentId) => (
        <EnvironmentProfileReconciler
          key={environmentId}
          environmentId={environmentId}
          hostedEnvironmentIds={hosted}
        />
      ))}
    </>
  );
}
