import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { refreshProjectionThreadPendingWork } from "../PendingWorkProjection.ts";

/**
 * Denormalizes each thread's most relevant active work obligation onto
 * projection_threads so shell snapshots and refetches can expose pending
 * server-side work (agent continuations, startup resumes, retries) to clients
 * without joining thread_work_obligations per read.
 *
 * The backfill seeds the columns for threads that already have active
 * obligations at upgrade time; afterwards the obligation repository and the
 * projection pipeline keep them fresh on every transition.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  const missing = (name: string) => !columns.some((column) => column.name === name);
  if (missing("pending_work_kind")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN pending_work_kind TEXT
    `;
  }
  if (missing("pending_work_state")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN pending_work_state TEXT
    `;
  }
  if (missing("pending_work_since")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN pending_work_since TEXT
    `;
  }

  const threadsWithActiveWork = yield* sql<{ readonly threadId: string }>`
    SELECT DISTINCT thread_id AS "threadId"
    FROM thread_work_obligations
    WHERE state NOT IN ('completed', 'cancelled')
  `;
  for (const { threadId } of threadsWithActiveWork) {
    yield* refreshProjectionThreadPendingWork(sql, threadId);
  }
});
