import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The thread-work projector is introduced after many installations already
 * have large event logs. Seed its cursor at the current tail so first startup
 * does not replay every historical event. Current eligible work is recovered
 * separately from bounded projection-table queries.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    INSERT OR IGNORE INTO projection_state (
      projector,
      last_applied_sequence,
      updated_at
    )
    SELECT
      'projection.thread-work',
      COALESCE(MAX(sequence), 0),
      COALESCE(MAX(occurred_at), '1970-01-01T00:00:00.000Z')
    FROM orchestration_events
  `;
});
