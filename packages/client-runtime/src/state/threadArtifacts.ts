import {
  WS_METHODS,
  type AssetResource,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadArtifactId,
  type ThreadArtifactSummary,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import * as Stream from "effect/Stream";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import { resubscribeVmStreamOnApplicationActive } from "./vmAgents.ts";

const ARTIFACT_QUERY_STALE_TIME_MS = 2_000;
const ARTIFACT_QUERY_IDLE_TTL_MS = 60_000;

export function threadArtifactRevisionResource(
  summary: ThreadArtifactSummary,
  path?: string,
): AssetResource {
  return path ? { ...summary.entryResource, path } : summary.entryResource;
}

export function threadArtifactIconResource(summary: ThreadArtifactSummary): AssetResource {
  return summary.iconResource;
}

export function threadArtifactDeepLink(ref: ScopedThreadRef, artifactId: ThreadArtifactId): string {
  return `/${encodeURIComponent(ref.environmentId)}/${encodeURIComponent(ref.threadId)}?artifact=${encodeURIComponent(artifactId)}`;
}

export function createThreadArtifactEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const mutationScheduler = createAtomCommandScheduler();
  return {
    list: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:thread-artifacts:list",
      tag: WS_METHODS.threadArtifactsSubscribe,
      idleTtlMs: ARTIFACT_QUERY_IDLE_TTL_MS,
      transform: (stream) =>
        resubscribeVmStreamOnApplicationActive(stream).pipe(Stream.map((item) => item.snapshot)),
    }),
    detail: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:thread-artifacts:detail",
      tag: WS_METHODS.threadArtifactsGet,
      staleTimeMs: ARTIFACT_QUERY_STALE_TIME_MS,
      idleTtlMs: ARTIFACT_QUERY_IDLE_TTL_MS,
    }),
    archive: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-artifacts:archive",
      tag: WS_METHODS.threadArtifactsArchive,
      scheduler: mutationScheduler,
    }),
    restore: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-artifacts:restore",
      tag: WS_METHODS.threadArtifactsRestore,
      scheduler: mutationScheduler,
    }),
    delete: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-artifacts:delete",
      tag: WS_METHODS.threadArtifactsDelete,
      scheduler: mutationScheduler,
    }),
  };
}

export interface ThreadArtifactSelectionTarget {
  readonly environmentId: EnvironmentId;
  readonly artifactId: ThreadArtifactId;
}

/**
 * Deletes several artifacts one after another, carrying on past a failure so
 * one stuck artifact does not keep the rest. Returns the ones that remain.
 */
export async function deleteThreadArtifacts(
  artifactIds: ReadonlyArray<ThreadArtifactId>,
  deleteOne: (artifactId: ThreadArtifactId) => Promise<boolean>,
): Promise<ReadonlyArray<ThreadArtifactId>> {
  const failed: Array<ThreadArtifactId> = [];
  for (const artifactId of artifactIds) {
    const deleted = await deleteOne(artifactId).catch(() => false);
    if (!deleted) failed.push(artifactId);
  }
  return failed;
}
