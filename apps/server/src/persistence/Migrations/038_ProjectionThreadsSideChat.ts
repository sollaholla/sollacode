import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "is_side_chat")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN is_side_chat INTEGER NOT NULL DEFAULT 0
    `;
  }

  if (!columns.some((column) => column.name === "side_chat_parent_thread_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN side_chat_parent_thread_id TEXT
    `;
  }
});
