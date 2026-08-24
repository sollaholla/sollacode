import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("061_ProjectionPendingTurnQueue", (it) => {
  it.effect("deduplicates exact messages and permits multiple FIFO entries per thread", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 60 });

      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, assistant_message_id, state,
          requested_at, started_at, completed_at, checkpoint_files_json
        ) VALUES
          ('thread-queue-migration', NULL, 'message-a', NULL, 'pending',
           '2026-08-24T20:00:00.000Z', NULL, NULL, '[]'),
          ('thread-queue-migration', NULL, 'message-a', NULL, 'pending',
           '2026-08-24T20:00:01.000Z', NULL, NULL, '[]'),
          ('thread-queue-migration', NULL, 'message-b', NULL, 'pending',
           '2026-08-24T20:00:02.000Z', NULL, NULL, '[]')
      `;

      yield* runMigrations({ toMigrationInclusive: 61 });

      const rows = yield* sql<{
        readonly messageId: string;
        readonly requestedAt: string;
      }>`
        SELECT pending_message_id AS "messageId", requested_at AS "requestedAt"
        FROM projection_turns
        WHERE thread_id = 'thread-queue-migration'
        ORDER BY pending_message_id ASC
      `;
      assert.deepEqual(rows, [
        { messageId: "message-a", requestedAt: "2026-08-24T20:00:01.000Z" },
        { messageId: "message-b", requestedAt: "2026-08-24T20:00:02.000Z" },
      ]);

      const duplicate = yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, assistant_message_id, state,
          requested_at, started_at, completed_at, checkpoint_files_json
        ) VALUES (
          'thread-queue-migration', NULL, 'message-a', NULL, 'pending',
          '2026-08-24T20:00:03.000Z', NULL, NULL, '[]'
        )
      `.pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(duplicate));

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_turns)
      `;
      assert.isTrue(indexes.some((index) => index.name === "idx_projection_turns_pending_message"));
    }),
  );
});
