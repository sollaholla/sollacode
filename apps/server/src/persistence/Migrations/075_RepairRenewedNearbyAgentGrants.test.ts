import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import repairRenewedNearbyAgentGrants from "./075_RepairRenewedNearbyAgentGrants.ts";

const legacyScopes = [
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "review:write",
  "relay:read",
];
const currentScopes = [...legacyScopes, "vm:operate"];
const encodeScopes = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

it.layer(NodeSqliteClient.layerMemory())("075_RepairRenewedNearbyAgentGrants", (it) => {
  it.effect("repairs renewed Nearby grants without expanding custom or revoked credentials", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 74 });
      const label = "Nearby Solla Code: Windows";
      const revokedAt = "2026-09-04T00:00:00.000Z";
      const cases = [
        { id: "renewed", label, os: "Win32", scopes: legacyScopes, revokedAt: null },
        { id: "current", label, os: "Win32", scopes: currentScopes, revokedAt: null },
        { id: "revoked", label, os: "Win32", scopes: legacyScopes, revokedAt },
        { id: "restricted", label, os: "Win32", scopes: ["orchestration:read"], revokedAt: null },
        {
          id: "manual",
          label: "Custom desktop",
          os: "Win32",
          scopes: legacyScopes,
          revokedAt: null,
        },
        { id: "different-device", label, os: "Linux", scopes: legacyScopes, revokedAt: null },
        {
          id: "no-previous-grant",
          label: "Nearby Solla Code: New",
          os: "Win32",
          scopes: legacyScopes,
          revokedAt: null,
        },
        {
          id: "revoked-previous-grant",
          label: "Nearby Solla Code: Revoked",
          os: "Win32",
          scopes: legacyScopes,
          revokedAt: null,
        },
      ];
      for (const previous of [
        { id: "previous", label, revokedAt: null },
        { id: "previous-revoked", label: "Nearby Solla Code: Revoked", revokedAt },
      ]) {
        yield* sql`
          INSERT INTO auth_sessions (
            session_id, subject, scopes, method, client_label, client_os, issued_at, expires_at, revoked_at
          ) VALUES (
            ${previous.id}, 'one-time-token', ${encodeScopes(currentScopes)}, 'bearer-access-token',
            ${previous.label}, 'Win32', '2026-08-02T00:00:00.000Z', '2026-09-01T00:00:00.000Z', ${previous.revokedAt}
          )
        `;
      }
      for (const row of cases) {
        yield* sql`
          INSERT INTO auth_sessions (
            session_id, subject, scopes, method, client_label, client_os, issued_at, expires_at, revoked_at
          ) VALUES (
            ${row.id}, 'one-time-token', ${encodeScopes(row.scopes)}, 'bearer-access-token',
            ${row.label}, ${row.os}, '2026-09-01T20:53:14.731Z', '2027-09-01T20:53:14.731Z', ${row.revokedAt}
          )
        `;
      }

      yield* runMigrations({ toMigrationInclusive: 75 });
      yield* repairRenewedNearbyAgentGrants;
      for (const expected of cases) {
        const rows = yield* sql<{ readonly scopes: string; readonly revoked_at: string | null }>`
          SELECT scopes, revoked_at FROM auth_sessions WHERE session_id = ${expected.id}
        `;
        assert.strictEqual(
          rows[0]?.scopes,
          encodeScopes(expected.id === "renewed" ? currentScopes : expected.scopes),
        );
        assert.strictEqual(rows[0]?.revoked_at, expected.revokedAt);
      }
    }),
  );
});
