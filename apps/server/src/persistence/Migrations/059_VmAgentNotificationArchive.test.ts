import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("059_VmAgentNotificationArchive", (it) => {
  it.effect("preserves existing inbox messages while adding reversible archive state", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const createdAt = "2026-08-23T12:00:00.000Z";

      yield* runMigrations({ toMigrationInclusive: 58 });
      yield* sql`
        INSERT INTO vm_agents (
          vm_agent_id, name, name_lower, handle, purpose, vm_id, thread_id,
          status, control_mode, guest_ip, last_error, created_at, updated_at
        ) VALUES (
          'agent-inbox', 'Inbox', 'inbox', 'inbox', 'Check migration safety',
          'vm-inbox', 'thread-inbox', 'running', 'agent', NULL, NULL,
          ${createdAt}, ${createdAt}
        )
      `;
      yield* sql`
        INSERT INTO vm_agent_notifications (
          notification_id, vm_agent_id, task_id, run_id, kind, title, body,
          deep_link, dedupe_key, read_at, created_at
        ) VALUES (
          'notification-before-archive', 'agent-inbox', NULL, NULL,
          'agent-message', 'Existing message', 'Still here', '/agents/agent-inbox',
          'existing-message', NULL, ${createdAt}
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 59 });

      const messages = yield* sql<{
        readonly notificationId: string;
        readonly archivedAt: string | null;
      }>`
        SELECT notification_id AS "notificationId", archived_at AS "archivedAt"
        FROM vm_agent_notifications
      `;
      assert.deepStrictEqual(messages, [
        { notificationId: "notification-before-archive", archivedAt: null },
      ]);

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(vm_agent_notifications)
      `;
      assert.ok(indexes.some((index) => index.name === "idx_vm_agent_notifications_attention"));
    }),
  );
});
