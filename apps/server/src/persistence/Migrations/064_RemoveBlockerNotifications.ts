import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A waiting-on-you blocker is its own durable attention record. Older builds
 * also inserted an inbox notification keyed to the blocker, which made one
 * request appear twice and could produce two desktop alerts. Those derivative
 * rows are obsolete now that blockers render in the shared attention stack.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    DELETE FROM vm_agent_notifications
    WHERE dedupe_key LIKE 'blocker:%'
  `;
});
