import { RESUME_PROMPT } from "@t3tools/shared/resumePrompt";

/** Generic reasoning receipts have no transcript body; the Working row owns that status. */
export function isReasoningStatusPlaceholder(activity: {
  readonly kind: string;
  readonly summary: string;
  readonly payload?: unknown;
}): boolean {
  if (activity.kind !== "reasoning.updated") return false;
  const isPlaceholder = (value: string) => /^(?:thinking|generating)?$/i.test(value.trim());
  if (!isPlaceholder(activity.summary)) return false;
  const payload = activity.payload;
  if (typeof payload !== "object" || payload === null) return true;
  const title = "title" in payload && typeof payload.title === "string" ? payload.title : "";
  const detail = "detail" in payload && typeof payload.detail === "string" ? payload.detail : "";
  return isPlaceholder(title) && isPlaceholder(detail);
}

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

/**
 * Failures a provider reported. The thread pauses for them and says so once, in
 * the pause card, so these rows stay out of the transcript, old ones included.
 */
export function isPausedProviderFailureActivity(activity: { readonly kind: string }): boolean {
  return (
    activity.kind === "runtime.error" ||
    activity.kind === "provider.turn.start.failed" ||
    activity.kind.startsWith("provider.failover.") ||
    activity.kind.startsWith("usage-guard.")
  );
}

/** What stopped a paused thread, as far as the provider's own words can tell. */
export type ThreadPauseReason =
  | "usage-limit"
  | "out-of-credits"
  | "access-refused"
  | "model-unavailable"
  | "provider-unavailable"
  | "stopped";

const THREAD_PAUSE_PATTERNS: ReadonlyArray<readonly [ThreadPauseReason, RegExp]> = [
  [
    "out-of-credits",
    /\b402\b|payment required|billing|no credit|credit balance|balance exhausted/i,
  ],
  [
    "usage-limit",
    /usage limit|rate[- ]?limit|session limit|hit your|quota|resource_exhausted|\b429\b|too many requests/i,
  ],
  ["access-refused", /\b40[13]\b|forbidden|unauthori[sz]ed|permission denied|access denied/i],
  ["model-unavailable", /model (?:not found|is (?:no longer |not )available)|unknown model/i],
  [
    "provider-unavailable",
    /\b5\d\d\b|overloaded|unavailable|timed? ?out|econn|socket|network|upstream|stalled/i,
  ],
];

export function classifyThreadPause(lastError: string): ThreadPauseReason {
  return THREAD_PAUSE_PATTERNS.find(([, pattern]) => pattern.test(lastError))?.[0] ?? "stopped";
}

/** One short line for the pause card. `provider` is the name the person knows it by. */
export function describeThreadPause(reason: ThreadPauseReason, provider: string): string {
  switch (reason) {
    case "usage-limit":
      return `${provider} is out of usage`;
    case "out-of-credits":
      return `${provider} is out of credits`;
    case "access-refused":
      return `${provider} refused this request`;
    case "model-unavailable":
      return "This model isn't available";
    case "provider-unavailable":
      return `${provider} isn't responding`;
    case "stopped":
      return `${provider} stopped`;
  }
}

export {
  hasPendingThreadWork,
  isSideChatSessionPreparing,
  isThreadSessionWorking,
  isThreadWorking,
  liveBackgroundTasks,
} from "@t3tools/shared/threadWorking";

/**
 * The transcript's working row while the turn has settled but the tasks it
 * started are still running, so the thread does not read as finished.
 */
export function describeRunningBackgroundTasks(count: number): string {
  return count === 1 ? "1 background task running" : `${count} background tasks running`;
}

/**
 * A persisted session failure is actionable even when no turn or output
 * survived. This is what a paused thread is: every provider failure ends here,
 * and the person chooses what happens next.
 */
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
