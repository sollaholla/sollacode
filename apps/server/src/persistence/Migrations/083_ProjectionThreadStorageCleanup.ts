import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A thread's storage counters go with its row. The deletion purge removes the
 * row last, after the history the counters measured, so without this every
 * deleted thread would leave a row of zeros behind.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TRIGGER projection_thread_storage_thread_delete
    AFTER DELETE ON projection_threads
    BEGIN
      DELETE FROM projection_thread_storage WHERE thread_id = OLD.thread_id;
    END
  `;
  yield* sql`
    DELETE FROM projection_thread_storage
    WHERE thread_id NOT IN (SELECT thread_id FROM projection_threads)
  `;
});
