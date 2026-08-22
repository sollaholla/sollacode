import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("050_StartupRecoveryIndexes", (it) => {
  it.effect("uses bounded partial indexes for startup recovery queries", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 49 });
      yield* runMigrations({ toMigrationInclusive: 50 });

      const streamingPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        UPDATE projection_thread_messages
        SET is_streaming = 0
        WHERE is_streaming = 1
      `;
      assert.ok(
        streamingPlan.some((entry) =>
          entry.detail.includes("idx_projection_thread_messages_streaming"),
        ),
      );

      const runningTurnPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        UPDATE projection_turns
        SET state = 'incomplete'
        WHERE state = 'running'
      `;
      assert.ok(
        runningTurnPlan.some((entry) => entry.detail.includes("idx_projection_turns_running")),
      );

      const pendingTurnPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT row_id
        FROM projection_turns
        WHERE row_id > 0
          AND turn_id IS NULL
          AND state = 'pending'
          AND pending_message_id IS NOT NULL
        ORDER BY row_id ASC
        LIMIT 128
      `;
      assert.ok(
        pendingTurnPlan.some((entry) =>
          entry.detail.includes("idx_projection_turns_pending_start"),
        ),
      );
    }),
  );
});
