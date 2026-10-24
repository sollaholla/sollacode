/**
 * A running background task that has not reported in this long no longer
 * counts as running. A task only leaves `running` when a `task.completed`
 * arrives, and a runtime that dies mid-turn never sends one, so without this
 * killed work claims to be running forever.
 *
 * Thirty minutes because background commands emit no progress events at all:
 * for those, time since start is the only liveness signal there is, and a long
 * build or render legitimately says nothing for twenty. Erring long means a
 * dead task lingers a while; erring short would label real work as suspect.
 *
 * Shared by the server's thread summary and every client, so the task panel,
 * the sidebar, and the transcript agree on what is still running.
 */
export const BACKGROUND_TASK_STALE_AFTER_MS = 30 * 60 * 1000;

/**
 * Task types that are not the agent's work in flight: plan refreshes are
 * server-side jobs that run outside the turn stream, and nothing waits on them.
 */
export const NON_WORK_TASK_TYPES: ReadonlyArray<string> = ["plan", "plan-refresh"];
