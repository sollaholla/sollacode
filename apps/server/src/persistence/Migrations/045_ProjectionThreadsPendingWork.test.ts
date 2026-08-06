import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("045_ProjectionThreadsPendingWork", (it) => {
  it.effect("adds the columns idempotently and backfills from active obligations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 44 });
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
          'thread-pending-work',
          'project-pending-work',
          'Pending work',
          '{"instanceId":"codex","model":"test"}',
          'full-access',
          'agent',
          '2026-08-04T12:00:00.000Z',
          '2026-08-04T12:00:00.000Z'
        )
      `;
      // An active obligation that predates the upgrade must appear in the
      // backfilled columns; the completed one must not.
      yield* sql`
        INSERT INTO thread_work_obligations (
          obligation_id, thread_id, source_turn_id, kind, state,
          provider_instance_id, attempt, created_at, updated_at
        ) VALUES
          ('pw-active', 'thread-pending-work', 'turn-1', 'agent-continuation', 'pending',
            'codex', 0, '2026-08-04T12:00:01.000Z', '2026-08-04T12:00:01.000Z'),
          ('pw-done', 'thread-pending-work', 'turn-0', 'startup-resume', 'completed',
            'codex', 1, '2026-08-04T11:00:00.000Z', '2026-08-04T11:30:00.000Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 45 });
      yield* runMigrations({ toMigrationInclusive: 45 });

      const rows = yield* sql<{
        readonly kind: string | null;
        readonly state: string | null;
        readonly since: string | null;
      }>`
        SELECT
          pending_work_kind AS "kind",
          pending_work_state AS "state",
          pending_work_since AS "since"
        FROM projection_threads
        WHERE thread_id = 'thread-pending-work'
      `;
      assert.deepEqual(rows, [
        { kind: "agent-continuation", state: "pending", since: "2026-08-04T12:00:01.000Z" },
      ]);
    }),
  );
});
