import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE projection_threads ADD COLUMN created_by_thread_id TEXT`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN browser_profile_thread_id TEXT`;
});
