import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Startup-time index for per-turn activity lookups.
 *
 * `backfillCurrentThreadWork` runs twice on every boot (once inside the
 * projector bootstrap, once after orphaned in-flight work is reconciled) and
 * for each live thread's latest turn asks projection_thread_activities two
 * questions keyed by turn_id: how many `runtime.error` rows does this turn
 * have, and how many output-shaped rows. Every index on that table leads
 * with thread_id, so each of those correlated COUNTs was a full scan.
 * Measured 2026-09-02 on a 10 GB live database (821k activity rows, 3 GB):
 * 52.5 s for the first pass and 17 s for the second, executed synchronously
 * on the single node:sqlite connection — which stalled the event loop, held
 * the provider status probes and the HTTP readiness endpoint behind it, and
 * kept the desktop window from appearing for 71 s after launch.
 *
 * Partial on `turn_id IS NOT NULL`: rows without a turn can never match, and
 * leaving them out keeps the index small. `kind` as the second column lets
 * the `runtime.error` count resolve inside the index. Measured on a copy of
 * that database: the query went from 113 s (cold) / 46 s (warm) to 5 s / 0.3 s
 * with this index alone, and the index built in 5 s.
 *
 * The same query's `hasLaterRealUserTurn` predicate then dominated: it walks
 * a thread's orchestration_events through the (aggregate_kind, stream_id,
 * sequence) index and filters `event_type` per row, so on a cold page cache
 * it pulled in the payload pages of every event the thread ever appended
 * (834k `thread.activity-appended` rows) to find the 7k turn-start rows it
 * wanted. Leading with event_type lets all three of its lookups (`later`,
 * `source_start`, `absorbed`) touch only rows of the type they name — the
 * query then ran in 0.00 s on the copy, and the index built in 2.3 s.
 *
 * Both builds read their table once: a one-time cost, paid on the first boot
 * after this ships, well inside the installer's readiness budget.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_turn_kind
    ON projection_thread_activities(turn_id, kind)
    WHERE turn_id IS NOT NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orch_events_stream_type_sequence
    ON orchestration_events(aggregate_kind, stream_id, event_type, sequence)
  `;
});
