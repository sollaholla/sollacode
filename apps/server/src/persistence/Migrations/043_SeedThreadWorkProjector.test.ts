import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("043_SeedThreadWorkProjector", (it) => {
  it.effect("starts the new projector at the existing event-log tail", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 42 });
      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          actor_kind,
          payload_json,
          metadata_json
        ) VALUES (
          'event-before-thread-work-projector',
          'thread',
          'thread-existing',
          1,
          'thread.created',
          '2026-08-04T12:00:00.000Z',
          'server',
          '{}',
          '{}'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 43 });
      const rows = yield* sql<{
        readonly lastAppliedSequence: number;
        readonly updatedAt: string;
      }>`
        SELECT
          last_applied_sequence AS "lastAppliedSequence",
          updated_at AS "updatedAt"
        FROM projection_state
        WHERE projector = 'projection.thread-work'
      `;
      assert.deepEqual(rows, [
        {
          lastAppliedSequence: 1,
          updatedAt: "2026-08-04T12:00:00.000Z",
        },
      ]);
    }),
  );
});
