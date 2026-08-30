import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Durable cursor for the background stored-payload compactor.
 *
 * Oversized tool `rawOutput` written before the write-time cap (0.1.324) sits
 * in two multi-gigabyte tables — projection_thread_activities and the
 * thread.activity-appended rows of orchestration_events — and finding it
 * means streaming every payload once. The compactor walks both tables in
 * small throttled batches; this single row records how far it got so a
 * restart resumes instead of rescanning, and `completed_at` retires the sweep
 * entirely once both tables are done. A future cap change (different
 * `max_chars`) resets the cursors and re-runs.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS activity_payload_compaction_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      max_chars INTEGER NOT NULL,
      projection_rowid INTEGER NOT NULL DEFAULT 0,
      events_sequence INTEGER NOT NULL DEFAULT 0,
      rows_trimmed INTEGER NOT NULL DEFAULT 0,
      bytes_saved INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT
    )
  `;
});
