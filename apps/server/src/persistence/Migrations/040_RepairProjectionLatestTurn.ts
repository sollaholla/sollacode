import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A checkpoint event can be appended after a newer provider turn because git
 * diff capture runs asynchronously. Older builds treated that late checkpoint
 * as the thread's latest turn, which left the UI showing a stale Agent
 * auto-resume indicator even when the newer reply ended with AGENT_STOP.
 *
 * Repair each pointer from the durable turn ordering. Reverted turns have
 * already been removed from projection_turns, so this remains compatible with
 * checkpoint reverts and also clears dangling pointers on empty threads.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_threads AS thread
    SET latest_turn_id = (
      SELECT turn.turn_id
      FROM projection_turns AS turn
      WHERE turn.thread_id = thread.thread_id
        AND turn.turn_id IS NOT NULL
      ORDER BY turn.requested_at DESC, turn.row_id DESC
      LIMIT 1
    )
    WHERE thread.latest_turn_id IS NOT (
      SELECT turn.turn_id
      FROM projection_turns AS turn
      WHERE turn.thread_id = thread.thread_id
        AND turn.turn_id IS NOT NULL
      ORDER BY turn.requested_at DESC, turn.row_id DESC
      LIMIT 1
    )
  `;
});
