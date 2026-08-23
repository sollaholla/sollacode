import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Retires one-time tasks that were left active with nothing to run at.
 *
 * Claiming a one-time occurrence clears `next_run_at`, because there is no
 * later occurrence to point at. Until now, a claimed run that then failed left
 * the task exactly there: `active`, with a null `next_run_at` that the due
 * query requires to be set. Such a task can never be claimed again and never
 * reaches a terminal status, so it sits in the workspace forever announcing
 * work that will never happen.
 *
 * The scheduler now either re-arms or retires these as the run settles. This
 * clears the ones already stranded, which no amount of running the fixed code
 * would reach.
 *
 * They are retired rather than re-armed on purpose. Re-arming would make an
 * app update dispatch real agent work — a prompt written for a moment that has
 * since passed — the first time the scheduler drained after installing it.
 * Retiring states the truth: it did not run, and it is not going to.
 *
 * Only `once`. A task with no schedule legitimately sits active with a null
 * `next_run_at` between manual runs.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE vm_agent_tasks
    SET status = 'completed',
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE status = 'active'
      AND next_run_at IS NULL
      AND json_valid(schedule_json)
      AND json_extract(schedule_json, '$.kind') = 'once'
  `;
});
