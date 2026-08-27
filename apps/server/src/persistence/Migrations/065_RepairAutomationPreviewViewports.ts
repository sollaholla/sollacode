import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Automation-created tabs were silently rewritten from fill mode to an exact
 * 1280x800 freeform viewport. That presentation-only default became durable
 * and made existing pages return clipped or scaled after switching threads.
 * The exact freeform fingerprint is repaired once; explicit presets and every
 * other custom size remain untouched.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE preview_sessions
    SET snapshot_json = json_set(snapshot_json, '$.viewport', json('{"_tag":"fill"}'))
    WHERE json_valid(snapshot_json)
      AND json_extract(snapshot_json, '$.viewport._tag') = 'freeform'
      AND json_extract(snapshot_json, '$.viewport.width') = 1280
      AND json_extract(snapshot_json, '$.viewport.height') = 800
  `;
});
