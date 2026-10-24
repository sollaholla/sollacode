import { ORCHESTRATION_WS_METHODS, type OrchestrationLiveBeat } from "@t3tools/contracts";
import { applyLiveFeedEvent, LIVE_FEED_WINDOW } from "@t3tools/shared/liveFeed";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

const NO_BEATS: ReadonlyArray<OrchestrationLiveBeat> = [];

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
    /**
     * The Live Inspector's beats, oldest first: the recent ones, then each new
     * or changed one folded in. Dropped soon after the inspector closes, and a
     * later viewer starts again from the server's snapshot.
     */
    liveFeed: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:orchestration:live-feed",
      tag: ORCHESTRATION_WS_METHODS.subscribeLiveFeed,
      idleTtlMs: 30_000,
      transform: (stream) =>
        stream.pipe(
          Stream.scan(NO_BEATS, (beats, event) =>
            applyLiveFeedEvent(beats, event, LIVE_FEED_WINDOW),
          ),
        ),
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
  };
}
