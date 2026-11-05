import { ORCHESTRATION_WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createOrchestrationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    turnDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:turn-diff",
      tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
    }),
    fullThreadDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:full-thread-diff",
      tag: ORCHESTRATION_WS_METHODS.getFullThreadDiff,
    }),
    threadSearch: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:thread-search",
      tag: ORCHESTRATION_WS_METHODS.searchThreads,
      staleTimeMs: 30_000,
      idleTtlMs: 60_000,
    }),
    projectStatistics: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:project-statistics",
      tag: ORCHESTRATION_WS_METHODS.getProjectStatistics,
    }),
    /** Each project folder's size on disk, sent again as measurements start and end. */
    projectFolders: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:orchestration:project-folders",
      tag: ORCHESTRATION_WS_METHODS.subscribeProjectFolders,
    }),
    measureProjectFolders: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:orchestration:measure-project-folders",
      tag: ORCHESTRATION_WS_METHODS.measureProjectFolders,
    }),
    archivedShellSnapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:archived-shell-snapshot",
      tag: ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
    }),
    deleteArchivedThreads: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:orchestration:delete-archived-threads",
      tag: ORCHESTRATION_WS_METHODS.deleteArchivedThreads,
    }),
    resumePausedThreads: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:orchestration:resume-paused-threads",
      tag: ORCHESTRATION_WS_METHODS.resumePausedThreads,
    }),
    stopResumingThreads: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:orchestration:stop-resuming-threads",
      tag: ORCHESTRATION_WS_METHODS.stopResumingThreads,
    }),
  };
}
