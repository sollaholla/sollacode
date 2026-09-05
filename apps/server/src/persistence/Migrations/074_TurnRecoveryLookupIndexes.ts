import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Recovery admission must find a delivered message without parsing every tool
 * event in the thread. A retained 0.1.429 trace measured that scan at 46 seconds
 * on the synchronous SQLite connection, delaying unrelated requests behind it.
 * The partial index keeps only delivery receipts; tool payloads stay out of it.
 * The message index also bounds completion checks to the turn being retired.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orch_events_message_delivery
    ON orchestration_events(
      stream_id,
      json_extract(payload_json, '$.activity.payload.messageId'),
      json_extract(payload_json, '$.activity.turnId'),
      sequence
    )
    WHERE aggregate_kind = 'thread'
      AND event_type = 'thread.activity-appended'
      AND json_extract(payload_json, '$.activity.kind') = 'message.delivered'
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_turn_output
    ON projection_thread_messages(thread_id, turn_id, role, is_streaming)
  `;
});
