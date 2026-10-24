import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const DROPPED = [
  "idx_orch_events_command_id",
  "idx_orch_events_correlation_id",
  "idx_orch_command_receipts_sequence",
  "idx_projection_thread_activities_thread_sequence",
  "idx_projection_thread_messages_thread_created",
];

it.layer(NodeSqliteClient.layerMemory())("084_DropRedundantIndexes", (it) => {
  it.effect("drops only the unread indexes and leaves every row and lookup intact", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 83 });

      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        ) VALUES (
          'event-1', 'thread', 'thread-1', 0, 'thread.activity-appended',
          '2026-10-24T00:00:00.000Z', 'command-1', NULL, 'command-1', 'provider',
          '{"activity":{"id":"activity-1"}}', '{}'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_command_receipts (
          command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error
        ) VALUES (
          'command-1', 'thread', 'thread-1', '2026-10-24T00:00:00.000Z', 1, 'accepted', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        ) VALUES (
          'activity-1', 'thread-1', 'turn-1', 'tool', 'tool.completed', 'Ran', '{"x":1}', 1,
          '2026-10-24T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        ) VALUES (
          'message-1', 'thread-1', 'turn-1', 'user', 'hello', 0,
          '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z'
        )
      `;
      const snapshot = () =>
        Effect.all([
          sql`SELECT * FROM orchestration_events ORDER BY sequence`,
          sql`SELECT * FROM orchestration_command_receipts ORDER BY command_id`,
          sql`SELECT * FROM projection_thread_activities ORDER BY activity_id`,
          sql`SELECT * FROM projection_thread_messages ORDER BY message_id`,
        ]);
      const indexNames = () =>
        sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master WHERE type = 'index'
        `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

      const rowsBefore = yield* snapshot();
      const indexesBefore = yield* indexNames();
      for (const name of DROPPED) assert.include(indexesBefore, name);

      yield* runMigrations({ toMigrationInclusive: 84 });

      assert.deepEqual(yield* snapshot(), rowsBefore);
      assert.deepEqual(
        yield* indexNames(),
        indexesBefore.filter((name) => !DROPPED.includes(name)),
      );

      const planOf = (rows: ReadonlyArray<{ readonly detail: string }>) =>
        rows.map((row) => row.detail).join("\n");

      // Thread-scoped activity reads and the deletion purge keep an index on thread_id.
      const activityPlan = planOf(
        yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT COUNT(*) FROM projection_thread_activities WHERE thread_id = 'thread-1'
      `,
      );
      assert.match(
        activityPlan,
        /SEARCH projection_thread_activities USING .*INDEX \S+ \(thread_id=\?\)/,
      );

      const messagePlan = planOf(
        yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT MAX(created_at) FROM projection_thread_messages
        WHERE thread_id = 'thread-1' AND role = 'user'
      `,
      );
      assert.match(
        messagePlan,
        /SEARCH projection_thread_messages USING .*INDEX \S+ \(thread_id=\?/,
      );

      // The receipt purge never read the command index: it stays on the stream index.
      const purgePlan = planOf(
        yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT command_id FROM orchestration_command_receipts
        WHERE aggregate_kind = 'thread' AND aggregate_id = 'thread-1'
          AND command_id NOT IN (
            SELECT command_id FROM orchestration_events
            WHERE aggregate_kind = 'thread' AND stream_id = 'thread-1'
              AND event_type = 'thread.deleted' AND command_id IS NOT NULL
          )
      `,
      );
      assert.include(purgePlan, "idx_orch_command_receipts_aggregate");
      assert.include(purgePlan, "idx_orch_events_stream_type_sequence");

      // Command dedupe reads receipts by primary key.
      const receiptPlan = planOf(
        yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT status FROM orchestration_command_receipts WHERE command_id = 'command-1'
      `,
      );
      assert.include(receiptPlan, "sqlite_autoindex_orchestration_command_receipts_1");
    }),
  );
});
