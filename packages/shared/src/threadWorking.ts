import { BACKGROUND_TASK_STALE_AFTER_MS } from "./backgroundTasks.ts";

/**
 * Whether a thread is working, answered once for every surface: the web
 * sidebar, the mobile thread list, and the server's thread summaries that
 * agents read (the orchestrator's roster and related-chat listings). Each of
 * those once kept its own copy, and the server's missed background tasks and
 * scheduled work, so a side chat running two background builds read as idle to
 * the orchestrator while the sidebar showed it Working (2026-10-12).
 */

type ThreadSessionActivity = {
  readonly isSideChat?: boolean | undefined;
  readonly session?:
    | {
        readonly status: string;
        readonly activeTurnId?: string | null | undefined;
      }
    | null
    | undefined;
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

/**
 * Background work the provider is still running after its turn settled:
 * sub-agents, workflows, monitors, and backgrounded commands.
 *
 * A turn that hands its work to background tasks ends while that work goes
 * on, so reading the turn alone showed the thread as finished — reported
 * 2026-10-10 against a thread running four tasks. Work counts as live only
 * while its session survives (a stopped session has no process left to run
 * anything) and while some task has reported within the staleness window.
 */
export function liveBackgroundTasks(
  thread:
    | {
        readonly session?: { readonly status: string } | null | undefined;
        readonly backgroundTasks?:
          | {
              readonly count: number;
              readonly startedAt: string;
              readonly lastActivityAt: string;
            }
          | null
          | undefined;
      }
    | null
    | undefined,
  nowMs: number,
): { readonly count: number; readonly startedAt: string } | null {
  const tasks = thread?.backgroundTasks;
  if (tasks == null || tasks.count <= 0) return null;
  if (thread?.session?.status === "stopped") return null;
  const lastActivityMs = Date.parse(tasks.lastActivityAt);
  if (Number.isNaN(lastActivityMs) || nowMs - lastActivityMs > BACKGROUND_TASK_STALE_AFTER_MS) {
    return null;
  }
  return { count: tasks.count, startedAt: tasks.startedAt };
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

export type ThreadWorkingInput = {
  readonly isSideChat?: boolean | undefined;
  readonly session?:
    | {
        readonly status: string;
        readonly activeTurnId?: string | null | undefined;
      }
    | null
    | undefined;
  readonly latestTurn?:
    | {
        readonly startedAt?: string | null | undefined;
        readonly completedAt?: string | null | undefined;
      }
    | null
    | undefined;
  readonly pendingWork?: { readonly state: string } | null | undefined;
  readonly backgroundTasks?:
    | {
        readonly count: number;
        readonly startedAt: string;
        readonly lastActivityAt: string;
      }
    | null
    | undefined;
};

/**
 * The thread is doing work: its session is in flight, scheduler-owned work is
 * queued or running for it (a parked agent continuation, a startup resume, a
 * provider retry), background tasks its finished turn left behind are still
 * reporting, or a turn has started and not completed while the session
 * projection lags behind it. A failed, stopped, or interrupted session ends
 * that last case, so a turn left incomplete cannot read as Working forever.
 *
 * Approvals and input requests are not part of this; each surface ranks them
 * above Working itself.
 */
export function isThreadWorking(thread: ThreadWorkingInput, nowMs: number): boolean {
  if (
    isThreadSessionWorking(thread) ||
    hasPendingThreadWork(thread) ||
    liveBackgroundTasks(thread, nowMs) !== null
  ) {
    return true;
  }
  const status = thread.session?.status;
  if (status === "error" || status === "stopped" || status === "interrupted") {
    return false;
  }
  return thread.latestTurn?.startedAt != null && thread.latestTurn.completedAt == null;
}
