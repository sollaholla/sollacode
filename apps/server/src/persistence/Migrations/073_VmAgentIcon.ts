import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Agents wear an outlined glyph in the sidebar and header, chosen by the AI
 * that creates them or by their own first run. Stored as a lucide icon id;
 * NULL means "not chosen yet" and the client derives one from the name.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE vm_agents ADD COLUMN icon TEXT`;
});
