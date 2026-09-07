type ThreadSessionActivity = {
  readonly isSideChat?: boolean;
  readonly session?: {
    readonly status: string;
    readonly activeTurnId?: string | null;
  } | null;
  readonly latestTurn?: unknown;
  readonly pendingWork?: unknown;
};

/** Copying a blank side chat's history prepares a session without starting work. */
export function isSideChatSessionPreparing(
  thread: ThreadSessionActivity | null | undefined,
): boolean {
  return (
    thread?.isSideChat === true &&
    thread.session?.status === "starting" &&
    thread.session.activeTurnId == null &&
    thread.latestTurn == null &&
    thread.pendingWork == null
  );
}

export function isThreadSessionWorking(thread: ThreadSessionActivity | null | undefined): boolean {
  return (
    thread?.session?.status === "running" ||
    (thread?.session?.status === "starting" && !isSideChatSessionPreparing(thread))
  );
}

/** Unfinished scheduler-owned work stays active while its provider is cooling down. */
export function hasPendingThreadWork(
  thread:
    | { readonly pendingWork?: { readonly state: string } | null | undefined }
    | null
    | undefined,
): boolean {
  return (
    thread?.pendingWork != null &&
    ["pending", "claimed", "executing", "sleeping"].includes(thread.pendingWork.state)
  );
}
