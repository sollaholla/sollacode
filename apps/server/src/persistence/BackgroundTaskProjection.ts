import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  BACKGROUND_TASK_STALE_AFTER_MS,
  NON_WORK_TASK_TYPES,
} from "@t3tools/shared/backgroundTasks";

/**
 * How far back a thread's task rows are read. The task panel drops anything
 * silent for a day, so nothing older can describe running work, and the bound
 * keeps the read small on threads with thousands of finished tasks.
 */
const TASK_LOOKBACK_MS = 24 * 60 * 60 * 1000;

const isoBefore = (iso: string, milliseconds: number): string | null =>
  Option.match(DateTime.make(iso), {
    onNone: () => null,
    onSome: (at) => DateTime.formatIso(DateTime.subtract(at, { milliseconds })),
  });

/**
 * One row per task the thread announced and never reported finished, read
 * from rows at or after `since`. Progress and completion replace a single
 * lifecycle row per task, so a task has at most that row and its
 * `task.started`; a start newer than the completion is the task running again.
 */
const openTaskRows = (sql: SqlClient.SqlClient, threadId: string, since: string) => sql`
  SELECT
    task_id,
    MIN(created_at) AS started_at,
    MAX(created_at) AS activity_at
  FROM (
    SELECT
      json_extract(payload_json, '$.taskId') AS task_id,
      json_extract(payload_json, '$.taskType') AS task_type,
      kind,
      created_at
    FROM projection_thread_activities
    WHERE thread_id = ${threadId}
      AND kind IN ('task.started', 'task.progress', 'task.completed')
      AND created_at >= ${since}
      AND json_valid(payload_json)
      AND json_type(payload_json, '$.taskId') = 'text'
  )
  GROUP BY task_id
  HAVING
    MAX(CASE WHEN task_type IN ${sql.in(NON_WORK_TASK_TYPES)} THEN 1 ELSE 0 END) = 0
    AND (
      MAX(CASE WHEN kind = 'task.completed' THEN created_at END) IS NULL
      OR MAX(CASE WHEN kind = 'task.started' THEN created_at END)
        > MAX(CASE WHEN kind = 'task.completed' THEN created_at END)
    )
`;

/**
 * Recomputes the background-task columns on projection_threads for one thread.
 *
 * Counts the open tasks heard from within the staleness window of the
 * thread's newest task report. Measuring from that report rather than the
 * clock keeps the projection deterministic under replay; clients apply the
 * same window to `background_tasks_activity_at` against their own clock.
 *
 * Called from the projection pipeline for every `task.*` activity and from
 * the thread shell summary refresh.
 */
export const refreshProjectionThreadBackgroundTasks = (
  sql: SqlClient.SqlClient,
  threadId: string,
) =>
  Effect.gen(function* () {
    const [newest] = yield* sql<{ readonly reportedAt: string | null }>`
      SELECT MAX(created_at) AS "reportedAt"
      FROM projection_thread_activities
      WHERE thread_id = ${threadId}
        AND kind IN ('task.started', 'task.progress', 'task.completed')
    `;
    const reportedAt = newest?.reportedAt ?? null;
    const since = reportedAt === null ? null : isoBefore(reportedAt, TASK_LOOKBACK_MS);
    const freshSince =
      reportedAt === null ? null : isoBefore(reportedAt, BACKGROUND_TASK_STALE_AFTER_MS);
    if (since === null || freshSince === null) {
      yield* sql`
        UPDATE projection_threads
        SET
          background_task_count = 0,
          background_tasks_started_at = NULL,
          background_tasks_activity_at = NULL
        WHERE thread_id = ${threadId}
      `;
      return;
    }
    yield* sql`
      UPDATE projection_threads
      SET (background_task_count, background_tasks_started_at, background_tasks_activity_at) = (
        SELECT COUNT(*), MIN(started_at), MAX(activity_at)
        FROM (${openTaskRows(sql, threadId, since)})
        WHERE activity_at >= ${freshSince}
      )
      WHERE thread_id = ${threadId}
    `;
  });

export interface OpenBackgroundTask {
  readonly threadId: string;
  readonly taskId: string;
}

/**
 * Tasks still open on threads active within the lookback window whose last
 * report came before `before`.
 *
 * Nothing a provider runs survives a server restart, so at boot these are
 * exactly the tasks the previous process left behind: their runtime is gone
 * and no completion will ever arrive for them.
 */
export const listOpenBackgroundTasksBefore = (
  sql: SqlClient.SqlClient,
  input: { readonly before: string },
) =>
  Effect.gen(function* () {
    const since = isoBefore(input.before, TASK_LOOKBACK_MS);
    if (since === null) return [];
    const threads = yield* sql<{ readonly threadId: string }>`
      SELECT thread_id AS "threadId"
      FROM projection_threads
      WHERE deleted_at IS NULL
        AND updated_at >= ${since}
      ORDER BY thread_id
    `;
    const open: Array<OpenBackgroundTask> = [];
    for (const { threadId } of threads) {
      const tasks = yield* sql<{ readonly taskId: string }>`
        SELECT task_id AS "taskId"
        FROM (${openTaskRows(sql, threadId, since)})
        WHERE activity_at < ${input.before}
        ORDER BY started_at, task_id
      `;
      for (const { taskId } of tasks) open.push({ threadId, taskId });
    }
    return open;
  });
