import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("041_ThreadWorkObligations", (it) => {
  it.effect("creates durable work constraints and remains idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* runMigrations({ toMigrationInclusive: 41 });
      yield* runMigrations({ toMigrationInclusive: 41 });

      yield* sql`
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
          'obligation-1',
          'thread-1',
          'turn-1',
          'agent-continuation',
          'pending',
          'codex',
          0,
          '2026-08-04T00:00:00.000Z',
          '2026-08-04T00:00:00.000Z'
        )
      `;

      // The deterministic source key prevents duplicate continuation work.
      yield* sql`
        INSERT OR IGNORE INTO thread_work_obligations (
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
          'obligation-duplicate',
          'thread-1',
          'turn-1',
          'agent-continuation',
          'pending',
          'codex',
          0,
          '2026-08-04T00:00:01.000Z',
          '2026-08-04T00:00:01.000Z'
        )
      `;

      const duplicateCount = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM thread_work_obligations
        WHERE thread_id = 'thread-1'
          AND source_turn_id = 'turn-1'
          AND kind = 'agent-continuation'
      `;
      assert.strictEqual(duplicateCount[0]?.count, 1);

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND tbl_name = 'thread_work_obligations'
      `;
      assert.isTrue(
        indexes.some(({ name }) => name === "idx_thread_work_obligations_one_active_thread"),
      );
      assert.isTrue(indexes.some(({ name }) => name === "idx_thread_work_obligations_schedulable"));
      assert.isTrue(
        indexes.some(({ name }) => name === "idx_thread_work_obligations_terminal_prune"),
      );
    }),
  );
});
