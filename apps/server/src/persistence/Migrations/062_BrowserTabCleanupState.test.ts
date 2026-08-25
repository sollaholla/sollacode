import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("062_BrowserTabCleanupState", (it) => {
  it.effect("adds one durable cleanup baseline per thread", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* runMigrations({ toMigrationInclusive: 62 });
      yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, scripts_json, created_at, updated_at
          ) VALUES (
            'project-one', 'Project', '/tmp/project', '{}',
            '2026-08-25T11:58:00.000Z', '2026-08-25T11:58:00.000Z'
          )
        `;
      yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, created_at, updated_at
          ) VALUES (
            'thread-one', 'project-one', 'Thread',
            '2026-08-25T11:59:00.000Z', '2026-08-25T11:59:00.000Z'
          )
        `;
      yield* sql`
          INSERT INTO browser_tab_cleanup_state (
            thread_id, tab_set_json, last_processed_turn_id,
            last_processed_start_sequence, updated_at
          ) VALUES (
            'thread-one', '["tab-a"]', 'turn-one', 1,
            '2026-08-25T12:00:00.000Z'
          )
        `;
      yield* sql`
          INSERT INTO browser_tab_cleanup_turn_receipts (
            thread_id, turn_id, created_at, processed_at
          ) VALUES (
            'thread-one', 'turn-one',
            '2026-08-25T11:59:00.000Z', '2026-08-25T12:00:00.000Z'
          )
        `;

      const rows = yield* sql<{
        readonly threadId: string;
        readonly tabSetJson: string;
        readonly lastProcessedTurnId: string | null;
        readonly lastProcessedStartSequence: number;
      }>`
          SELECT
            thread_id AS "threadId",
            tab_set_json AS "tabSetJson",
            last_processed_turn_id AS "lastProcessedTurnId",
            last_processed_start_sequence AS "lastProcessedStartSequence"
          FROM browser_tab_cleanup_state
        `;
      assert.deepEqual(rows, [
        {
          threadId: "thread-one",
          tabSetJson: '["tab-a"]',
          lastProcessedTurnId: "turn-one",
          lastProcessedStartSequence: 1,
        },
      ]);

      yield* sql`DELETE FROM projection_threads WHERE thread_id = 'thread-one'`;
      const afterThreadDelete = yield* sql<{ readonly count: number }>`
          SELECT
            (SELECT COUNT(*) FROM browser_tab_cleanup_state)
              + (SELECT COUNT(*) FROM browser_tab_cleanup_turn_receipts) AS count
        `;
      assert.deepEqual(afterThreadDelete, [{ count: 0 }]);
    }),
  );
});
