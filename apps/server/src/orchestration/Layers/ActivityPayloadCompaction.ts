import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  STORED_TOOL_RAW_OUTPUT_MAX_CHARS,
  trimToolRawOutputInPayload,
} from "../toolRawOutputTrim.ts";

/**
 * One-time background compaction of oversized stored tool payloads.
 *
 * The write path caps tool `rawOutput` as of 0.1.324, but everything written
 * before then is still on disk — measured 2026-08-30 on the live 13 GB
 * database, ~3 GB of projection_thread_activities sat in 8.3k tool rows over
 * 64 KB, with the same payloads stored a second time inside the event store's
 * thread.activity-appended rows (4.5 GB table). This sweep walks both tables
 * once in small throttled batches and rewrites any row whose `rawOutput`
 * strings exceed the storage cap.
 *
 * Ordering matters: the event store is compacted FIRST, because a projector
 * bootstrap replay rewrites projection rows from event payloads — trimming
 * events first means any replay writes trimmed data, never resurrects blobs.
 *
 * The cursor lives in `activity_payload_compaction_state` (migration 068), so
 * a restart resumes instead of rescanning and a finished sweep never runs
 * again — unless the cap changes, which resets the row. Freed pages are
 * reused by SQLite; no VACUUM is attempted (rewriting a 13 GB file under a
 * live server is not worth the disk-space cosmetics).
 *
 * Failure posture: a row that cannot be decoded is skipped and counted, and
 * any unexpected failure logs and ends the sweep — the next boot resumes from
 * the durable cursor. Nothing here can fail the server.
 */
export interface ActivityPayloadCompactionOptions {
  /** Delay before the sweep starts, so boot and catch-up settle first. */
  readonly startDelayMs?: number;
  /** Oversized rows fetched (and possibly rewritten) per batch. */
  readonly batchLimit?: number;
  /** Pause between batches; keeps the I/O footprint polite. */
  readonly batchPauseMs?: number;
}

/**
 * Rows below this byte floor are never even parsed: a payload cannot contain
 * a string over the cap without exceeding it, and parsing only candidate rows
 * is what keeps the scan cheap relative to the tables' row counts.
 */
const OVERSIZED_ROW_FLOOR_BYTES = 32_768;

const decodeJson = Schema.decodeEffect(Schema.UnknownFromJsonString);
const encodeJson = Schema.encodeEffect(Schema.UnknownFromJsonString);

interface CompactionCounters {
  rowsTrimmed: number;
  bytesSaved: number;
  rowsSkipped: number;
}

/** Trimmed replacement JSON for a projection activity payload, or null. */
const trimActivityPayloadJson = (payloadJson: string) =>
  Effect.gen(function* () {
    const payload = yield* decodeJson(payloadJson);
    const trimmed = trimToolRawOutputInPayload(payload, STORED_TOOL_RAW_OUTPUT_MAX_CHARS);
    if (!trimmed.changed) return null;
    return yield* encodeJson(trimmed.payload);
  });

/**
 * Trimmed replacement JSON for a `thread.activity-appended` EVENT payload —
 * the activity sits one level down, at `$.activity.payload` — or null.
 */
const trimEventPayloadJson = (payloadJson: string) =>
  Effect.gen(function* () {
    const envelope = yield* decodeJson(payloadJson);
    if (envelope === null || typeof envelope !== "object") return null;
    const activity = (envelope as { readonly activity?: unknown }).activity;
    if (activity === null || activity === undefined || typeof activity !== "object") return null;
    const activityPayload = (activity as { readonly payload?: unknown }).payload;
    const trimmed = trimToolRawOutputInPayload(activityPayload, STORED_TOOL_RAW_OUTPUT_MAX_CHARS);
    if (!trimmed.changed) return null;
    return yield* encodeJson({
      ...(envelope as Record<string, unknown>),
      activity: { ...(activity as Record<string, unknown>), payload: trimmed.payload },
    });
  });

export const runActivityPayloadCompaction = (options?: ActivityPayloadCompactionOptions) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const batchLimit = options?.batchLimit ?? 48;
    const batchPauseMs = options?.batchPauseMs ?? 400;

    yield* Effect.sleep(options?.startDelayMs ?? 45_000);

    const stateRows = yield* sql<{
      readonly maxChars: number;
      readonly projectionRowid: number;
      readonly eventsSequence: number;
      readonly rowsTrimmed: number;
      readonly bytesSaved: number;
      readonly completedAt: string | null;
    }>`
      SELECT
        max_chars AS "maxChars",
        projection_rowid AS "projectionRowid",
        events_sequence AS "eventsSequence",
        rows_trimmed AS "rowsTrimmed",
        bytes_saved AS "bytesSaved",
        completed_at AS "completedAt"
      FROM activity_payload_compaction_state
      WHERE id = 1
    `;
    let state = stateRows[0];
    if (state === undefined || state.maxChars !== STORED_TOOL_RAW_OUTPUT_MAX_CHARS) {
      yield* sql`
        INSERT INTO activity_payload_compaction_state (
          id, max_chars, projection_rowid, events_sequence, rows_trimmed, bytes_saved, completed_at
        )
        VALUES (1, ${STORED_TOOL_RAW_OUTPUT_MAX_CHARS}, 0, 0, 0, 0, NULL)
        ON CONFLICT (id) DO UPDATE SET
          max_chars = excluded.max_chars,
          projection_rowid = 0,
          events_sequence = 0,
          rows_trimmed = 0,
          bytes_saved = 0,
          completed_at = NULL
      `;
      state = {
        maxChars: STORED_TOOL_RAW_OUTPUT_MAX_CHARS,
        projectionRowid: 0,
        eventsSequence: 0,
        rowsTrimmed: 0,
        bytesSaved: 0,
        completedAt: null,
      };
    }
    if (state.completedAt !== null) return;

    const counters: CompactionCounters = {
      rowsTrimmed: state.rowsTrimmed,
      bytesSaved: state.bytesSaved,
      rowsSkipped: 0,
    };

    const compactRow = <TrimError, UpdateValue, UpdateError>(
      row: { readonly payloadJson: string },
      trim: (payloadJson: string) => Effect.Effect<string | null, TrimError>,
      update: (trimmedJson: string) => Effect.Effect<UpdateValue, UpdateError>,
    ) =>
      Effect.gen(function* () {
        const trimmedJson = yield* trim(row.payloadJson);
        if (trimmedJson === null || trimmedJson.length >= row.payloadJson.length) return;
        yield* update(trimmedJson);
        counters.rowsTrimmed += 1;
        counters.bytesSaved += row.payloadJson.length - trimmedJson.length;
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.sync(() => {
                counters.rowsSkipped += 1;
              }),
        ),
      );

    const persistProgress = (patch: { projectionRowid?: number; eventsSequence?: number }) =>
      sql`
        UPDATE activity_payload_compaction_state
        SET
          projection_rowid = COALESCE(${patch.projectionRowid ?? null}, projection_rowid),
          events_sequence = COALESCE(${patch.eventsSequence ?? null}, events_sequence),
          rows_trimmed = ${counters.rowsTrimmed},
          bytes_saved = ${counters.bytesSaved}
        WHERE id = 1
      `;

    // Phase 1: the event store (see the ordering note in the module doc).
    let eventsCursor = state.eventsSequence;
    while (true) {
      const rows = yield* sql<{ readonly sequence: number; readonly payloadJson: string }>`
        SELECT sequence AS "sequence", payload_json AS "payloadJson"
        FROM orchestration_events
        WHERE sequence > ${eventsCursor}
          AND event_type = 'thread.activity-appended'
          AND LENGTH(payload_json) > ${OVERSIZED_ROW_FLOOR_BYTES}
        ORDER BY sequence ASC
        LIMIT ${batchLimit}
      `;
      if (rows.length === 0) break;
      for (const row of rows) {
        yield* compactRow(
          row,
          trimEventPayloadJson,
          (trimmedJson) =>
            sql`
              UPDATE orchestration_events
              SET payload_json = ${trimmedJson}
              WHERE sequence = ${row.sequence}
            `,
        );
      }
      eventsCursor = rows.at(-1)!.sequence;
      yield* persistProgress({ eventsSequence: eventsCursor });
      if (rows.length < batchLimit) break;
      yield* Effect.sleep(batchPauseMs);
    }

    // Phase 2: the activity projection.
    let projectionCursor = state.projectionRowid;
    while (true) {
      const rows = yield* sql<{ readonly rowid: number; readonly payloadJson: string }>`
        SELECT rowid AS "rowid", payload_json AS "payloadJson"
        FROM projection_thread_activities
        WHERE rowid > ${projectionCursor}
          AND kind IN ('tool.completed', 'tool.updated')
          AND LENGTH(payload_json) > ${OVERSIZED_ROW_FLOOR_BYTES}
        ORDER BY rowid ASC
        LIMIT ${batchLimit}
      `;
      if (rows.length === 0) break;
      for (const row of rows) {
        yield* compactRow(
          row,
          trimActivityPayloadJson,
          (trimmedJson) =>
            sql`
              UPDATE projection_thread_activities
              SET payload_json = ${trimmedJson}
              WHERE rowid = ${row.rowid}
            `,
        );
      }
      projectionCursor = rows.at(-1)!.rowid;
      yield* persistProgress({ projectionRowid: projectionCursor });
      if (rows.length < batchLimit) break;
      yield* Effect.sleep(batchPauseMs);
    }

    const completedAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      UPDATE activity_payload_compaction_state
      SET
        completed_at = ${completedAt},
        rows_trimmed = ${counters.rowsTrimmed},
        bytes_saved = ${counters.bytesSaved}
      WHERE id = 1
    `;
    yield* Effect.logInfo("activity payload compaction completed", {
      rowsTrimmed: counters.rowsTrimmed,
      bytesSaved: counters.bytesSaved,
      rowsSkipped: counters.rowsSkipped,
    });
  });

export const ActivityPayloadCompactionLive = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* runActivityPayloadCompaction().pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("activity payload compaction stopped early", {
              cause: Cause.pretty(cause),
            }),
      ),
      Effect.forkScoped,
    );
  }),
);
