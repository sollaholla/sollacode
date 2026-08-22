import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Each agent now owns a dedicated chat thread (created like the orchestrator's).
 * Bind it to the agent row so the client can open the agent's chat and the
 * server can tear the thread down with the agent.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE vm_agents ADD COLUMN thread_id TEXT`;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vm_agents_thread
    ON vm_agents(thread_id)
    WHERE thread_id IS NOT NULL
  `;
});
