import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

/**
 * Startup resume is intentionally conservative. Only turns explicitly
 * persisted as incomplete are offered; interrupted, errored, or still-running
 * work must not be restarted behind the user's back.
 */
export function isStartupResumableThread(
  thread: Pick<EnvironmentThreadShell, "latestTurn" | "session">,
): boolean {
  if (thread.latestTurn?.state !== "incomplete") {
    return false;
  }
  const session = thread.session;
  if (!session || session.activeTurnId !== null) {
    return false;
  }
  return (
    session.status === "idle" ||
    session.status === "ready" ||
    session.status === "stopped" ||
    session.status === "interrupted"
  );
}

export function deriveStartupResumableThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<EnvironmentThreadShell> {
  return threads
    .filter(isStartupResumableThread)
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/**
 * The candidate list is recomputed from live thread shells, so it can drain
 * while the dialog sits open — another window resumes the work, the environment
 * disconnects, or the thread leaves the store. Nothing left to resume means the
 * prompt is asking about nothing and should close itself.
 *
 * Deliberately false while busy: `resumeSelected` empties the candidate list as
 * its own resumes land, and closing there would race its completion path.
 */
export function shouldAutoCloseStartupResume(input: {
  readonly open: boolean;
  readonly busy: boolean;
  readonly candidateCount: number;
}): boolean {
  return input.open && !input.busy && input.candidateCount === 0;
}

/**
 * Selection is seeded once when the dialog opens, so keys can outlive the
 * candidates they referred to. Left unpruned they inflate the footer count and
 * leave the Resume button enabled over rows that no longer exist.
 */
export function pruneStartupResumeSelection(
  selectedKeys: ReadonlySet<string>,
  candidateKeys: ReadonlyArray<string>,
): ReadonlySet<string> {
  const available = new Set(candidateKeys);
  const pruned = new Set<string>();
  for (const key of selectedKeys) {
    if (available.has(key)) pruned.add(key);
  }
  return pruned;
}
