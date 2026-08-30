import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as Schema from "effect/Schema";

import { runMigrations } from "../../persistence/Migrations.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { STORED_TOOL_RAW_OUTPUT_MAX_CHARS } from "../toolRawOutputTrim.ts";
import { runActivityPayloadCompaction } from "./ActivityPayloadCompaction.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const OVERSIZED = "x".repeat(40_000);

const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);
const decodeJson = Schema.decodeSync(Schema.UnknownFromJsonString);

const activityPayload = (rawOutputContent: string) =>
  encodeJson({
    detail: "kept",
    data: {
      toolCallId: "call-1",
      content: "kept content",
      rawOutput: { content: rawOutputContent },
    },
  });

const eventPayload = (rawOutputContent: string) =>
  encodeJson({
    threadId: "thread-1",
    activity: {
      id: "activity-1",
      tone: "info",
      kind: "tool.completed",
      summary: "ran tool",
      payload: {
        data: { toolCallId: "call-1", rawOutput: { content: rawOutputContent } },
      },
      turnId: null,
      createdAt: "2026-08-30T00:00:00.000Z",
    },
  });

const insertEvent = (input: {
  readonly eventId: string;
  readonly streamVersion: number;
  readonly eventType: string;
  readonly payloadJson: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json
      )
      VALUES (
        ${input.eventId}, 'thread', 'thread-1', ${input.streamVersion}, ${input.eventType},
        '2026-08-30T00:00:00.000Z', 'server', ${input.payloadJson}, '{}'
      )
    `;
  });

const insertActivityRow = (input: {
  readonly activityId: string;
  readonly kind: string;
  readonly payloadJson: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_activities (
        activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
      )
      VALUES (
        ${input.activityId}, 'thread-1', NULL, 'info', ${input.kind}, 's',
        ${input.payloadJson}, '2026-08-30T00:00:00.000Z'
      )
    `;
  });

layer("ActivityPayloadCompaction", (it) => {
  it.effect("trims oversized rawOutput in both tables once, then retires", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({});

      yield* insertEvent({
        eventId: "event-oversized",
        streamVersion: 1,
        eventType: "thread.activity-appended",
        payloadJson: eventPayload(OVERSIZED),
      });
      yield* insertEvent({
        eventId: "event-small",
        streamVersion: 2,
        eventType: "thread.activity-appended",
        payloadJson: eventPayload("small"),
      });
      // Oversized but not an activity event: never touched.
      yield* insertEvent({
        eventId: "event-other-type",
        streamVersion: 3,
        eventType: "thread.message-sent",
        payloadJson: encodeJson({ text: OVERSIZED }),
      });

      yield* insertActivityRow({
        activityId: "row-oversized",
        kind: "tool.completed",
        payloadJson: activityPayload(OVERSIZED),
      });
      yield* insertActivityRow({
        activityId: "row-small",
        kind: "tool.updated",
        payloadJson: activityPayload("small"),
      });
      // Oversized but not a tool row: never touched.
      yield* insertActivityRow({
        activityId: "row-other-kind",
        kind: "context-compaction",
        payloadJson: encodeJson({ data: { rawOutput: { content: OVERSIZED } } }),
      });

      yield* runActivityPayloadCompaction({ startDelayMs: 0, batchLimit: 2, batchPauseMs: 0 });

      const events = yield* sql<{ readonly eventId: string; readonly payloadJson: string }>`
        SELECT event_id AS "eventId", payload_json AS "payloadJson"
        FROM orchestration_events ORDER BY sequence
      `;
      const byEventId = new Map(events.map((row) => [row.eventId, row.payloadJson]));
      const trimmedEvent = decodeJson(byEventId.get("event-oversized")!) as {
        threadId: string;
        activity: {
          kind: string;
          payload: { data: { toolCallId: string; rawOutput: { content: string } } };
        };
      };
      assert.equal(
        trimmedEvent.activity.payload.data.rawOutput.content.length,
        STORED_TOOL_RAW_OUTPUT_MAX_CHARS,
      );
      // The envelope around the trimmed field survives byte-for-byte in shape.
      assert.equal(trimmedEvent.threadId, "thread-1");
      assert.equal(trimmedEvent.activity.kind, "tool.completed");
      assert.equal(trimmedEvent.activity.payload.data.toolCallId, "call-1");
      assert.equal(byEventId.get("event-small"), eventPayload("small"));
      assert.equal(byEventId.get("event-other-type"), encodeJson({ text: OVERSIZED }));

      const rows = yield* sql<{ readonly activityId: string; readonly payloadJson: string }>`
        SELECT activity_id AS "activityId", payload_json AS "payloadJson"
        FROM projection_thread_activities ORDER BY activity_id
      `;
      const byActivityId = new Map(rows.map((row) => [row.activityId, row.payloadJson]));
      const trimmedRow = decodeJson(byActivityId.get("row-oversized")!) as {
        detail: string;
        data: { content: string; rawOutput: { content: string } };
      };
      assert.equal(trimmedRow.data.rawOutput.content.length, STORED_TOOL_RAW_OUTPUT_MAX_CHARS);
      assert.equal(trimmedRow.data.content, "kept content");
      assert.equal(trimmedRow.detail, "kept");
      assert.equal(byActivityId.get("row-small"), activityPayload("small"));
      assert.equal(
        byActivityId.get("row-other-kind"),
        encodeJson({ data: { rawOutput: { content: OVERSIZED } } }),
      );

      const state = yield* sql<{
        readonly rowsTrimmed: number;
        readonly bytesSaved: number;
        readonly completedAt: string | null;
      }>`
        SELECT rows_trimmed AS "rowsTrimmed", bytes_saved AS "bytesSaved",
               completed_at AS "completedAt"
        FROM activity_payload_compaction_state WHERE id = 1
      `;
      assert.equal(state[0]?.rowsTrimmed, 2);
      assert.isTrue((state[0]?.bytesSaved ?? 0) > 40_000);
      assert.isNotNull(state[0]?.completedAt);

      // A finished sweep is durable: the second run changes nothing.
      const before = yield* sql<{ readonly total: string }>`
        SELECT GROUP_CONCAT(payload_json) AS "total" FROM projection_thread_activities
      `;
      yield* runActivityPayloadCompaction({ startDelayMs: 0, batchLimit: 2, batchPauseMs: 0 });
      const after = yield* sql<{ readonly total: string }>`
        SELECT GROUP_CONCAT(payload_json) AS "total" FROM projection_thread_activities
      `;
      assert.equal(after[0]?.total, before[0]?.total);

      // A cap change resets the cursor row and re-runs from the start.
      yield* sql`UPDATE activity_payload_compaction_state SET max_chars = 1 WHERE id = 1`;
      yield* runActivityPayloadCompaction({ startDelayMs: 0, batchLimit: 2, batchPauseMs: 0 });
      const reset = yield* sql<{
        readonly maxChars: number;
        readonly completedAt: string | null;
      }>`
        SELECT max_chars AS "maxChars", completed_at AS "completedAt"
        FROM activity_payload_compaction_state WHERE id = 1
      `;
      assert.equal(reset[0]?.maxChars, STORED_TOOL_RAW_OUTPUT_MAX_CHARS);
      assert.isNotNull(reset[0]?.completedAt);
    }),
  );
});
