import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS vm_agent_delegations (
      delegation_id TEXT PRIMARY KEY,
      root_vm_agent_id TEXT NOT NULL,
      source_vm_agent_id TEXT NOT NULL,
      root_delegation_id TEXT,
      parent_delegation_id TEXT,
      depth INTEGER NOT NULL,
      target_json TEXT NOT NULL,
      target_vm_agent_id TEXT,
      worker_thread_id TEXT,
      root_agent_snapshot_json TEXT NOT NULL,
      source_agent_snapshot_json TEXT NOT NULL,
      target_agent_snapshot_json TEXT,
      task_id TEXT NOT NULL UNIQUE,
      run_id TEXT,
      idempotency_key TEXT NOT NULL,
      title TEXT NOT NULL,
      task TEXT NOT NULL,
      completion_criteria_json TEXT NOT NULL,
      requested_capabilities_json TEXT NOT NULL,
      status TEXT NOT NULL,
      followup_count INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      limits_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      result_json TEXT,
      error TEXT,
      UNIQUE (source_vm_agent_id, idempotency_key)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS vm_agent_delegation_messages (
      message_id TEXT PRIMARY KEY,
      delegation_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      sender TEXT NOT NULL,
      sender_vm_agent_id TEXT,
      kind TEXT NOT NULL,
      delivery TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (delegation_id, sequence)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS vm_agent_delegation_events (
      event_id TEXT PRIMARY KEY,
      delegation_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (delegation_id, sequence)
    )
  `;

  const taskColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(vm_agent_tasks)`;
  if (!taskColumns.some((column) => column.name === "delegation_id")) {
    yield* sql`ALTER TABLE vm_agent_tasks ADD COLUMN delegation_id TEXT`;
  }

  const messageColumns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(projection_thread_messages)`;
  if (!messageColumns.some((column) => column.name === "delegation_id")) {
    yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN delegation_id TEXT`;
  }

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vm_agent_tasks_delegation
    ON vm_agent_tasks(delegation_id)
    WHERE delegation_id IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_messages_delegation
    ON projection_thread_messages(delegation_id, created_at)
    WHERE delegation_id IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_vm_agent_delegations_root_status
    ON vm_agent_delegations(root_vm_agent_id, status, updated_at DESC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_vm_agent_delegations_source_status
    ON vm_agent_delegations(source_vm_agent_id, status, updated_at DESC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_vm_agent_delegations_lineage
    ON vm_agent_delegations(root_delegation_id, parent_delegation_id, depth)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_vm_agent_delegations_target_status
    ON vm_agent_delegations(target_vm_agent_id, status, updated_at DESC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_vm_agent_delegations_expiry
    ON vm_agent_delegations(expires_at)
    WHERE status IN ('pending-approval', 'queued', 'running', 'waiting-input')
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vm_agent_delegations_worker_thread
    ON vm_agent_delegations(worker_thread_id)
    WHERE worker_thread_id IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_vm_agent_delegation_messages_work
    ON vm_agent_delegation_messages(delegation_id, sequence)
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS vm_agent_delegations_terminalize_agent_delete
    BEFORE DELETE ON vm_agents
    BEGIN
      UPDATE vm_agent_delegations
      SET status = CASE
            WHEN status IN ('pending-approval', 'queued', 'running', 'waiting-input') THEN 'failed'
            ELSE status
          END,
          completed_at = CASE
            WHEN status IN ('pending-approval', 'queued', 'running', 'waiting-input')
              THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            ELSE completed_at
          END,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          revision = revision + 1,
          error = CASE
            WHEN status IN ('pending-approval', 'queued', 'running', 'waiting-input')
              THEN 'An agent participating in this delegation was deleted.'
            ELSE error
          END
      WHERE root_vm_agent_id = OLD.vm_agent_id
         OR source_vm_agent_id = OLD.vm_agent_id
         OR target_vm_agent_id = OLD.vm_agent_id;
    END
  `;
});
