import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * How much conversation history each thread keeps in this database, for the
 * project statistics in Settings.
 *
 * Summing payload sizes on demand reads every byte: 3 GB of activity history
 * took 20 seconds cold. Triggers keep the counts exact on every write instead,
 * at the cost of one small upsert. The backfill below is the one full read,
 * done once, during this upgrade.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE projection_thread_storage (
      thread_id TEXT PRIMARY KEY,
      activity_count INTEGER NOT NULL DEFAULT 0,
      activity_bytes INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      message_bytes INTEGER NOT NULL DEFAULT 0
    )
  `;

  yield* sql`
    CREATE TRIGGER projection_thread_storage_activity_insert
    AFTER INSERT ON projection_thread_activities
    BEGIN
      INSERT INTO projection_thread_storage (thread_id, activity_count, activity_bytes)
      VALUES (NEW.thread_id, 1, octet_length(NEW.payload_json) + octet_length(NEW.summary))
      ON CONFLICT (thread_id) DO UPDATE SET
        activity_count = activity_count + 1,
        activity_bytes = activity_bytes + excluded.activity_bytes;
    END
  `;
  yield* sql`
    CREATE TRIGGER projection_thread_storage_activity_update
    AFTER UPDATE OF thread_id, payload_json, summary ON projection_thread_activities
    BEGIN
      UPDATE projection_thread_storage
      SET
        activity_count = activity_count - 1,
        activity_bytes = activity_bytes - (octet_length(OLD.payload_json) + octet_length(OLD.summary))
      WHERE thread_id = OLD.thread_id;
      INSERT INTO projection_thread_storage (thread_id, activity_count, activity_bytes)
      VALUES (NEW.thread_id, 1, octet_length(NEW.payload_json) + octet_length(NEW.summary))
      ON CONFLICT (thread_id) DO UPDATE SET
        activity_count = activity_count + 1,
        activity_bytes = activity_bytes + excluded.activity_bytes;
    END
  `;
  yield* sql`
    CREATE TRIGGER projection_thread_storage_activity_delete
    AFTER DELETE ON projection_thread_activities
    BEGIN
      UPDATE projection_thread_storage
      SET
        activity_count = activity_count - 1,
        activity_bytes = activity_bytes - (octet_length(OLD.payload_json) + octet_length(OLD.summary))
      WHERE thread_id = OLD.thread_id;
    END
  `;

  yield* sql`
    CREATE TRIGGER projection_thread_storage_message_insert
    AFTER INSERT ON projection_thread_messages
    BEGIN
      INSERT INTO projection_thread_storage (thread_id, message_count, message_bytes)
      VALUES (
        NEW.thread_id,
        1,
        octet_length(NEW.text) + COALESCE(octet_length(NEW.attachments_json), 0)
      )
      ON CONFLICT (thread_id) DO UPDATE SET
        message_count = message_count + 1,
        message_bytes = message_bytes + excluded.message_bytes;
    END
  `;
  yield* sql`
    CREATE TRIGGER projection_thread_storage_message_update
    AFTER UPDATE OF thread_id, text, attachments_json ON projection_thread_messages
    BEGIN
      UPDATE projection_thread_storage
      SET
        message_count = message_count - 1,
        message_bytes = message_bytes
          - (octet_length(OLD.text) + COALESCE(octet_length(OLD.attachments_json), 0))
      WHERE thread_id = OLD.thread_id;
      INSERT INTO projection_thread_storage (thread_id, message_count, message_bytes)
      VALUES (
        NEW.thread_id,
        1,
        octet_length(NEW.text) + COALESCE(octet_length(NEW.attachments_json), 0)
      )
      ON CONFLICT (thread_id) DO UPDATE SET
        message_count = message_count + 1,
        message_bytes = message_bytes + excluded.message_bytes;
    END
  `;
  yield* sql`
    CREATE TRIGGER projection_thread_storage_message_delete
    AFTER DELETE ON projection_thread_messages
    BEGIN
      UPDATE projection_thread_storage
      SET
        message_count = message_count - 1,
        message_bytes = message_bytes
          - (octet_length(OLD.text) + COALESCE(octet_length(OLD.attachments_json), 0))
      WHERE thread_id = OLD.thread_id;
    END
  `;

  yield* sql`
    INSERT INTO projection_thread_storage (thread_id, activity_count, activity_bytes)
    SELECT thread_id, COUNT(*), SUM(octet_length(payload_json) + octet_length(summary))
    FROM projection_thread_activities
    GROUP BY thread_id
  `;
  yield* sql`
    INSERT INTO projection_thread_storage (thread_id, message_count, message_bytes)
    SELECT
      thread_id,
      COUNT(*),
      SUM(octet_length(text) + COALESCE(octet_length(attachments_json), 0))
    FROM projection_thread_messages
    WHERE true
    GROUP BY thread_id
    ON CONFLICT (thread_id) DO UPDATE SET
      message_count = excluded.message_count,
      message_bytes = excluded.message_bytes
  `;
});
