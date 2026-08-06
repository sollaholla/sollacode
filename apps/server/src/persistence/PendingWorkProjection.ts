import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Recomputes the denormalized pending-work columns on projection_threads from
 * thread_work_obligations for one thread.
 *
 * The surfaced obligation is the one that best explains what the thread will
 * do next, so still-waiting states (pending, sleeping, blocked, waiting-*)
 * outrank claimed/executing: while a continuation loop hands off from an
 * executing obligation to the freshly queued next one, clients must see the
 * queued successor — the executing row is already represented by the running
 * turn itself. Ties break by the scheduler's kind priority, then age.
 *
 * Called from every obligation mutation in ThreadWorkObligationRepository and
 * from the projection pipeline's thread shell summary refresh; both keep the
 * columns exact without clients ever joining the obligations table.
 */
export const refreshProjectionThreadPendingWork = (sql: SqlClient.SqlClient, threadId: string) =>
  sql`
    WITH pick AS (
      SELECT kind, state, created_at
      FROM thread_work_obligations
      WHERE thread_id = ${threadId}
        AND state NOT IN ('completed', 'cancelled')
      ORDER BY
        CASE WHEN state IN ('claimed', 'executing') THEN 1 ELSE 0 END ASC,
        CASE kind
          WHEN 'active-turn-recovery' THEN 1
          WHEN 'authentication-resume' THEN 2
          WHEN 'provider-retry' THEN 2
          WHEN 'agent-continuation' THEN 3
          WHEN 'startup-resume' THEN 4
          ELSE 5
        END ASC,
        created_at ASC,
        obligation_id ASC
      LIMIT 1
    )
    UPDATE projection_threads
    SET
      pending_work_kind = (SELECT kind FROM pick),
      pending_work_state = (SELECT state FROM pick),
      pending_work_since = (SELECT created_at FROM pick)
    WHERE thread_id = ${threadId}
  `.pipe(Effect.asVoid);
