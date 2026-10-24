import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE web_push_subscriptions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES auth_sessions(session_id) ON DELETE CASCADE,
    subscription_json TEXT NOT NULL,
    preferences_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX web_push_subscriptions_session ON web_push_subscriptions(session_id)`;
  yield* sql`CREATE TABLE web_push_deliveries (
    subscription_id TEXT NOT NULL REFERENCES web_push_subscriptions(id) ON DELETE CASCADE,
    event_key TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    settled_at TEXT,
    PRIMARY KEY (subscription_id, event_key)
  )`;
  yield* sql`CREATE INDEX web_push_deliveries_pending ON web_push_deliveries(next_attempt_at)
    WHERE settled_at IS NULL`;
});
