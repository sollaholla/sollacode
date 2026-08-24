import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Older single-slot writes normally prevented duplicates, but a replay or a
  // partially upgraded database can contain more than one placeholder for the
  // same immutable message. Keep the newest projection before enforcing the
  // queue's exact identity.
  yield* sql`
    DELETE FROM projection_turns
    WHERE row_id IN (
      SELECT row_id
      FROM (
        SELECT
          row_id,
          ROW_NUMBER() OVER (
            PARTITION BY thread_id, pending_message_id
            ORDER BY requested_at DESC, row_id DESC
          ) AS duplicate_rank
        FROM projection_turns
        WHERE turn_id IS NULL
          AND state = 'pending'
          AND pending_message_id IS NOT NULL
          AND checkpoint_turn_count IS NULL
      ) AS ranked
      WHERE duplicate_rank > 1
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_turns_pending_message
    ON projection_turns(thread_id, pending_message_id)
    WHERE turn_id IS NULL
      AND state = 'pending'
      AND pending_message_id IS NOT NULL
      AND checkpoint_turn_count IS NULL
  `;
});
