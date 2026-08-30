import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("067_VmAgentTaskAutoApproval", (it) => {
  it.effect("backfills existing preference rows with auto-approval ON", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-08-30T12:00:00.000Z";

      yield* runMigrations({ toMigrationInclusive: 66 });
      yield* sql`
        INSERT INTO vm_agents (
          vm_agent_id, name, name_lower, handle, purpose, vm_id, status,
          control_mode, guest_ip, last_error, created_at, updated_at, thread_id
        ) VALUES (
          'agent-migrate', 'Migrate', 'migrate', 'migrate', 'Test', 'vm-migrate',
          'running', 'agent', '127.0.0.1', NULL, ${now}, ${now}, 'thread-migrate'
        )
      `;
      yield* sql`
        INSERT INTO vm_agent_notification_preferences (
          vm_agent_id, enabled, task_completions, task_failures, agent_messages, updated_at
        ) VALUES ('agent-migrate', 1, 1, 1, 1, ${now})
      `;

      yield* runMigrations({ toMigrationInclusive: 67 });

      const rows = yield* sql<{ readonly vmAgentId: string; readonly autoApprove: number }>`
        SELECT vm_agent_id AS "vmAgentId", auto_approve_tasks AS "autoApprove"
        FROM vm_agent_notification_preferences
      `;
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]?.autoApprove, 1);

      // New rows written without the column also land ON by default.
      yield* sql`
        INSERT INTO vm_agents (
          vm_agent_id, name, name_lower, handle, purpose, vm_id, status,
          control_mode, guest_ip, last_error, created_at, updated_at, thread_id
        ) VALUES (
          'agent-fresh', 'Fresh', 'fresh', 'fresh', 'Test', 'vm-fresh',
          'running', 'agent', '127.0.0.1', NULL, ${now}, ${now}, 'thread-fresh'
        )
      `;
      yield* sql`
        INSERT INTO vm_agent_notification_preferences (
          vm_agent_id, enabled, task_completions, task_failures, agent_messages, updated_at
        ) VALUES ('agent-fresh', 1, 1, 1, 1, ${now})
      `;
      const fresh = yield* sql<{ readonly autoApprove: number }>`
        SELECT auto_approve_tasks AS "autoApprove"
        FROM vm_agent_notification_preferences
        WHERE vm_agent_id = 'agent-fresh'
      `;
      assert.strictEqual(fresh[0]?.autoApprove, 1);
    }),
  );
});
