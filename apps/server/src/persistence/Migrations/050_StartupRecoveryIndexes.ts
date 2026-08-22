import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Startup recovery only needs the rows left in-flight by the previous
  // process. Partial indexes keep that hot set tiny instead of scanning every
  // historical message and turn on each launch.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_streaming
    ON projection_thread_messages(message_id)
    WHERE is_streaming = 1
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turns_running
    ON projection_turns(row_id)
    WHERE state = 'running'
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turns_pending_start
    ON projection_turns(row_id)
    WHERE turn_id IS NULL
      AND state = 'pending'
      AND pending_message_id IS NOT NULL
  `;
});
