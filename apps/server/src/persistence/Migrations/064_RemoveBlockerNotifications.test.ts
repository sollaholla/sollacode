import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("064_RemoveBlockerNotifications", (it) => {
  it.effect("removes blocker-derived alerts while preserving ordinary notifications", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const createdAt = "2026-08-26T12:00:00.000Z";

      yield* runMigrations({ toMigrationInclusive: 63 });
      yield* sql`
        INSERT INTO vm_agents (
          vm_agent_id, name, name_lower, handle, purpose, vm_id, thread_id,
          status, control_mode, guest_ip, last_error, created_at, updated_at
        ) VALUES (
          'agent-attention', 'Attention', 'attention', 'attention', 'Test attention',
          'vm-attention', 'thread-attention', 'running', 'agent', NULL, NULL,
          ${createdAt}, ${createdAt}
        )
      `;
      yield* sql`
        INSERT INTO vm_agent_notifications (
          notification_id, vm_agent_id, task_id, run_id, kind, title, body,
          deep_link, dedupe_key, read_at, archived_at, created_at
        ) VALUES
          (
            'blocker-alert', 'agent-attention', NULL, NULL, 'task-blocked',
            'Waiting on you: Sign in', 'Please sign in.', '/agents/agent-attention',
            'blocker:blocker-1', NULL, NULL, ${createdAt}
          ),
          (
            'ordinary-alert', 'agent-attention', NULL, NULL, 'agent-message',
            'Report ready', 'The report is ready.', '/agents/agent-attention',
            'agent-message:ordinary-alert', NULL, NULL, ${createdAt}
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 64 });

      const notifications = yield* sql<{ readonly notificationId: string }>`
        SELECT notification_id AS "notificationId"
        FROM vm_agent_notifications
        ORDER BY notification_id
      `;
      assert.deepStrictEqual(notifications, [{ notificationId: "ordinary-alert" }]);
    }),
  );
});
