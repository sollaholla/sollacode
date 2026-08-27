import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Remove persisted conversation/runtime payloads after the deletion event has
 * been projected and published. The tiny thread.deleted event and its command
 * receipt remain so reconnecting clients can still observe the tombstone.
 */
export const purgeDeletedThreadPersistence = Effect.fn("purgeDeletedThreadPersistence")(function* (
  threadId: ThreadId,
) {
  const sql = yield* SqlClient.SqlClient;
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

/** Apply the same purge once to threads deleted before this behavior shipped. */
export const purgePreviouslyDeletedThreadPersistence = Effect.fn(
  "purgePreviouslyDeletedThreadPersistence",
)(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly threadId: ThreadId }>`
    SELECT thread_id AS "threadId"
    FROM projection_threads
    WHERE deleted_at IS NOT NULL
    ORDER BY thread_id
  `;
  yield* Effect.forEach(rows, (row) => purgeDeletedThreadPersistence(row.threadId), {
    concurrency: 1,
    discard: true,
  });
});
