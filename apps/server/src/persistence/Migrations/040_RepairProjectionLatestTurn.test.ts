import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("040_RepairProjectionLatestTurn", (it) => {
  it.effect("repairs stale and dangling latest-turn pointers from durable turn order", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 39 });

      for (const [threadId, latestTurnId] of [
        ["stale-thread", "turn-old"],
        ["correct-thread", "turn-correct"],
        ["empty-thread", "turn-dangling"],
      ] as const) {
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
            ${threadId},
            'project-1',
            ${threadId},
            '{"instanceId":"codex","model":"gpt-5.6-sol"}',
            'full-access',
            'agent',
            NULL,
            NULL,
            ${latestTurnId},
            '2026-08-03T00:00:00.000Z',
            '2026-08-03T00:02:00.000Z',
            NULL,
            NULL,
            0,
            0,
            0,
            NULL
          )
        `;
      }

      for (const [threadId, turnId, requestedAt] of [
        ["stale-thread", "turn-old", "2026-08-03T00:00:00.000Z"],
        ["stale-thread", "turn-final-stop", "2026-08-03T00:01:00.000Z"],
        ["correct-thread", "turn-correct", "2026-08-03T00:02:00.000Z"],
      ] as const) {
        yield* sql`
          INSERT INTO projection_turns (
            thread_id,
            turn_id,
            state,
            requested_at,
            started_at,
            completed_at,
            checkpoint_files_json
          )
          VALUES (
            ${threadId},
            ${turnId},
            'completed',
            ${requestedAt},
            ${requestedAt},
            ${requestedAt},
            '[]'
          )
        `;
      }

      yield* runMigrations({ toMigrationInclusive: 40 });

      const rows = yield* sql<{
        readonly threadId: string;
        readonly latestTurnId: string | null;
      }>`
        SELECT thread_id AS "threadId", latest_turn_id AS "latestTurnId"
        FROM projection_threads
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(rows, [
        { threadId: "correct-thread", latestTurnId: "turn-correct" },
        { threadId: "empty-thread", latestTurnId: null },
        { threadId: "stale-thread", latestTurnId: "turn-final-stop" },
      ]);
    }),
  );
});
