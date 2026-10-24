import { useParams } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";

/**
 * The environment of the thread, agent, or draft on screen, or null anywhere
 * else (home, settings). Threads and agents carry it in the route; a draft
 * finds it in the draft store.
 */
export function resolveTopBarEnvironmentId(input: {
  readonly routeEnvironmentId: string | undefined;
  readonly draftEnvironmentId: EnvironmentId | null;
}): EnvironmentId | null {
  if (input.routeEnvironmentId) return input.routeEnvironmentId as EnvironmentId;
  return input.draftEnvironmentId;
}

export function useTopBarEnvironmentId(): EnvironmentId | null {
  const params = useParams({ strict: false }) as {
    readonly environmentId?: string;
    readonly draftId?: string;
  };
  const draftEnvironmentId = useComposerDraftStore((store) =>
    params.draftId
      ? (store.getDraftSession(DraftId.make(params.draftId))?.environmentId ?? null)
      : null,
  );
  return resolveTopBarEnvironmentId({
    routeEnvironmentId: params.environmentId,
    draftEnvironmentId,
  });
}
