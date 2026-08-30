import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("066_RepairProjectionPendingUserInput", (it) => {
  it.effect("settles requests whose answer died with the session, and only those", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 65 });

      for (const threadId of ["dead-session-thread", "open-thread", "other-failure-thread"]) {
        yield* sql`
          INSERT INTO projection_threads (
            thread_id,
            project_id,
            title,
            created_at,
            updated_at,
            pending_user_input_count
          )
          VALUES (
            ${threadId},
            'project-1',
            ${threadId},
            '2026-08-29T00:00:00.000Z',
            '2026-08-29T00:05:00.000Z',
            1
          )
        `;
      }

      const activities: ReadonlyArray<
        readonly [id: string, threadId: string, kind: string, payload: string, createdAt: string]
      > = [
        // Asked, then the answer failed because the session was already gone.
        // Nothing will ever resolve this requestId — the re-ask gets a new one.
        [
          "a-1",
          "dead-session-thread",
          "user-input.requested",
          '{"requestId":"request-dead","questions":[]}',
          "2026-08-29T00:01:00.000Z",
        ],
        [
          "a-2",
          "dead-session-thread",
          "provider.user-input.respond.failed",
          '{"requestId":"request-dead","detail":"No active provider session is bound to this thread."}',
          "2026-08-29T00:02:00.000Z",
        ],
        // A genuinely open question must stay counted.
        [
          "b-1",
          "open-thread",
          "user-input.requested",
          '{"requestId":"request-open","questions":[]}',
          "2026-08-29T00:01:00.000Z",
        ],
        // A failure that says nothing about the session being gone settles
        // nothing: the request may still be answerable on retry.
        [
          "c-1",
          "other-failure-thread",
          "user-input.requested",
          '{"requestId":"request-flaky","questions":[]}',
          "2026-08-29T00:01:00.000Z",
        ],
        [
          "c-2",
          "other-failure-thread",
          "provider.user-input.respond.failed",
          '{"requestId":"request-flaky","detail":"The provider timed out."}',
          "2026-08-29T00:02:00.000Z",
        ],
      ];
      for (const [activityId, threadId, kind, payload, createdAt] of activities) {
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id,
            thread_id,
            turn_id,
            tone,
            kind,
            summary,
            payload_json,
            created_at
          )
          VALUES (
            ${activityId},
            ${threadId},
            NULL,
            'info',
            ${kind},
            ${kind},
            ${payload},
            ${createdAt}
          )
        `;
      }

      yield* runMigrations({ toMigrationInclusive: 66 });

      const rows = yield* sql<{
        readonly threadId: string;
        readonly pendingUserInputCount: number;
      }>`
        SELECT
          thread_id AS "threadId",
          pending_user_input_count AS "pendingUserInputCount"
        FROM projection_threads
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(rows, [
        { threadId: "dead-session-thread", pendingUserInputCount: 0 },
        { threadId: "open-thread", pendingUserInputCount: 1 },
        { threadId: "other-failure-thread", pendingUserInputCount: 1 },
      ]);
    }),
  );
});
