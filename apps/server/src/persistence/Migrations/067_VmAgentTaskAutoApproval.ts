import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Agent-scheduled recurring work always required a manual approval tap, even
 * when the user had already handed the agent's chat to Agent mode. The
 * per-agent preferences row gains an auto-approval flag (default ON) that
 * VmAgentWorkspace.createTask consults together with the chat's live
 * interaction mode: a task an agent creates while its chat runs in Agent mode
 * activates immediately; every other combination keeps the draft/approval
 * flow exactly as before.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE vm_agent_notification_preferences
    ADD COLUMN auto_approve_tasks INTEGER NOT NULL DEFAULT 1
  `;
});
