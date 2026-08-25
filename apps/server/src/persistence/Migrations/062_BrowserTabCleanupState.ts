import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Durable tab-set baseline used to dedupe post-turn cleanup reminders. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS browser_tab_cleanup_state (
      thread_id TEXT PRIMARY KEY,
      tab_set_json TEXT NOT NULL,
      last_processed_turn_id TEXT,
      last_processed_start_sequence INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      CHECK (
        (last_processed_turn_id IS NULL AND last_processed_start_sequence = 0)
        OR
        (last_processed_turn_id IS NOT NULL AND last_processed_start_sequence > 0)
      ),
      FOREIGN KEY (thread_id) REFERENCES projection_threads(thread_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS browser_tab_cleanup_turn_receipts (
      start_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      processed_at TEXT,
      UNIQUE (thread_id, turn_id),
      FOREIGN KEY (thread_id) REFERENCES projection_threads(thread_id) ON DELETE CASCADE
    )
  `;
});
