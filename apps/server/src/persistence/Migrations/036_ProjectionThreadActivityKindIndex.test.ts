import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("036_ProjectionThreadActivityKindIndex", (it) => {
  it.effect("indexes bounded activity-kind lookups", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 35 });
      yield* runMigrations({ toMigrationInclusive: 36 });

      const indexColumns = yield* sql<{
        readonly seqno: number;
        readonly cid: number;
        readonly name: string;
      }>`
        PRAGMA index_info('idx_projection_thread_activities_thread_kind_created_id')
      `;
      assert.deepStrictEqual(
        indexColumns.map((column) => column.name),
        ["thread_id", "kind", "created_at", "activity_id"],
      );

      const queryPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT activity_id
        FROM projection_thread_activities
        WHERE thread_id = 'thread-index-test'
          AND kind IN ('task.started', 'task.progress')
        ORDER BY created_at DESC, activity_id DESC
        LIMIT 1
      `;
      assert.ok(
        queryPlan.some((entry) =>
          entry.detail.includes("idx_projection_thread_activities_thread_kind_created_id"),
        ),
      );
    }),
  );
});
