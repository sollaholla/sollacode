import type { EnvironmentId, PreviewBrowserProfileInventory, ThreadId } from "@t3tools/contracts";

/**
 * What exists in an environment, for the desktop's browser profile bookkeeping.
 * A thread with an owner is left to that owner: a thread an agent opened in a
 * project holds nothing that project should inherit. Returns null when the list
 * is known to be partial, so nothing is treated as deleted because of a failed read.
 */
export function buildBrowserProfileInventory(input: {
  readonly environmentId: EnvironmentId;
  readonly hostedEnvironmentIds: ReadonlyArray<EnvironmentId>;
  /** Every project, because one with no threads yet still owns its profile. */
  readonly projectIds: ReadonlyArray<string>;
  readonly threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly projectId: string;
    readonly browserProfileThreadId?: ThreadId | null | undefined;
  }>;
  readonly isAgentsProject: (projectId: string) => boolean;
  readonly complete: boolean;
}): PreviewBrowserProfileInventory | null {
  if (!input.complete) return null;
  const projectOf = new Map(input.threads.map((thread) => [thread.id, thread.projectId]));
  const threadsByProject = new Map<string, Array<ThreadId>>(
    input.projectIds
      .filter((projectId) => !input.isAgentsProject(projectId))
      .map((projectId) => [projectId, []]),
  );
  const agentRoots = new Set<ThreadId>();
  for (const thread of input.threads) {
    const root = thread.browserProfileThreadId ?? thread.id;
    const rootProject = projectOf.get(root) ?? thread.projectId;
    if (input.isAgentsProject(rootProject)) {
      agentRoots.add(root);
      continue;
    }
    const threads = threadsByProject.get(thread.projectId) ?? [];
    threads.push(thread.id);
    // A side chat can have opened tabs under its parent's folder.
    if (root !== thread.id) threads.push(root);
    threadsByProject.set(thread.projectId, threads);
  }
  return {
    environmentId: input.environmentId,
    hostedEnvironmentIds: input.hostedEnvironmentIds,
    projects: [...threadsByProject.entries()].map(([projectId, threadIds]) => ({
      projectId,
      threadIds: [...new Set(threadIds)],
    })),
    agentRootThreadIds: [...agentRoots],
  };
}
