import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Settles plans that were answered without the Implement button.
 *
 * Until now only the two Implement buttons ever marked a plan, so a plan the
 * person approved by typing "go ahead" in Build or Agent, or by switching
 * modes and continuing, stayed open forever and came back as the plan to
 * approve whenever the thread returned to Plan mode (2026-10-10: an ARCore
 * plan built on Oct 6 resurfaced as "Plan Ready" during an unrelated security
 * audit). The decider now records such a message as implementing the waiting
 * plan; this replays that rule over history, then recomputes the shell flag
 * under the shared rule (`@t3tools/shared/proposedPlans`): a thread waits on
 * its newest plan while that plan is neither implemented nor closed.
 *
 * A plan counts as implemented by the first Build or Agent message a person
 * sent while it was the thread's newest plan, so a plan replaced by a newer
 * proposal first still reads as superseded. As in the decider, housekeeping,
 * resume prompts, delegated runs and other agents' questions are not the
 * person (the orchestrator relaying them is). Turns that named their own plan
 * already marked it at runtime. `closed_at` is new: set from now on when the
 * person implements a different plan instead of the waiting one. The
 * turn-start lookup rides idx_orch_events_turn_start_message (migration 072).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE projection_thread_proposed_plans ADD COLUMN closed_at TEXT`;

  // Thread detail snapshots look up the plan a thread is implementing; only
  // implementation turns carry one, so the partial index stays tiny.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turns_source_proposed_plan
    ON projection_turns(thread_id, requested_at, row_id)
    WHERE source_proposed_plan_id IS NOT NULL
  `;

  yield* sql`
    UPDATE projection_thread_proposed_plans
    SET implemented_at = (
      SELECT MIN(events.occurred_at)
      FROM orchestration_events AS events
      LEFT JOIN projection_thread_messages AS message
        ON message.thread_id = events.stream_id
        AND message.message_id = json_extract(events.payload_json, '$.messageId')
      WHERE events.aggregate_kind = 'thread'
        AND events.event_type = 'thread.turn-start-requested'
        AND events.stream_id = projection_thread_proposed_plans.thread_id
        AND events.occurred_at > projection_thread_proposed_plans.created_at
        AND events.occurred_at < COALESCE(
          (
            SELECT MIN(newer.created_at)
            FROM projection_thread_proposed_plans AS newer
            WHERE newer.thread_id = projection_thread_proposed_plans.thread_id
              AND newer.created_at > projection_thread_proposed_plans.created_at
          ),
          '9999-12-31T23:59:59.999Z'
        )
        AND COALESCE(json_extract(events.payload_json, '$.interactionMode'), 'default') <> 'plan'
        AND json_extract(events.payload_json, '$.sourceProposedPlan') IS NULL
        AND COALESCE(message.input_origin, '') <> 'agent-loop'
        AND message.delegation_id IS NULL
        AND COALESCE(message.sender_thread_id, 'solla-orchestrator') = 'solla-orchestrator'
        AND COALESCE(message.text, '') NOT IN (
          'Please resume your current task using the context provided and pick up exactly where you left off.',
          'resume'
        )
    )
    WHERE implemented_at IS NULL
  `;

  yield* sql`
    UPDATE projection_thread_proposed_plans
    SET implementation_thread_id = thread_id
    WHERE implemented_at IS NOT NULL
      AND implementation_thread_id IS NULL
  `;

  yield* sql`
    UPDATE projection_threads
    SET has_actionable_proposed_plan = COALESCE((
      SELECT CASE
        WHEN newest.implemented_at IS NULL AND newest.closed_at IS NULL THEN 1
        ELSE 0
      END
      FROM projection_thread_proposed_plans AS newest
      WHERE newest.thread_id = projection_threads.thread_id
      ORDER BY newest.created_at DESC, newest.plan_id DESC
      LIMIT 1
    ), 0)
  `;
});
