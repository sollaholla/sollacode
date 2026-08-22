import type { OrchestratorWorld, ThreadSnapshot } from "./events";

export const PENDING_THREAD_TITLE_TTL_MS = 30_000;

export interface PendingThreadTitle {
  readonly title: string;
  readonly expiresAtMs: number;
}

export type PendingThreadTitles = ReadonlyMap<string, PendingThreadTitle>;

export function rememberPendingThreadTitle(
  pending: PendingThreadTitles,
  input: { readonly threadKey: string; readonly title: string; readonly nowMs: number },
): PendingThreadTitles {
  const next = new Map(pending);
  next.set(input.threadKey, {
    title: input.title,
    expiresAtMs: input.nowMs + PENDING_THREAD_TITLE_TTL_MS,
  });
  return next;
}

/**
 * Keeps the Orchestrator's routing view current while the shell projection is
 * catching up with an accepted rename command.
 *
 * A second voice request can arrive before the server's shell broadcast. In
 * that gap the old title used to win again, so the new name the user had just
 * spoken could not be resolved. The override disappears as soon as the live
 * projection agrees, and expires rather than masking a later external rename.
 */
export function reconcilePendingThreadTitles(
  world: OrchestratorWorld,
  pending: PendingThreadTitles,
  nowMs: number,
): { readonly world: OrchestratorWorld; readonly pending: PendingThreadTitles } {
  let nextWorld: Map<string, ThreadSnapshot> | null = null;
  const nextPending = new Map<string, PendingThreadTitle>();

  for (const [threadKey, override] of pending) {
    const thread = world.get(threadKey);
    if (thread === undefined || thread.title === override.title || override.expiresAtMs <= nowMs) {
      continue;
    }
    nextWorld ??= new Map(world);
    nextWorld.set(threadKey, { ...thread, title: override.title });
    nextPending.set(threadKey, override);
  }

  return {
    world: nextWorld ?? world,
    pending: nextPending,
  };
}
