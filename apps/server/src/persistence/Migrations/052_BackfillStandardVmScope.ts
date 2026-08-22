import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * VM agents joined the standard client capability set after scoped sessions
 * shipped. Preserve deliberately restricted credentials, but extend the exact
 * legacy standard (and administrative superset) so existing paired browsers
 * and phones can use the host's Agent Stack without pairing again.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE auth_sessions
    SET scopes = json_insert(scopes, '$[#]', 'vm:operate')
    WHERE json_valid(scopes)
      AND NOT EXISTS (
        SELECT 1 FROM json_each(auth_sessions.scopes)
        WHERE value = 'vm:operate'
      )
      AND 5 = (
        SELECT COUNT(DISTINCT value) FROM json_each(auth_sessions.scopes)
        WHERE value IN (
          'orchestration:read',
          'orchestration:operate',
          'terminal:operate',
          'review:write',
          'relay:read'
        )
      )
  `;

  yield* sql`
    UPDATE auth_pairing_links
    SET scopes = json_insert(scopes, '$[#]', 'vm:operate')
    WHERE json_valid(scopes)
      AND NOT EXISTS (
        SELECT 1 FROM json_each(auth_pairing_links.scopes)
        WHERE value = 'vm:operate'
      )
      AND 5 = (
        SELECT COUNT(DISTINCT value) FROM json_each(auth_pairing_links.scopes)
        WHERE value IN (
          'orchestration:read',
          'orchestration:operate',
          'terminal:operate',
          'review:write',
          'relay:read'
        )
      )
  `;
});
