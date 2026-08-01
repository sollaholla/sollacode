import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("037_ThreadHistoryQueryIndexes", (it) => {
  it.effect("indexes role-filtered resume messages and active turns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 36 });
      yield* runMigrations({ toMigrationInclusive: 37 });

      const messageColumns = yield* sql<{ readonly name: string }>`
        PRAGMA index_info('idx_projection_thread_messages_thread_role_created_id')
      `;
      assert.deepStrictEqual(
        messageColumns.map((column) => column.name),
        ["thread_id", "role", "created_at", "message_id"],
      );

      const turnColumns = yield* sql<{ readonly name: string }>`
        PRAGMA index_info('idx_projection_turns_thread_state_requested')
      `;
      assert.deepStrictEqual(
        turnColumns.map((column) => column.name),
        ["thread_id", "state", "requested_at"],
      );

      const messagePlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT message_id
        FROM projection_thread_messages
        WHERE thread_id = 'thread-history-test' AND role = 'assistant' AND is_streaming = 0
        ORDER BY created_at DESC, message_id DESC
        LIMIT 1
      `;
      assert.ok(
        messagePlan.some((entry) =>
          entry.detail.includes("idx_projection_thread_messages_thread_role_created_id"),
        ),
      );
    }),
  );
});
