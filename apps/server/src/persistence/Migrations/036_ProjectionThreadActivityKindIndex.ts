import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Shell-summary and provider-ingestion recovery queries only need a few
  // activity kinds. Lead with thread/kind so SQLite can avoid walking and
  // decoding the much larger tool payload history.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_kind_created_id
    ON projection_thread_activities(thread_id, kind, created_at, activity_id)
  `;
});
