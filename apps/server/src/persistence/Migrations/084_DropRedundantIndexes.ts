import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Drops five indexes that no query reads. Every index costs disk and a B-tree
 * write on each insert. Measured 2026-10-24 on a 20 GB live database (9.4 GB
 * of live pages, 1.52M events), these five held 561 MB (6.0% of live content)
 * and 5.8% of the bytes each new event adds.
 *
 * - `idx_orch_events_command_id` and `idx_orch_events_correlation_id` (250 MB
 *   each). No query filters, joins, or sorts events by either column; command
 *   dedupe reads `orchestration_command_receipts` by its primary key. Both
 *   values are ~100-character ids and equal on every event, so each event
 *   wrote the same long key into two indexes.
 * - `idx_orch_command_receipts_sequence` (26 MB). Nothing reads receipts by
 *   `result_sequence`.
 * - `idx_projection_thread_activities_thread_sequence` (32 MB) is a prefix of
 *   `idx_projection_thread_activities_thread_sequence_created_id` (migration
 *   029), so the planner answers the same lookups and orderings from that one.
 * - `idx_projection_thread_messages_thread_created` (2 MB) is a prefix of
 *   `idx_projection_thread_messages_thread_created_id` the same way.
 *
 * No row is touched. A drop reads each index page once and moves it to
 * SQLite's freelist, writing only freelist trunk pages: two 200 MB indexes
 * dropped in 0.2 s with a 0.4 MB WAL on a warm copy. On the live file those
 * pages are scattered, and reading the two 250 MB indexes cold took ~28 s, so
 * the first start after updating can be that much slower, once. Freed pages
 * are reused by later writes; the file does not shrink without a VACUUM.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP INDEX IF EXISTS idx_orch_events_command_id`;
  yield* sql`DROP INDEX IF EXISTS idx_orch_events_correlation_id`;
  yield* sql`DROP INDEX IF EXISTS idx_orch_command_receipts_sequence`;
  yield* sql`DROP INDEX IF EXISTS idx_projection_thread_activities_thread_sequence`;
  yield* sql`DROP INDEX IF EXISTS idx_projection_thread_messages_thread_created`;
});
