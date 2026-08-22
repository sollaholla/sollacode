import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const LEGACY_STANDARD =
  '["orchestration:read","orchestration:operate","terminal:operate","review:write","relay:read"]';
const CUSTOM_RESTRICTED = '["orchestration:read","orchestration:operate"]';
const decodeScopes = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));

layer("052_BackfillStandardVmScope", (it) => {
  it.effect("adds VM access only to legacy standard credentials", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 51 });

      yield* sql`
        INSERT INTO auth_sessions (
          session_id, subject, scopes, method, client_device_type, issued_at, expires_at
        ) VALUES
          ('standard-session', 'browser', ${LEGACY_STANDARD}, 'browser-session-cookie', 'mobile',
           '2026-08-21T00:00:00.000Z', '2027-08-21T00:00:00.000Z'),
          ('restricted-session', 'browser', ${CUSTOM_RESTRICTED}, 'browser-session-cookie', 'mobile',
           '2026-08-21T00:00:00.000Z', '2027-08-21T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO auth_pairing_links (
          id, credential, method, scopes, subject, created_at, expires_at
        ) VALUES
          ('standard-link', 'standard-credential', 'one-time-token', ${LEGACY_STANDARD}, 'browser',
           '2026-08-21T00:00:00.000Z', '2027-08-21T00:00:00.000Z'),
          ('restricted-link', 'restricted-credential', 'one-time-token', ${CUSTOM_RESTRICTED}, 'browser',
           '2026-08-21T00:00:00.000Z', '2027-08-21T00:00:00.000Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 52 });

      const sessions = yield* sql<{ readonly id: string; readonly scopes: string }>`
        SELECT session_id AS id, scopes FROM auth_sessions ORDER BY session_id
      `;
      const links = yield* sql<{ readonly id: string; readonly scopes: string }>`
        SELECT id, scopes FROM auth_pairing_links ORDER BY id
      `;

      assert.deepStrictEqual(decodeScopes(sessions[0]?.scopes ?? "[]"), [
        "orchestration:read",
        "orchestration:operate",
      ]);
      assert.deepStrictEqual(decodeScopes(sessions[1]?.scopes ?? "[]"), [
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "review:write",
        "relay:read",
        "vm:operate",
      ]);
      assert.deepStrictEqual(decodeScopes(links[0]?.scopes ?? "[]"), [
        "orchestration:read",
        "orchestration:operate",
      ]);
      assert.deepStrictEqual(decodeScopes(links[1]?.scopes ?? "[]"), [
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "review:write",
        "relay:read",
        "vm:operate",
      ]);
    }),
  );
});
