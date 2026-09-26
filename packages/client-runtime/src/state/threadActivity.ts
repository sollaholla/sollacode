import { RESUME_PROMPT } from "@t3tools/shared/resumePrompt";

/** A completed failover receipt answers for its exact triggering runtime error. */
/**
 * A persisted "Runtime error: Aborted" is the provider acknowledging our own
 * interrupt (OpenCode answers `session.abort` with a MessageAbortedError), not
 * a failure. 0.1.600 stopped recording new ones; rows written before it still
 * sat in threads as error cards, which read as "still getting the aborted error".
 */
export function isProviderInterruptionErrorActivity(activity: {
  readonly kind: string;
  readonly payload?: unknown;
}): boolean {
  if (activity.kind !== "runtime.error") {
    return false;
  }
  const message = (activity.payload as { readonly message?: unknown } | null | undefined)?.message;
  return typeof message === "string" && message.trim().toLowerCase() === "aborted";
}

export function recoveredRuntimeErrorIds(
  activities: ReadonlyArray<{ readonly id: string; readonly kind: string }>,
): ReadonlySet<string> {
  const recovered = new Set<string>();
  const suffix = ":provider.failover.completed";
  for (const activity of activities) {
    if (activity.kind === "provider.failover.completed" && activity.id.endsWith(suffix)) {
      recovered.add(activity.id.slice(0, -suffix.length));
    }
  }
  return recovered;
}

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

/** A persisted session failure is actionable even when no turn or output survived. */
export function canResumeFailedThreadSession(
  thread:
    | {
        readonly session?: {
          readonly status: string;
          readonly activeTurnId?: string | null;
          readonly lastError?: string | null;
        } | null;
        readonly pendingWork?: unknown;
      }
    | null
    | undefined,
): boolean {
  return (
    thread?.session != null &&
    ["error", "stopped", "interrupted"].includes(thread.session.status) &&
    thread.session.activeTurnId == null &&
    Boolean(thread.session.lastError?.trim()) &&
    thread.pendingWork == null
  );
}

export async function runResumeIncompleteTurn(input: {
  readonly inFlightRef: { current: boolean };
  readonly send: (message: typeof RESUME_PROMPT) => Promise<void>;
}): Promise<boolean> {
  if (input.inFlightRef.current) return false;
  input.inFlightRef.current = true;
  try {
    await input.send(RESUME_PROMPT);
    return true;
  } finally {
    input.inFlightRef.current = false;
  }
}

/** Older saved sessions retain this informational fallback notice in their history. */
export function isRoutineMusePollingNotice(activity: {
  readonly kind: string;
  readonly summary: string;
  readonly payload?: unknown;
}): boolean {
  if (activity.kind !== "runtime.warning") return false;
  const notice =
    "Muse live streaming is unavailable for this saved session. Activity will refresh every five seconds.";
  if (activity.summary.trim() === notice) return true;
  const payload = activity.payload;
  if (typeof payload !== "object" || payload === null) return false;
  const message =
    "message" in payload && typeof payload.message === "string"
      ? payload.message.trim()
      : activity.summary.trim();
  if (message === notice) return true;
  return (
    message === "Muse live streaming could not be reattached." &&
    "detail" in payload &&
    typeof payload.detail === "string" &&
    payload.detail.includes("unknown cursor anchor")
  );
}
