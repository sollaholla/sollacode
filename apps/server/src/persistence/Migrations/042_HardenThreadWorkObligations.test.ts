import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("042_HardenThreadWorkObligations", (it) => {
  it.effect("rejects wedged lifecycle rows and non-canonical timestamps", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 42 });
      yield* runMigrations({ toMigrationInclusive: 42 });

      const invalidSleeping = yield* sql`
        INSERT INTO thread_work_obligations (
          obligation_id,
          thread_id,
          source_turn_id,
          kind,
          state,
          provider_instance_id,
          attempt,
          created_at,
          updated_at
        ) VALUES (
          'invalid-sleeping',
          'thread-invalid-sleeping',
          'turn-invalid-sleeping',
          'provider-retry',
          'sleeping',
          'codex',
          0,
          '2026-08-04T00:00:00.000Z',
          '2026-08-04T00:00:00.000Z'
        )
      `.pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(invalidSleeping));

      const nonCanonicalTimestamp = yield* sql`
        INSERT INTO thread_work_obligations (
          obligation_id,
          thread_id,
          source_turn_id,
          kind,
          state,
          provider_instance_id,
          attempt,
          created_at,
          updated_at
        ) VALUES (
          'invalid-offset',
          'thread-invalid-offset',
          'turn-invalid-offset',
          'agent-continuation',
          'pending',
          'codex',
          0,
          '2026-08-03T20:00:00.000-04:00',
          '2026-08-03T20:00:00.000-04:00'
        )
      `.pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(nonCanonicalTimestamp));

      const triggers = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'trigger'
          AND tbl_name = 'thread_work_obligations'
      `;
      assert.isTrue(
        triggers.some(({ name }) => name === "trg_thread_work_obligations_validate_insert"),
      );
      assert.isTrue(
        triggers.some(({ name }) => name === "trg_thread_work_obligations_validate_update"),
      );
    }),
  );
});
