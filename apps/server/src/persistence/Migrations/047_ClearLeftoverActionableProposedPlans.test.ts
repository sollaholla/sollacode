import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("047_ClearLeftoverActionableProposedPlans", (it) => {
  it.effect("clears leftover plans that are not on the latest turn", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 46 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          latest_turn_id,
          created_at,
          updated_at,
          has_actionable_proposed_plan
        ) VALUES
          (
            'thread-leftover',
            'project-1',
            'Leftover plan',
            '{"instanceId":"codex","model":"test"}',
            'full-access',
            'default',
            'turn-new',
            '2026-08-18T00:00:00.000Z',
            '2026-08-18T00:00:00.000Z',
            1
          ),
          (
            'thread-waiting',
            'project-1',
            'Waiting on plan',
            '{"instanceId":"codex","model":"test"}',
            'full-access',
            'plan',
            'turn-plan',
            '2026-08-18T00:00:00.000Z',
            '2026-08-18T00:00:00.000Z',
            0
          )
      `;

      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id,
          thread_id,
          turn_id,
          plan_markdown,
          created_at,
          updated_at,
          implemented_at
        ) VALUES
          (
            'plan-old',
            'thread-leftover',
            'turn-old',
            'Old plan',
            '2026-08-18T00:00:00.000Z',
            '2026-08-18T00:00:00.000Z',
            NULL
          ),
          (
            'plan-current',
            'thread-waiting',
            'turn-plan',
            'Current plan',
            '2026-08-18T00:00:00.000Z',
            '2026-08-18T00:00:00.000Z',
            NULL
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* runMigrations({ toMigrationInclusive: 47 });

      const rows = yield* sql<{
        readonly threadId: string;
        readonly hasActionableProposedPlan: number;
      }>`
        SELECT
          thread_id AS "threadId",
          has_actionable_proposed_plan AS "hasActionableProposedPlan"
        FROM projection_threads
        WHERE thread_id IN ('thread-leftover', 'thread-waiting')
        ORDER BY thread_id
      `;
      assert.deepEqual(rows, [
        { threadId: "thread-leftover", hasActionableProposedPlan: 0 },
        { threadId: "thread-waiting", hasActionableProposedPlan: 1 },
      ]);
    }),
  );
});
