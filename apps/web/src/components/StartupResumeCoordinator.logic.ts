import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { CommandId, MessageId, type ThreadId, type TurnId } from "@t3tools/contracts";

const DESKTOP_PROTOCOLS = new Set(["sollacode:", "sollacode-dev:"]);

/**
 * Every client looking at the same incomplete turn must submit the same IDs.
 * The environment server serializes commands and keeps durable command
 * receipts, so the first startup resume wins and every raced desktop/remote
 * client receives that same receipt instead of creating another user message.
 */
export function startupAutoResumeIds(input: {
  readonly threadId: ThreadId;
  readonly incompleteTurnId: TurnId;
}): { readonly commandId: CommandId; readonly messageId: MessageId } {
  const attemptKey = `${input.threadId}:${input.incompleteTurnId}`;
  return {
    commandId: CommandId.make(`startup-auto-resume-command:${attemptKey}`),
    messageId: MessageId.make(`startup-auto-resume-message:${attemptKey}`),
  };
}

export function isStartupAutoResumeRequested(urlValue: string): boolean {
  try {
    const url = new URL(urlValue);
    return DESKTOP_PROTOCOLS.has(url.protocol) && url.searchParams.get("solla_auto_resume") === "1";
  } catch {
    return false;
  }
}

/**
 * Desktop `--auto-resume` always dispatches. The settings toggle used to only
 * open a picker; threads that were mid-turn at last shutdown now resume
 * automatically when that toggle is on.
 */
export function shouldAutomaticallyResumeOnStartup(input: {
  readonly showOnStartup: boolean;
  readonly autoResumeRequested: boolean;
}): boolean {
  return input.showOnStartup || input.autoResumeRequested;
}

/**
 * Startup resume is intentionally conservative. Only turns explicitly
 * persisted as incomplete are offered; interrupted, errored, or still-running
 * work must not be restarted behind the user's back. Cross-client timestamps
 * are deliberately absent here: the server revalidates supersession from the
 * durable event sequence before native dispatch, while this client-side pass
 * only filters the shell state it can authoritatively observe.
 */
export function isStartupResumableThread(
  thread: Pick<
    EnvironmentThreadShell,
    | "archivedAt"
    | "settledOverride"
    | "latestTurn"
    | "session"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingWork"
  >,
): boolean {
  if (
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    (thread.pendingWork !== null && thread.pendingWork !== undefined)
  ) {
    return false;
  }
  if (thread.latestTurn?.state !== "incomplete") {
    return false;
  }
  const session = thread.session;
  if (!session || session.activeTurnId !== null) {
    return false;
  }
  return session.status === "idle" || session.status === "ready" || session.status === "stopped";
}

export function deriveStartupResumableThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<EnvironmentThreadShell> {
  return threads
    .filter(isStartupResumableThread)
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/**
 * The local pending marker bridges command acceptance to a visible provider
 * session. A newly projected pending turn is normalized to `running` before
 * the provider session reaches `starting`, so clearing on turn state alone
 * creates the exact blank interval this marker is meant to cover.
 */
export function shouldClearStartupResumePending(
  thread: Pick<EnvironmentThreadShell, "latestTurn" | "session">,
): boolean {
  const sessionStatus = thread.session?.status;
  if (sessionStatus === "starting" || sessionStatus === "running" || sessionStatus === "error") {
    return true;
  }
  const turnState = thread.latestTurn?.state;
  return turnState !== "incomplete" && turnState !== "running";
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

/**
 * How long "Auto-resuming thread…" may be claimed before it counts as stalled.
 *
 * Generous on purpose: a real resume has to spawn a CLI (~10s) and wait for it
 * to accept the turn, and calling a slow-but-working resume dead would be a
 * worse lie than the one this fixes.
 */
export const STARTUP_AUTO_RESUME_STALL_MS = 90_000;

/**
 * Has a pending startup resume stopped being plausible?
 *
 * The pending flag is set when the resume is dispatched and cleared when a
 * turn appears. Nothing clears it if the dispatch is swallowed — the projector
 * declines to enqueue work when any row for that key exists, including a
 * terminal one — so the spinner ran forever on a thread with no CLI behind it.
 * Observed 2026-08-05: "Auto-resuming thread…" held for minutes on a thread
 * whose session was `stopped` and whose resume obligation was `cancelled`.
 */
export function isStartupAutoResumeStalled(input: {
  readonly startedAt: string;
  readonly nowMs: number;
}): boolean {
  const startedMs = Date.parse(input.startedAt);
  // An unparseable stamp is not evidence of a stall; keep showing progress and
  // let the turn itself clear the flag.
  if (Number.isNaN(startedMs)) return false;
  return input.nowMs - startedMs > STARTUP_AUTO_RESUME_STALL_MS;
}
