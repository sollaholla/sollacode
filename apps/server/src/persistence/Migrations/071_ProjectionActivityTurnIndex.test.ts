import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("071_ProjectionActivityTurnIndex", (it) => {
  it.effect("gives per-turn activity counts an index instead of a table scan", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 71 });

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'projection_thread_activities'
      `;
      assert.include(
        indexes.map((row) => row.name),
        "idx_projection_thread_activities_turn_kind",
      );

      // The exact shape backfillCurrentThreadWork evaluates per latest turn.
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT COUNT(*)
        FROM projection_thread_activities failure
        WHERE failure.turn_id = 'turn-1'
          AND failure.kind = 'runtime.error'
      `;
      const details = plan.map((row) => row.detail).join("\n");
      assert.include(details, "idx_projection_thread_activities_turn_kind");
      assert.notInclude(details, "SCAN failure");

      // The "later real user turn" lookup names its event type, so the index
      // must let the planner narrow on it instead of filtering every event of
      // the stream after the fact.
      const eventIndexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'orchestration_events'
      `;
      assert.include(
        eventIndexes.map((row) => row.name),
        "idx_orch_events_stream_type_sequence",
      );
      const laterPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT 1
        FROM orchestration_events AS later
        WHERE later.aggregate_kind = 'thread'
          AND later.stream_id = 'thread-1'
          AND later.event_type = 'thread.turn-start-requested'
          AND later.sequence > 5
      `;
      const laterDetails = laterPlan.map((row) => row.detail).join("\n");
      assert.include(laterDetails, "idx_orch_events_stream_type_sequence");
      assert.include(laterDetails, "event_type=?");
    }),
  );
});
