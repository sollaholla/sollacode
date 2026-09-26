import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Persist color identity so creation, deletion and renaming never recolor other agents. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE vm_agents ADD COLUMN avatar_color_index INTEGER CHECK (avatar_color_index >= 0)`;
  yield* sql`
    WITH colors AS (
      SELECT vm_agent_id, ROW_NUMBER() OVER (ORDER BY created_at, vm_agent_id) - 1 AS color_index
      FROM vm_agents
    )
    UPDATE vm_agents SET avatar_color_index = (
      SELECT color_index FROM colors WHERE colors.vm_agent_id = vm_agents.vm_agent_id
    )
  `;
  yield* sql`CREATE UNIQUE INDEX idx_vm_agents_avatar_color ON vm_agents(avatar_color_index)`;
});
