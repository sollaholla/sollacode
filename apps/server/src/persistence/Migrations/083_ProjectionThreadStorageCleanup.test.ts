import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("083_ProjectionThreadStorageCleanup", (it) => {
  it.effect("drops counters for threads that are gone, now and whenever a row goes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 82 });

      const now = "2026-10-11T00:00:00.000Z";
      yield* sql`
        INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
        VALUES ('thread-live', 'project-1', 'Live', ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, tone, kind, summary, payload_json, created_at
        ) VALUES ('activity-1', 'thread-live', 'info', 'tool.completed', 'Ran', '{}', ${now})
      `;
      // Left behind by a purge that ran before this migration.
      yield* sql`
        INSERT INTO projection_thread_storage (thread_id, activity_count, activity_bytes)
        VALUES ('thread-purged', 0, 0)
      `;

      yield* runMigrations({ toMigrationInclusive: 83 });
      const counted = () =>
        sql<{ readonly threadId: string }>`
          SELECT thread_id AS "threadId" FROM projection_thread_storage ORDER BY thread_id
        `;
      assert.deepEqual(yield* counted(), [{ threadId: "thread-live" }]);

      yield* sql`DELETE FROM projection_threads WHERE thread_id = 'thread-live'`;
      assert.deepEqual(yield* counted(), []);
    }),
  );
});
