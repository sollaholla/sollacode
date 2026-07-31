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
