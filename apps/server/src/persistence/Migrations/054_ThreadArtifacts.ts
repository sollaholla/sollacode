import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Deliberately no projection_threads FK: deleting metadata before immutable
  // revision directories would strand bytes. ThreadDeletionReactor asks the
  // artifact service to remove bytes first and metadata second through its
  // drainable queue. Archived artifacts remain intact; only thread.deleted
  // enters that internal irreversible cleanup path.
  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_artifacts (
      artifact_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      artifact_key TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('structured', 'markdown', 'image', 'pdf', 'web')),
      current_revision INTEGER NOT NULL CHECK (current_revision > 0),
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_artifacts_thread_key
    ON thread_artifacts(thread_id, artifact_key)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_artifact_revisions (
      artifact_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      entry_path TEXT NOT NULL,
      content_type TEXT NOT NULL,
      byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
      file_count INTEGER NOT NULL CHECK (file_count > 0),
      icon_source TEXT NOT NULL CHECK (icon_source IN ('provided', 'generated')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (artifact_id, revision),
      FOREIGN KEY (artifact_id) REFERENCES thread_artifacts(artifact_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_artifacts_thread_updated
    ON thread_artifacts(thread_id, archived_at, updated_at DESC, artifact_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_artifact_revisions_artifact_created
    ON thread_artifact_revisions(artifact_id, revision DESC)
  `;
});
