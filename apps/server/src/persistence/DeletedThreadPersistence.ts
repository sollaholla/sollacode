import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

/** Rows removed per statement from the tables a long conversation fills. */
export const PURGE_BATCH_ROWS = 1_000;

/**
 * Run a `DELETE … LIMIT n RETURNING` until a batch comes back short. A long
 * conversation holds hundreds of thousands of rows; deleting them in one
 * statement holds the database's only write lock for seconds and stalls every
 * other thread meanwhile.
 */
const deleteInBatches = Effect.fn("deleteInBatches")(function* (
  removeBatch: Effect.Effect<ReadonlyArray<unknown>, SqlError>,
) {
  while ((yield* removeBatch).length === PURGE_BATCH_ROWS) {
    yield* Effect.yieldNow;
  }
});

/**
 * Remove persisted conversation/runtime payloads after the deletion event has
 * been projected and published. The tiny thread.deleted event and its command
 * receipt remain so reconnecting clients can still observe the tombstone.
 *
 * The bulky tables go first, a batch at a time; the rest goes in one
 * transaction that removes the thread row last. A purge that stops partway
 * leaves the row marked deleted, which is how the next start finds and
 * finishes it.
 */
export const purgeDeletedThreadPersistence = Effect.fn("purgeDeletedThreadPersistence")(function* (
  threadId: ThreadId,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* deleteInBatches(sql`
    DELETE FROM projection_thread_activities
    WHERE rowid IN (
      SELECT rowid FROM projection_thread_activities
      WHERE thread_id = ${threadId}
      LIMIT ${PURGE_BATCH_ROWS}
    )
    RETURNING 1 AS "removed"
  `);
  yield* deleteInBatches(sql`
    DELETE FROM orchestration_events
    WHERE rowid IN (
      SELECT rowid FROM orchestration_events
      WHERE aggregate_kind = 'thread'
        AND stream_id = ${threadId}
        AND event_type <> 'thread.deleted'
      LIMIT ${PURGE_BATCH_ROWS}
    )
    RETURNING 1 AS "removed"
  `);
  yield* deleteInBatches(sql`
    DELETE FROM orchestration_command_receipts
    WHERE rowid IN (
      SELECT rowid FROM orchestration_command_receipts
      WHERE aggregate_kind = 'thread'
        AND aggregate_id = ${threadId}
        AND command_id NOT IN (
          SELECT command_id
          FROM orchestration_events
          WHERE aggregate_kind = 'thread'
            AND stream_id = ${threadId}
            AND event_type = 'thread.deleted'
            AND command_id IS NOT NULL
        )
      LIMIT ${PURGE_BATCH_ROWS}
    )
    RETURNING 1 AS "removed"
  `);
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`DELETE FROM browser_tab_cleanup_turn_receipts WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM browser_tab_cleanup_state WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM checkpoint_diff_blobs WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM preview_sessions WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM projection_pending_approvals WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM projection_thread_activities WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM projection_thread_messages WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM projection_thread_proposed_plans WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM projection_thread_sessions WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM projection_turns WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM provider_session_runtime WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM thread_work_obligations WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM projection_threads WHERE thread_id = ${threadId}`;

      // Event payloads are the durable duplicate of conversation history.
      // Keep only the deletion marker required by catch-up synchronization.
      yield* sql`
          DELETE FROM orchestration_command_receipts
          WHERE aggregate_kind = 'thread'
            AND aggregate_id = ${threadId}
            AND command_id NOT IN (
              SELECT command_id
              FROM orchestration_events
              WHERE aggregate_kind = 'thread'
                AND stream_id = ${threadId}
                AND event_type = 'thread.deleted'
                AND command_id IS NOT NULL
            )
        `;
      yield* sql`
          DELETE FROM orchestration_events
          WHERE aggregate_kind = 'thread'
            AND stream_id = ${threadId}
            AND event_type <> 'thread.deleted'
        `;
    }),
  );
});

/**
 * Threads marked deleted whose purge never finished, oldest first. The purge
 * removes the thread row last, so any row still marked deleted was cut short
 * by a restart or a failure.
 */
export const listUnfinishedThreadDeletions = Effect.fn("listUnfinishedThreadDeletions")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly threadId: ThreadId }>`
      SELECT thread_id AS "threadId"
      FROM projection_threads
      WHERE deleted_at IS NOT NULL
      ORDER BY deleted_at, thread_id
    `;
    return rows.map((row) => row.threadId);
  },
);

/** Apply the same purge once to threads deleted before this behavior shipped. */
export const purgePreviouslyDeletedThreadPersistence = Effect.fn(
  "purgePreviouslyDeletedThreadPersistence",
)(function* () {
  const threadIds = yield* listUnfinishedThreadDeletions();
  yield* Effect.forEach(threadIds, purgeDeletedThreadPersistence, {
    concurrency: 1,
    discard: true,
  });
});
