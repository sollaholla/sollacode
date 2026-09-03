import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("072_TurnStartMessageIndex", (it) => {
  it.effect("answers the turn-start message lookup from the index alone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 72 });

      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT MAX(source_start.sequence)
        FROM orchestration_events AS source_start INDEXED BY idx_orch_events_turn_start_message
        WHERE source_start.aggregate_kind = 'thread'
          AND source_start.stream_id = 'thread-1'
          AND source_start.event_type = 'thread.turn-start-requested'
          AND json_extract(source_start.payload_json, '$.messageId') = 'message-1'
      `;
      const details = plan.map((row) => row.detail).join("\n");
      assert.include(details, "idx_orch_events_turn_start_message");
      assert.include(details, "<expr>=?");
    }),
  );
});
