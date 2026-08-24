import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("060_ThreadAgentProvenance", (it) => {
  it.effect(
    "adds nullable creator and browser-profile provenance without relabeling old threads",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 59 });

        yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, is_side_chat, side_chat_parent_thread_id,
          model_selection_json, runtime_mode, interaction_mode, branch, worktree_path,
          latest_turn_id, created_at, updated_at, archived_at, settled_override,
          settled_at, snoozed_until, snoozed_at, latest_user_message_at,
          pending_approval_count, pending_user_input_count, has_actionable_proposed_plan,
          pending_work_kind, pending_work_state, pending_work_since, deleted_at
        ) VALUES (
          'thread-before-provenance', 'project-1', 'Existing thread', 0, NULL,
          '{"instanceId":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
          NULL, NULL, NULL, '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z',
          NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, 0, NULL, NULL, NULL, NULL
        )
      `;

        yield* runMigrations({ toMigrationInclusive: 60 });

        const rows = yield* sql<{
          readonly createdByThreadId: string | null;
          readonly browserProfileThreadId: string | null;
        }>`
        SELECT
          created_by_thread_id AS "createdByThreadId",
          browser_profile_thread_id AS "browserProfileThreadId"
        FROM projection_threads
        WHERE thread_id = 'thread-before-provenance'
      `;
        assert.deepStrictEqual(rows, [{ createdByThreadId: null, browserProfileThreadId: null }]);
      }),
  );
});
