import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ServerSettingsService } from "./serverSettings.ts";

export const ARCHIVED_THREAD_RETENTION_HOURS = 48;

/** Uses ordinary deletion so all clients and cleanup reactors see the same events. */
export const purgeExpiredArchivedThreads = Effect.fn("purgeExpiredArchivedThreads")(function* (
  now: DateTime.Utc,
) {
  const settings = yield* ServerSettingsService;
  if (!(yield* settings.getSettings).archivedThreadAutoDelete) return 0;
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;
  const cutoff = DateTime.formatIso(
    DateTime.subtract(now, { hours: ARCHIVED_THREAD_RETENTION_HOURS }),
  );
  let cursor = "";
  let deleted = 0;
  while (true) {
    const rows = yield* sql<{ threadId: string }>`
      SELECT thread_id AS "threadId" FROM projection_threads
      WHERE deleted_at IS NULL AND archived_at IS NOT NULL
        AND archived_at <= ${cutoff} AND thread_id > ${cursor}
      ORDER BY thread_id LIMIT 100
    `;
    if (rows.length === 0) return deleted;
    for (const row of rows) {
      if (!(yield* settings.getSettings).archivedThreadAutoDelete) return deleted;
      const commandId = CommandId.make(yield* crypto.randomUUIDv4);
      const result = yield* engine
        .dispatch({
          type: "thread.delete",
          commandId,
          threadId: ThreadId.make(row.threadId),
          archivedBefore: cutoff,
        })
        .pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logWarning("archived thread retention skipped deletion", {
              threadId: row.threadId,
              error,
            }).pipe(Effect.as(false)),
          ),
        );
      if (result) deleted += 1;
      cursor = row.threadId;
    }
  }
});

export const startArchivedThreadRetention = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  yield* settings.ready;
  yield* DateTime.now.pipe(
    Effect.flatMap(purgeExpiredArchivedThreads),
    Effect.catch((error) => Effect.logWarning("archived thread retention failed", { error })),
    Effect.repeat(Schedule.spaced(Duration.minutes(1))),
  );
});
