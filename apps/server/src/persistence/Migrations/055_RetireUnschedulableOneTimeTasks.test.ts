import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const insertTask = (
  sql: SqlClient.SqlClient,
  taskId: string,
  status: string,
  nextRunAt: string | null,
  schedule: string | null,
) => sql`
  INSERT INTO vm_agent_tasks (
    task_id, vm_agent_id, title, prompt, completion_criteria_json, status,
    schedule_json, next_run_at, created_by, approval_state, notification_policy,
    artifact_id, created_at, updated_at
  ) VALUES (
    ${taskId}, 'agent-1', ${taskId}, 'Check something.', '[]', ${status},
    ${schedule}, ${nextRunAt}, 'user', 'approved', 'always',
    NULL, '2026-08-22T15:31:01.226Z', '2026-08-22T16:13:53.026Z'
  )
`;

const statusOf = (sql: SqlClient.SqlClient, taskId: string) =>
  sql`SELECT status FROM vm_agent_tasks WHERE task_id = ${taskId}`.pipe(
    Effect.map((rows) => (rows[0] as { status: string } | undefined)?.status),
  );

layer("055_RetireUnschedulableOneTimeTasks", (it) => {
  it.effect("retires a one-time task left active with nothing to run at", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO vm_agents (
          vm_agent_id, name, name_lower, handle, purpose, vm_id, thread_id, status,
          control_mode, guest_ip, last_error, created_at, updated_at
        ) VALUES (
          'agent-1', 'Agent', 'agent', 'agent', 'Work', 'vm-1', 'thread-1', 'running',
          'agent', '127.0.0.1', NULL, '2026-08-21T23:04:49.814Z', '2026-08-21T23:04:49.814Z'
        )
      `;

      // The stranded shape: claimed, its run failed, so it is active with a
      // null next_run_at that the due query requires to be set.
      yield* insertTask(
        sql,
        "stranded",
        "active",
        null,
        '{"kind":"once","runAt":"2026-08-22T16:00:00Z"}',
      );
      // A one-time task still waiting for its moment.
      yield* insertTask(
        sql,
        "pending",
        "active",
        "2026-08-23T16:00:00Z",
        '{"kind":"once","runAt":"2026-08-23T16:00:00Z"}',
      );
      // Unscheduled work rests exactly like the stranded task looks, and must
      // survive: it is waiting on the user, not on a clock.
      yield* insertTask(sql, "manual", "active", null, null);
      // A recurring task between occurrences.
      yield* insertTask(
        sql,
        "recurring",
        "active",
        "2026-08-22T17:00:00Z",
        '{"kind":"interval","everyMinutes":60}',
      );
      // Deliberately paused, not stranded.
      yield* insertTask(
        sql,
        "paused",
        "paused",
        null,
        '{"kind":"once","runAt":"2026-08-22T16:00:00Z"}',
      );

      yield* runMigrations({ toMigrationInclusive: 55 });

      assert.strictEqual(yield* statusOf(sql, "stranded"), "completed");
      assert.strictEqual(yield* statusOf(sql, "pending"), "active");
      assert.strictEqual(yield* statusOf(sql, "manual"), "active");
      assert.strictEqual(yield* statusOf(sql, "recurring"), "active");
      assert.strictEqual(yield* statusOf(sql, "paused"), "paused");

      // Stamped, so the row does not claim to be untouched since the failure.
      const rows = yield* sql`SELECT updated_at FROM vm_agent_tasks WHERE task_id = 'stranded'`;
      const updatedAt = (rows[0] as { updated_at: string }).updated_at;
      assert.notStrictEqual(updatedAt, "2026-08-22T16:13:53.026Z");
      assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }),
  );
});
