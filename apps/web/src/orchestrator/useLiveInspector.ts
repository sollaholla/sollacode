import { useAtomValue } from "@effect/atom-react";
import { effectiveSettled, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import {
  makeArchivedThreadsEnvironmentKey,
  parseArchivedThreadsEnvironmentKey,
} from "@t3tools/client-runtime/state/threads";
import type { OrchestrationLiveBeat } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useMemo, useState } from "react";

import { useNowMinute } from "../hooks/useNowMinute";
import { useClientSettings } from "../hooks/useSettings";
import { useProjects, useThreadShells } from "../state/entities";
import { orchestrationEnvironment } from "../state/orchestration";
import { environmentServerConfigsAtom } from "../state/server";
import { buildWorld, threadSnapshotKey, type ProjectLookupEntry } from "./events";
import {
  buildStage,
  countWorld,
  mergeEnvironmentBeats,
  subtitleFor,
  type StageSection,
  type InspectorBeat,
  type InspectorCounts,
  type Subtitle,
} from "./liveInspector";
import { useOrchestratorThread, type OrchestratorThreadTarget } from "./useOrchestratorThread";

const NO_BEATS: ReadonlyArray<OrchestrationLiveBeat> = [];
/** Lines in the timeline; older beats stay on their cards. */
const TIMELINE_LIMIT = 60;
/** How often "a few minutes ago" is re-read: cards leave the stage and subtitles fade on it. */
const CLOCK_TICK_MS = 15_000;

/** Every environment's feed, read through one atom so the hook count never varies. */
const environmentsLiveFeedAtom = Atom.family((environmentKey: string) =>
  Atom.make((get) =>
    parseArchivedThreadsEnvironmentKey(environmentKey).map((environmentId) => {
      const result = get(orchestrationEnvironment.liveFeed({ environmentId, input: {} }));
      return {
        environmentId,
        beats: Option.getOrNull(AsyncResult.value(result)) ?? NO_BEATS,
        ready: AsyncResult.isSuccess(result),
      };
    }),
  ).pipe(Atom.withLabel(`web:live-feed:${environmentKey}`)),
);

function useClock(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export interface ThreadLabel {
  readonly title: string;
  readonly projectId: string;
  readonly projectName: string;
}

export interface LiveInspectorView {
  /** The threads on stage, grouped by project, the most urgent project first. */
  readonly sections: ReadonlyArray<StageSection>;
  readonly offStage: number;
  readonly counts: InspectorCounts;
  /** Newest first. */
  readonly timeline: ReadonlyArray<InspectorBeat>;
  readonly labels: ReadonlyMap<string, ThreadLabel>;
  readonly subtitle: Subtitle | null;
  readonly orchestrator: OrchestratorThreadTarget | null;
  readonly orchestratorThreadKey: string | null;
  readonly orchestratorWorking: boolean;
  /** The clock the view was computed at, for elapsed times. */
  readonly now: number;
  /** No environment has sent its first snapshot yet. */
  readonly connecting: boolean;
}

/** Everything the Live Inspector draws, from the shells already loaded and the live feed. */
export function useLiveInspector(): LiveInspectorView {
  const shells = useThreadShells();
  const projects = useProjects();
  const orchestrator = useOrchestratorThread();
  const environmentKey = useMemo(
    () =>
      makeArchivedThreadsEnvironmentKey([...new Set(shells.map((shell) => shell.environmentId))]),
    [shells],
  );
  const feeds = useAtomValue(environmentsLiveFeedAtom(environmentKey));
  const now = useClock(CLOCK_TICK_MS);

  const beats = useMemo(() => mergeEnvironmentBeats(feeds), [feeds]);
  const projectLookup = useMemo(() => {
    const lookup = new Map<string, ProjectLookupEntry>();
    for (const project of projects) {
      lookup.set(`${project.environmentId}:${project.id}`, {
        title: project.title,
        workspaceRoot: project.workspaceRoot,
      });
    }
    return lookup;
  }, [projects]);
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const autoSettleAfterDays = useClientSettings((settings) => settings.sidebarAutoSettleAfterDays);
  const nowMinute = useNowMinute();
  // The stage holds what the sidebar lists as active. A settled or snoozed
  // thread was set aside by the person, even one still holding a plan.
  const openShells = useMemo(() => {
    const now = `${nowMinute}:00.000Z`;
    return shells.filter((shell) => {
      const capabilities = serverConfigs.get(shell.environmentId)?.environment.capabilities;
      if (capabilities?.threadSnooze === true && effectiveSnoozed(shell, { now })) return false;
      return !(
        capabilities?.threadSettlement === true &&
        effectiveSettled(shell, { now, autoSettleAfterDays })
      );
    });
  }, [autoSettleAfterDays, nowMinute, serverConfigs, shells]);
  // Every thread, so a move made just before its thread was settled keeps its name.
  const world = useMemo(
    () => buildWorld(shells, undefined, projectLookup),
    [projectLookup, shells],
  );
  const openWorld = useMemo(
    () => buildWorld(openShells, undefined, projectLookup),
    [openShells, projectLookup],
  );
  // When each working thread's current turn started, for "Working · 12m".
  const workingSince = useMemo(() => {
    const since = new Map<string, string>();
    for (const shell of shells) {
      const startedAt = shell.latestTurn?.startedAt;
      if (shell.latestTurn?.state === "running" && startedAt) {
        since.set(threadSnapshotKey(shell), startedAt);
      }
    }
    return since;
  }, [shells]);
  const { sections, offStage } = useMemo(
    () => buildStage(openWorld, beats, now, workingSince),
    [beats, now, openWorld, workingSince],
  );
  const counts = useMemo(() => countWorld(openWorld), [openWorld]);
  const orchestratorThreadKey =
    orchestrator === null ? null : threadSnapshotKey(orchestrator.shell);

  const labels = useMemo(() => {
    const map = new Map<string, ThreadLabel>();
    for (const snapshot of world.values()) {
      map.set(snapshot.threadKey, {
        title: snapshot.title,
        projectId: snapshot.projectId,
        projectName: snapshot.projectName || snapshot.workspaceName,
      });
    }
    if (orchestrator !== null && orchestratorThreadKey !== null) {
      map.set(orchestratorThreadKey, {
        title: "Orchestrator",
        projectId: orchestrator.shell.projectId,
        projectName: "Orchestrator",
      });
    }
    return map;
  }, [orchestrator, orchestratorThreadKey, world]);

  const timeline = useMemo(() => beats.slice(-TIMELINE_LIMIT).toReversed(), [beats]);
  const subtitle = useMemo(
    () => subtitleFor(beats, orchestratorThreadKey, now),
    [beats, now, orchestratorThreadKey],
  );
  const orchestratorStatus = orchestrator?.shell.session?.status;
  const orchestratorWorking =
    orchestratorStatus === "running" ||
    orchestratorStatus === "starting" ||
    (orchestratorStatus === undefined && orchestrator?.shell.latestTurn?.state === "running");

  return {
    sections,
    offStage,
    counts,
    timeline,
    labels,
    subtitle,
    orchestrator,
    orchestratorThreadKey,
    orchestratorWorking,
    now,
    connecting: feeds.length > 0 && feeds.every((feed) => !feed.ready),
  };
}
