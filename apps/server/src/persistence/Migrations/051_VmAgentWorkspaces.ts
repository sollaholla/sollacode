import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS vm_agent_artifacts (
      artifact_id TEXT PRIMARY KEY,
      vm_agent_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (vm_agent_id) REFERENCES vm_agents(vm_agent_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS vm_agent_tasks (
      task_id TEXT PRIMARY KEY,
      vm_agent_id TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      completion_criteria_json TEXT NOT NULL,
      status TEXT NOT NULL,
      schedule_json TEXT,
      next_run_at TEXT,
      created_by TEXT NOT NULL,
      approval_state TEXT NOT NULL,
      notification_policy TEXT NOT NULL,
      artifact_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (vm_agent_id) REFERENCES vm_agents(vm_agent_id) ON DELETE CASCADE,
      FOREIGN KEY (artifact_id) REFERENCES vm_agent_artifacts(artifact_id) ON DELETE SET NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS vm_agent_task_runs (
      run_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      vm_agent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      message_id TEXT,
      turn_id TEXT,
      scheduled_for TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      result_summary TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES vm_agent_tasks(task_id) ON DELETE CASCADE,
      FOREIGN KEY (vm_agent_id) REFERENCES vm_agents(vm_agent_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS vm_agent_notifications (
      notification_id TEXT PRIMARY KEY,
      vm_agent_id TEXT NOT NULL,
      task_id TEXT,
      run_id TEXT,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      deep_link TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      read_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (vm_agent_id) REFERENCES vm_agents(vm_agent_id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES vm_agent_tasks(task_id) ON DELETE SET NULL,
      FOREIGN KEY (run_id) REFERENCES vm_agent_task_runs(run_id) ON DELETE SET NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS vm_agent_notification_preferences (
      vm_agent_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL,
      task_completions INTEGER NOT NULL,
      task_failures INTEGER NOT NULL,
      agent_messages INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (vm_agent_id) REFERENCES vm_agents(vm_agent_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_vm_agent_tasks_due
    ON vm_agent_tasks(next_run_at, vm_agent_id)
    WHERE status = 'active' AND approval_state = 'approved' AND next_run_at IS NOT NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_vm_agent_tasks_agent_updated
    ON vm_agent_tasks(vm_agent_id, updated_at DESC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_vm_agent_task_runs_agent_status
    ON vm_agent_task_runs(vm_agent_id, status, created_at)
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vm_agent_task_runs_one_active_per_agent
    ON vm_agent_task_runs(vm_agent_id)
    WHERE status IN ('queued', 'booting', 'running')
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_vm_agent_task_runs_message
    ON vm_agent_task_runs(message_id)
    WHERE message_id IS NOT NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_vm_agent_notifications_agent_created
    ON vm_agent_notifications(vm_agent_id, created_at DESC)
  `;
});
