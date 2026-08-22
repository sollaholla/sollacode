import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Older builds marked a thread as waiting on a plan if *any* unimplemented
 * plan existed on it. That leftover is history, not a wait. Recompute the
 * denormalized flag from the latest turn only so existing rows stop lying.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_threads
    SET has_actionable_proposed_plan = COALESCE((
      SELECT CASE
        WHEN projection_threads.latest_turn_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM projection_thread_proposed_plans AS latest_turn_plan_exists
            WHERE latest_turn_plan_exists.thread_id = projection_threads.thread_id
              AND latest_turn_plan_exists.turn_id = projection_threads.latest_turn_id
          )
          THEN CASE
            WHEN (
              SELECT latest_turn_plan.implemented_at
              FROM projection_thread_proposed_plans AS latest_turn_plan
              WHERE latest_turn_plan.thread_id = projection_threads.thread_id
                AND latest_turn_plan.turn_id = projection_threads.latest_turn_id
              ORDER BY latest_turn_plan.updated_at DESC, latest_turn_plan.plan_id DESC
              LIMIT 1
            ) IS NULL
              THEN 1
              ELSE 0
            END
        ELSE 0
      END
    ), 0)
  `;
});
