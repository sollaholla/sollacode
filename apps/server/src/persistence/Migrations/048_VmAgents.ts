import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Agent Stack registry. Each row is a named autonomous agent bound to one
 * persistent local VM. Deliberately independent of the orchestration event
 * store and thread projections: agents are their own feature, not threads.
 *
 * `handle` (the normalized `@mention` form) and `name` are both unique so the
 * chat mention router can resolve `@handle` to exactly one agent.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS vm_agents (
      vm_agent_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_lower TEXT NOT NULL,
      handle TEXT NOT NULL,
      purpose TEXT NOT NULL,
      vm_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (
        status IN ('provisioning', 'stopped', 'starting', 'running', 'stopping', 'failed')
      ),
      control_mode TEXT NOT NULL DEFAULT 'agent' CHECK (control_mode IN ('agent', 'user')),
      guest_ip TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        length(created_at) = 24
        AND created_at GLOB '????-??-??T??:??:??.???Z'
        AND julianday(created_at) IS NOT NULL
      ),
      CHECK (
        length(updated_at) = 24
        AND updated_at GLOB '????-??-??T??:??:??.???Z'
        AND julianday(updated_at) IS NOT NULL
      )
    )
  `;

  // Mention routing and name-conflict detection both need case-insensitive
  // uniqueness. The handle is already lowercased by construction.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vm_agents_handle ON vm_agents(handle)
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vm_agents_name_lower ON vm_agents(name_lower)
  `;

  // List view is ordered by creation.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_vm_agents_created ON vm_agents(created_at, vm_agent_id)
  `;
});
