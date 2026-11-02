import { isAgentsProjectId, type PreviewAccountOwner, type ThreadId } from "@t3tools/contracts";

/**
 * Which thread can show a sign-in page for a profile, so its tab uses the right
 * cookies. An agent's owner id is its main thread; a project's is any thread in
 * it, preferring the one on screen and then the most recently touched.
 */
export function threadForAccountOwner(input: {
  readonly owner: PreviewAccountOwner;
  readonly activeThreadId: ThreadId | null;
  readonly threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly environmentId: string;
    readonly projectId: string;
    readonly updatedAt?: string | undefined;
    readonly browserProfileThreadId?: ThreadId | null | undefined;
  }>;
}): ThreadId | null {
  const { owner, threads } = input;
  if (owner.kind === "agent") {
    return (
      threads.find(
        (thread) => thread.environmentId === owner.environmentId && thread.id === owner.ownerId,
      )?.id ?? null
    );
  }
  const candidates = threads.filter(
    (thread) =>
      thread.environmentId === owner.environmentId &&
      thread.projectId === owner.ownerId &&
      !isAgentsProjectId(thread.projectId) &&
      // A thread an agent opened here browses as the agent, not as the project.
      !thread.browserProfileThreadId,
  );
  const active = candidates.find((thread) => thread.id === input.activeThreadId);
  if (active) return active.id;
  return (
    candidates.toSorted((left, right) =>
      (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""),
    )[0]?.id ?? null
  );
}
