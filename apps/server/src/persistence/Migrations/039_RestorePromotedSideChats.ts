import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * 0.1.26 could briefly re-open a side-chat surface after its delete command
 * completed. If the user then promoted that stale surface, the metadata event
 * cleared `is_side_chat` but left the projection tombstoned. Restore only the
 * rows whose event history proves they were side chats and were explicitly
 * promoted after their most recent delete.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_threads AS thread
    SET deleted_at = NULL
    WHERE thread.deleted_at IS NOT NULL
      AND thread.is_side_chat = 0
      AND EXISTS (
        SELECT 1
        FROM orchestration_events AS fork
        WHERE fork.stream_id = thread.thread_id
          AND fork.event_type = 'thread.forked'
          AND json_extract(fork.payload_json, '$.isSideChat') = 1
      )
      AND EXISTS (
        SELECT 1
        FROM orchestration_events AS promotion
        WHERE promotion.stream_id = thread.thread_id
          AND promotion.event_type = 'thread.meta-updated'
          AND json_extract(promotion.payload_json, '$.isSideChat') = 0
          AND promotion.sequence > (
            SELECT COALESCE(MAX(deletion.sequence), 0)
            FROM orchestration_events AS deletion
            WHERE deletion.stream_id = thread.thread_id
              AND deletion.event_type = 'thread.deleted'
          )
      )
  `;
});
