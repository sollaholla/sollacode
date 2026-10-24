import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("082_ProjectionThreadStorage", (it) => {
  it.effect("backfills each thread's history size and keeps it exact on every write", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 81 });

      const insertActivity = (activityId: string, threadId: string, payload: string) => sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        ) VALUES (
          ${activityId}, ${threadId}, NULL, 'info', 'tool.completed', 'Ran', ${payload}, NULL,
          '2026-10-11T00:00:00.000Z'
        )
        ON CONFLICT (activity_id) DO UPDATE SET payload_json = excluded.payload_json
      `;
      const insertMessage = (messageId: string, threadId: string, text: string) => sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at,
          attachments_json
        ) VALUES (
          ${messageId}, ${threadId}, NULL, 'user', ${text}, 0, '2026-10-11T00:00:00.000Z',
          '2026-10-11T00:00:00.000Z', '[]'
        )
      `;
      const storageOf = (threadId: string) =>
        sql<{
          readonly activityCount: number;
          readonly activityBytes: number;
          readonly messageCount: number;
          readonly messageBytes: number;
        }>`
          SELECT
            activity_count AS "activityCount",
            activity_bytes AS "activityBytes",
            message_count AS "messageCount",
            message_bytes AS "messageBytes"
          FROM projection_thread_storage
          WHERE thread_id = ${threadId}
        `.pipe(Effect.map((rows) => rows[0]));

      // History written before the upgrade is counted by the backfill.
      yield* insertActivity("activity-1", "thread-a", '{"detail":"0123456789"}');
      yield* insertMessage("message-1", "thread-a", "hello");
      yield* runMigrations({ toMigrationInclusive: 82 });
      // 'Ran' (3) + payload (23); message text (5) + '[]' (2).
      assert.deepEqual(yield* storageOf("thread-a"), {
        activityCount: 1,
        activityBytes: 26,
        messageCount: 1,
        messageBytes: 7,
      });

      // Writes after it are counted as they land.
      yield* insertActivity("activity-2", "thread-a", '{"detail":"x"}');
      yield* insertActivity("activity-3", "thread-b", '{"detail":"y"}');
      assert.equal((yield* storageOf("thread-a"))?.activityBytes, 26 + 3 + 14);
      assert.equal((yield* storageOf("thread-b"))?.activityCount, 1);

      // An activity replaced in place counts its new size, not both.
      yield* insertActivity("activity-2", "thread-a", '{"detail":"longer detail"}');
      assert.deepEqual(yield* storageOf("thread-a"), {
        activityCount: 2,
        activityBytes: 26 + 3 + 26,
        messageCount: 1,
        messageBytes: 7,
      });

      yield* sql`DELETE FROM projection_thread_activities WHERE thread_id = 'thread-a'`;
      yield* sql`DELETE FROM projection_thread_messages WHERE thread_id = 'thread-a'`;
      assert.deepEqual(yield* storageOf("thread-a"), {
        activityCount: 0,
        activityBytes: 0,
        messageCount: 0,
        messageBytes: 0,
      });
    }),
  );
});
