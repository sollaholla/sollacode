import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // History resume context asks for the newest completed message per role.
  // Keeping role behind thread_id also accelerates role-filtered MCP pages.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_thread_role_created_id
    ON projection_thread_messages(thread_id, role, created_at, message_id)
  `;

  // Active-turn lookup is part of every history result's resume context.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turns_thread_state_requested
    ON projection_turns(thread_id, state, requested_at)
  `;
});
