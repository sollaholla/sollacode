import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Index-only answers for "was a real user turn requested after this one?".
 *
 * The boot recovery scan (`laterRealUserTurnExists` in ProjectionPipeline.ts)
 * finds a turn's own start event by the message id inside its payload, then
 * looks for later start events whose message ids are not synthetic. With
 * migration 071 the scan already reaches only `thread.turn-start-requested`
 * rows through an index, but it still had to read each of those rows' payload
 * pages to json_extract the message id -- thousands of random page reads into
 * a multi-gigabyte table on a cold cache. Measured 2026-09-02 on the first
 * boot after an install: 4.9 s for one busy thread, 0.9-1.2 s for the next
 * two, all of it ahead of the readiness probe the main window waits on.
 *
 * This partial expression index holds exactly the columns that lookup needs,
 * for exactly those rows (~7k of 2.3M on the live database), so the planner
 * answers it from the index alone. Building it evaluates the partial WHERE on
 * every row once but parses JSON only for the rows it keeps: seconds, once.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orch_events_turn_start_message
    ON orchestration_events(
      stream_id,
      json_extract(payload_json, '$.messageId'),
      sequence
    )
    WHERE aggregate_kind = 'thread'
      AND event_type = 'thread.turn-start-requested'
  `;
});
