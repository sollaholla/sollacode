import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("073_VmAgentIcon", (it) => {
  it.effect("adds a nullable icon column; existing agents read back as unchosen", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-02T12:00:00.000Z";

      yield* runMigrations({ toMigrationInclusive: 72 });
      yield* sql`
        INSERT INTO vm_agents (
          vm_agent_id, name, name_lower, handle, purpose, vm_id, status,
          control_mode, guest_ip, last_error, created_at, updated_at, thread_id
        ) VALUES (
          'agent-icon', 'Open World', 'open world', 'open-world', 'Test', 'vm-icon',
          'running', 'agent', NULL, NULL, ${now}, ${now}, 'thread-icon'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 73 });

      const before = yield* sql<{ readonly icon: string | null }>`
        SELECT icon FROM vm_agents WHERE vm_agent_id = 'agent-icon'
      `;
      assert.strictEqual(before.length, 1);
      assert.strictEqual(before[0]?.icon, null);

      yield* sql`UPDATE vm_agents SET icon = 'globe' WHERE vm_agent_id = 'agent-icon'`;
      const after = yield* sql<{ readonly icon: string | null }>`
        SELECT icon FROM vm_agents WHERE vm_agent_id = 'agent-icon'
      `;
      assert.strictEqual(after[0]?.icon, "globe");
    }),
  );
});
