import type { OrchestrationThreadShell, ThreadId } from "@t3tools/contracts";

import type { RelatedChatSummary, ThreadRelationship } from "./types.ts";

const parentThreadId = (thread: OrchestrationThreadShell): ThreadId | null =>
  thread.isSideChat === true ? (thread.sideChatParentThreadId ?? null) : null;

const directRelationship = (
  caller: OrchestrationThreadShell,
  target: OrchestrationThreadShell,
): ThreadRelationship => {
  if (caller.id === target.id) return "self";
  const callerParent = parentThreadId(caller);
  const targetParent = parentThreadId(target);
  if (callerParent === target.id) return "parent";
  if (targetParent === caller.id) return "child";
  if (callerParent !== null && callerParent === targetParent) return "sibling";
  return "related";
};

export const relatedChatSummary = (
  caller: OrchestrationThreadShell,
  target: OrchestrationThreadShell,
): RelatedChatSummary => ({
  threadId: target.id,
  title: target.title,
  relationship: directRelationship(caller, target),
  isSideChat: target.isSideChat === true,
  parentThreadId: parentThreadId(target),
  modelSelection: target.modelSelection,
  runtimeMode: target.runtimeMode,
  interactionMode: target.interactionMode,
  sessionStatus: target.session?.status ?? null,
  activeTurnId: target.session?.activeTurnId ?? null,
  latestTurnState: target.latestTurn?.state ?? null,
  isWorking:
    target.session?.status === "starting" ||
    target.session?.status === "running" ||
    target.latestTurn?.state === "running",
  updatedAt: target.updatedAt,
});

/**
 * Resolve the connected side-chat family for one credential-bound caller.
 *
 * Only active `isSideChat` parent edges count. Promotion deliberately clears
 * that edge, so a promoted thread is immediately disconnected from the
 * former family and can no longer be queried through an old credential.
 */
export const resolveRelatedChats = (
  threads: ReadonlyArray<OrchestrationThreadShell>,
  callerThreadId: ThreadId,
):
  | {
      readonly caller: OrchestrationThreadShell;
      readonly related: ReadonlyArray<OrchestrationThreadShell>;
    }
  | undefined => {
  const byId = new Map(threads.map((thread) => [thread.id, thread] as const));
  const caller = byId.get(callerThreadId);
  if (!caller) return undefined;

  const neighbors = new Map<ThreadId, Set<ThreadId>>();
  const connect = (left: ThreadId, right: ThreadId) => {
    const leftSet = neighbors.get(left) ?? new Set<ThreadId>();
    leftSet.add(right);
    neighbors.set(left, leftSet);
    const rightSet = neighbors.get(right) ?? new Set<ThreadId>();
    rightSet.add(left);
    neighbors.set(right, rightSet);
  };
  for (const thread of threads) {
    const parent = parentThreadId(thread);
    if (parent !== null && byId.has(parent)) connect(thread.id, parent);
  }

  const visited = new Set<ThreadId>([caller.id]);
  const queue: Array<ThreadId> = [caller.id];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const neighbor of neighbors.get(current) ?? []) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      queue.push(neighbor);
    }
  }

  const relationshipOrder: Record<ThreadRelationship, number> = {
    self: 0,
    parent: 1,
    child: 2,
    sibling: 3,
    related: 4,
  };
  const related = Array.from(visited, (threadId) => byId.get(threadId)!).sort((left, right) => {
    const relationDifference =
      relationshipOrder[directRelationship(caller, left)] -
      relationshipOrder[directRelationship(caller, right)];
    if (relationDifference !== 0) return relationDifference;
    return right.updatedAt.localeCompare(left.updatedAt);
  });

  return { caller, related };
};

export const findAuthorizedRelatedChat = (
  threads: ReadonlyArray<OrchestrationThreadShell>,
  callerThreadId: ThreadId,
  targetThreadId: ThreadId,
):
  | {
      readonly caller: OrchestrationThreadShell;
      readonly target: OrchestrationThreadShell;
    }
  | undefined => {
  const family = resolveRelatedChats(threads, callerThreadId);
  if (!family) return undefined;
  const target = family.related.find((thread) => thread.id === targetThreadId);
  return target ? { caller: family.caller, target } : undefined;
};
