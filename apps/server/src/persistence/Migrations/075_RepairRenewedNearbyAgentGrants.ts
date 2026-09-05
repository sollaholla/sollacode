import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Renewal used the original token's scopes, undoing migration 052's agent
 * grant on legacy Nearby connections. Nearby trust always grants the standard
 * capability set. Repair that exact legacy set only when an earlier matching
 * session records the agent grant; custom and revoked credentials stay intact.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE auth_sessions AS renewed
    SET scopes = json_insert(scopes, '$[#]', 'vm:operate')
    WHERE revoked_at IS NULL
      AND method = 'bearer-access-token'
      AND subject = 'one-time-token'
      AND client_label GLOB 'Nearby Solla Code: *'
      AND json_valid(scopes)
      AND json_array_length(scopes) = 5
      AND 5 = (
        SELECT COUNT(DISTINCT value) FROM json_each(renewed.scopes)
        WHERE value IN (
          'orchestration:read', 'orchestration:operate', 'terminal:operate',
          'review:write', 'relay:read'
        )
      )
      AND EXISTS (
        SELECT 1 FROM auth_sessions AS previous
        WHERE previous.client_label = renewed.client_label
          AND previous.subject = renewed.subject
          AND previous.method = renewed.method
          AND previous.client_os IS renewed.client_os
          AND previous.revoked_at IS NULL
          AND previous.issued_at < renewed.issued_at
          AND json_valid(previous.scopes)
          AND EXISTS (
            SELECT 1 FROM json_each(previous.scopes) WHERE value = 'vm:operate'
          )
      )
  `;
});
