import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("038_ProjectionThreadsSideChat", (it) => {
  it.effect("backfills existing threads as normal threads and remains idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          deleted_at
        )
        VALUES (
          'thread-before-side-chats',
          'project-1',
          'Existing thread',
          '{"instanceId":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          '2026-08-02T00:00:00.000Z',
          '2026-08-02T00:00:00.000Z',
          NULL,
          NULL,
          0,
          0,
          0,
          NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 38 });
      yield* runMigrations({ toMigrationInclusive: 38 });

      const rows = yield* sql<{
        readonly isSideChat: number;
        readonly sideChatParentThreadId: string | null;
      }>`
        SELECT
          is_side_chat AS "isSideChat",
          side_chat_parent_thread_id AS "sideChatParentThreadId"
        FROM projection_threads
        WHERE thread_id = 'thread-before-side-chats'
      `;
      assert.deepStrictEqual(rows, [{ isSideChat: 0, sideChatParentThreadId: null }]);
    }),
  );
});
