import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Standing "waiting on you" requests raised by an agent when its work is
 * blocked on something only the user can do (a login, a CAPTCHA, a
 * permission). Persisted so the request outlives the turn that raised it and
 * stays visible until the user or a later agent run resolves it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS vm_agent_blockers (
      blocker_id TEXT PRIMARY KEY,
      vm_agent_id TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT,
      FOREIGN KEY (vm_agent_id) REFERENCES vm_agents(vm_agent_id) ON DELETE CASCADE
    )
  `;

  // One OPEN blocker per (agent, title): an agent re-reporting the same
  // blocker on every scheduled run refreshes the row instead of stacking
  // duplicates in front of the user. Resolved history is unconstrained.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vm_agent_blockers_open_title
    ON vm_agent_blockers(vm_agent_id, title)
    WHERE resolved_at IS NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_vm_agent_blockers_agent_created
    ON vm_agent_blockers(vm_agent_id, created_at DESC)
  `;
});
