import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const marker = "muse-activity-chronology-v1";

/** Recover chronology overwritten by pre-marker Muse replays, retaining the latest content. */
export const repairMuseActivityChronology = Effect.fn("repairMuseActivityChronology")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const completed = yield* sql`SELECT 1 FROM projection_state WHERE projector = ${marker}`;
  if (completed.length > 0) return;

  const candidates = yield* sql<{
    activityId: string;
    threadId: string;
    createdAt: string;
    sequence: number | null;
  }>`
      SELECT a.activity_id AS "activityId", a.thread_id AS "threadId", a.created_at AS "createdAt", a.sequence
      FROM projection_thread_activities a
      WHERE a.activity_id LIKE 'muse:%:v:%'
        OR (a.kind = 'reasoning.updated' AND EXISTS (
          SELECT 1 FROM projection_thread_activities native
          WHERE native.thread_id = a.thread_id AND native.turn_id = a.turn_id
            AND native.activity_id LIKE 'muse:%:v:%'
        ))
    `;
  const byThread = new Map<string, Map<string, (typeof candidates)[number]>>();
  for (const row of candidates) {
    let rows = byThread.get(row.threadId);
    if (!rows) byThread.set(row.threadId, (rows = new Map()));
    rows.set(row.activityId, row);
  }
  const repairs: { activityId: string; createdAt: string; sequence: number | null }[] = [];
  for (const [threadId, remaining] of byThread) {
    // The full aggregate-kind/stream/type prefix uses the existing receipt index.
    let afterSequence = 0;
    while (remaining.size > 0) {
      const receipts = yield* sql<{
        eventSequence: number;
        activityId: string;
        createdAt: string;
        sequence: number | null;
        matches: number;
      }>`
          SELECT events.sequence AS "eventSequence",
            json_extract(events.payload_json, '$.activity.id') AS "activityId",
            json_extract(events.payload_json, '$.activity.createdAt') AS "createdAt",
            json_extract(events.payload_json, '$.activity.sequence') AS sequence,
            EXISTS (SELECT 1 FROM projection_thread_activities current
              WHERE current.activity_id = json_extract(events.payload_json, '$.activity.id')
                AND current.thread_id = ${threadId}
                AND current.turn_id IS json_extract(events.payload_json, '$.activity.turnId')
                AND current.tone = json_extract(events.payload_json, '$.activity.tone')
                AND current.kind = json_extract(events.payload_json, '$.activity.kind')
                AND current.summary = json_extract(events.payload_json, '$.activity.summary')
                AND current.payload_json = json_extract(events.payload_json, '$.activity.payload')
            ) AS matches
          FROM orchestration_events events
          WHERE events.aggregate_kind = 'thread' AND events.stream_id = ${threadId}
            AND events.event_type = 'thread.activity-appended' AND events.sequence > ${afterSequence}
          ORDER BY events.sequence ASC LIMIT 500
        `;
      if (receipts.length === 0) break;
      for (const receipt of receipts) {
        afterSequence = receipt.eventSequence;
        const current = remaining.get(receipt.activityId);
        if (!current || receipt.matches !== 1) continue;
        remaining.delete(receipt.activityId);
        if (current.createdAt !== receipt.createdAt || current.sequence !== receipt.sequence) {
          repairs.push({
            activityId: receipt.activityId,
            createdAt: receipt.createdAt,
            sequence: receipt.sequence,
          });
        }
      }
    }
  }
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const repair of repairs) {
        yield* sql`UPDATE projection_thread_activities
          SET created_at = ${repair.createdAt}, sequence = ${repair.sequence}
          WHERE activity_id = ${repair.activityId}`;
      }
      yield* sql`INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES (${marker}, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
    }),
  );
});
