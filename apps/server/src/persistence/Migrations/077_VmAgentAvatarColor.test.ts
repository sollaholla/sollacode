import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("agent color migration", (it) => {
  it.effect("backfills distinct stable colors without changing agent state", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 76 });
      yield* sql`
        INSERT INTO vm_agents (vm_agent_id, name, name_lower, handle, purpose, vm_id, status, created_at, updated_at)
        VALUES
          ('b', 'B', 'b', 'b', 'Test', 'vm-b', 'stopped', '2026-09-21T00:00:00.000Z', '2026-09-21T00:00:00.000Z'),
          ('a', 'A', 'a', 'a', 'Test', 'vm-a', 'running', '2026-09-21T00:00:00.000Z', '2026-09-21T00:00:00.000Z')
      `;
      yield* runMigrations();
      const rows =
        yield* sql`SELECT vm_agent_id, status, avatar_color_index FROM vm_agents ORDER BY vm_agent_id`;
      assert.deepStrictEqual(rows, [
        { vm_agent_id: "a", status: "running", avatar_color_index: 0 },
        { vm_agent_id: "b", status: "stopped", avatar_color_index: 1 },
      ]);
      yield* sql`DELETE FROM vm_agents WHERE vm_agent_id = 'a'`;
      yield* runMigrations();
      const again = yield* sql`SELECT avatar_color_index FROM vm_agents WHERE vm_agent_id = 'b'`;
      assert.deepStrictEqual(again, [{ avatar_color_index: 1 }]);
    }),
  );
});
