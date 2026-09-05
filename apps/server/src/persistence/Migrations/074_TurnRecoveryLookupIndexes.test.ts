import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("074_TurnRecoveryLookupIndexes", (it) => {
  it.effect("locates delivery receipts by thread, message, and turn", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 74 });

      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT 1
        FROM orchestration_events AS absorbed INDEXED BY idx_orch_events_message_delivery
        WHERE absorbed.aggregate_kind = 'thread'
          AND absorbed.stream_id = 'thread-1'
          AND absorbed.event_type = 'thread.activity-appended'
          AND json_extract(absorbed.payload_json, '$.activity.kind') = 'message.delivered'
          AND json_extract(absorbed.payload_json, '$.activity.payload.messageId') = 'message-1'
          AND json_extract(absorbed.payload_json, '$.activity.turnId') = 'turn-1'
      `;
      const details = plan.map((row) => row.detail).join("\n");
      assert.include(details, "idx_orch_events_message_delivery");
      assert.include(details, "stream_id=? AND <expr>=? AND <expr>=?");
    }),
  );

  it.effect("restricts assistant output reads to the completed turn", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 74 });

      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT text, json_array_length(attachments_json)
        FROM projection_thread_messages
        WHERE thread_id = 'thread-1' AND turn_id = 'turn-1'
          AND role = 'assistant' AND is_streaming = 0
      `;
      const details = plan.map((row) => row.detail).join("\n");
      assert.include(details, "idx_projection_thread_messages_turn_output");
      assert.include(details, "thread_id=? AND turn_id=? AND role=? AND is_streaming=?");
    }),
  );

  it.effect("keeps activity output checks on the turn index despite a thread filter", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 74 });

      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT 1
        FROM projection_thread_activities INDEXED BY idx_projection_thread_activities_turn_kind
        WHERE thread_id = 'thread-1' AND turn_id = 'turn-1'
          AND (
            kind GLOB 'tool.*' OR kind GLOB 'task.*' OR kind GLOB 'reasoning.*'
            OR kind GLOB 'turn.plan.*' OR kind GLOB 'approval.*' OR kind GLOB 'user-input.*'
          )
        LIMIT 1
      `;
      const details = plan.map((row) => row.detail).join("\n");
      assert.include(details, "idx_projection_thread_activities_turn_kind (turn_id=?)");
      assert.notInclude(details, "thread_sequence");
    }),
  );
});
