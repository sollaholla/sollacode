import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The thread summary's background tasks: work a provider is still running
 * after the turn that started it settled.
 *
 * No backfill. Nothing a provider runs survives a server restart, and this
 * migration only runs during one: the restart reconcile closes whatever tasks
 * the previous process left open, and the projector maintains these columns
 * from every task event after that.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN background_task_count INTEGER NOT NULL DEFAULT 0
  `;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN background_tasks_started_at TEXT`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN background_tasks_activity_at TEXT`;
});
