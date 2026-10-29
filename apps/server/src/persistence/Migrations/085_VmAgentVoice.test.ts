import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("agent voice migration", (it) => {
  it.effect("leaves existing agents on their automatic voice", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 84 });
      yield* sql`
        INSERT INTO vm_agents (vm_agent_id, name, name_lower, handle, purpose, vm_id, status, created_at, updated_at)
        VALUES ('a', 'A', 'a', 'a', 'Test', 'vm-a', 'running', '2026-10-28T00:00:00.000Z', '2026-10-28T00:00:00.000Z')
      `;
      yield* runMigrations();
      const rows = yield* sql`SELECT vm_agent_id, status, voice FROM vm_agents`;
      assert.deepStrictEqual(rows, [{ vm_agent_id: "a", status: "running", voice: null }]);
    }),
  );
});
