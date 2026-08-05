import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("044_ProjectionThreadSessionFailureKind", (it) => {
  it.effect("adds an idempotent nullable structured failure classification", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          created_at,
          updated_at
        ) VALUES (
          'thread-failure-kind',
          'project-failure-kind',
          'Failure kind',
          '{"instanceId":"codex","model":"test"}',
          'full-access',
          'default',
          '2026-08-04T12:00:00.000Z',
          '2026-08-04T12:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          runtime_mode,
          updated_at
        ) VALUES (
          'thread-failure-kind',
          'error',
          'full-access',
          '2026-08-04T12:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 44 });
      yield* runMigrations({ toMigrationInclusive: 44 });

      const initial = yield* sql<{ readonly failureKind: string | null }>`
        SELECT failure_kind AS "failureKind"
        FROM projection_thread_sessions
        WHERE thread_id = 'thread-failure-kind'
      `;
      assert.deepEqual(initial, [{ failureKind: null }]);

      yield* sql`
        UPDATE projection_thread_sessions
        SET failure_kind = 'retryable-upstream'
        WHERE thread_id = 'thread-failure-kind'
      `;
      const updated = yield* sql<{ readonly failureKind: string | null }>`
        SELECT failure_kind AS "failureKind"
        FROM projection_thread_sessions
        WHERE thread_id = 'thread-failure-kind'
      `;
      assert.deepEqual(updated, [{ failureKind: "retryable-upstream" }]);
    }),
  );
});
