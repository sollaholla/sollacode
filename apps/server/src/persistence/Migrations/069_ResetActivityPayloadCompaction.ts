import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Re-arm the stored-payload compactor after the trim learned MCP results.
 *
 * The 0.1.324 sweep completed having reclaimed only 52 MB: it capped
 * `data.rawOutput`, but the multi-megabyte rows turned out to carry their
 * bytes in `data.item.result` — Preview MCP call results stored verbatim
 * (measured: single rows up to 5 MB, ~3 GB total across the projection, with
 * the same payloads again in the event store). The trim now covers that
 * subtree; resetting the cursor row makes the already-finished sweep run once
 * more with the stronger trim. The compactor tolerates a missing row, so the
 * update is safely a no-op on fresh databases.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE activity_payload_compaction_state
    SET
      projection_rowid = 0,
      events_sequence = 0,
      rows_trimmed = 0,
      bytes_saved = 0,
      completed_at = NULL
    WHERE id = 1
  `;
});
