import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Durable collaborative-browser tabs. The preview manager used to be purely
 * in-memory, so every server restart silently dropped all tabs while clients
 * kept their persisted browser surfaces — which then rendered dead, black
 * webviews. One row per open tab; the snapshot JSON is the encoded
 * PreviewSessionSnapshot the manager rehydrates at boot.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS preview_sessions (
      thread_id TEXT NOT NULL,
      tab_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, tab_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_preview_sessions_updated ON preview_sessions(updated_at)
  `;
});
