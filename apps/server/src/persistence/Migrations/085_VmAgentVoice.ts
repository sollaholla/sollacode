import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** The GPT-Live voice chosen for an agent's calls; NULL gives it one from its character. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE vm_agents ADD COLUMN voice TEXT`;
});
