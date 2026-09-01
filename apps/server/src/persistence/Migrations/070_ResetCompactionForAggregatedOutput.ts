import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Re-arm the stored-payload compactor after the trim learned aggregatedOutput.
 *
 * The same shape of miss as migration 069, one field further along. That sweep
 * reclaimed 3.7 GB by learning `data.item.result`, and the cap has held for
 * that field since — but `data.item.aggregatedOutput` sits beside it and was
 * never covered, so the backlog rebuilt behind a cap that looked like it was
 * working.
 *
 * Measured 2026-09-01 on the live database, after 069's sweep had completed:
 * of the 40 largest activity rows, `aggregatedOutput` was the ONLY string over
 * the cap in any of them — 40 MB across those rows, 284 MB across every row
 * above 100 KB, single rows up to 1 MB. The write path now caps it, which
 * stops new growth; resetting the cursor is what reclaims what is already
 * stored. The compactor tolerates a missing row, so this is safely a no-op on
 * fresh databases.
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
