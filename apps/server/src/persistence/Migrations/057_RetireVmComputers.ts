import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The per-agent hidden browser VM is gone: agents now work in their chat
 * thread's collaborative preview browser, so an agent is ready the moment it
 * exists. Normalize every row to that world — no agent may stay parked in a
 * boot state ('provisioning'/'starting'/'stopped'/'failed') the code no longer
 * transitions out of, and no stale user-takeover flag may keep the task
 * scheduler from ever starting its runs.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE vm_agents
    SET status = 'running',
        control_mode = 'agent',
        guest_ip = NULL,
        last_error = NULL
    WHERE status != 'running' OR control_mode != 'agent'
  `;
});
