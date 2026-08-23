import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE vm_agent_notifications ADD COLUMN archived_at TEXT`;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_vm_agent_notifications_attention
    ON vm_agent_notifications(vm_agent_id, archived_at, read_at)
  `;
});
