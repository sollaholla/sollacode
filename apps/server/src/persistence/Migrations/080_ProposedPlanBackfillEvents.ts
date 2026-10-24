import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Publishes migration 079's backfill as events.
 *
 * 079 marked answered plans implemented by editing the projection. A fresh
 * snapshot shows that, but a client resuming its cached thread from
 * `afterSequence` replays only events, so it never heard: once plans waited in
 * every mode, a phone showed a plan built hours earlier as Plan Ready again
 * (2026-10-10, thread ce637fdb). The event log is also what any projection
 * rebuild replays, so the backfill belongs there.
 *
 * Every plan whose implemented or closed state no event ever carried gets one
 * `thread.proposed-plan-upserted` at the end of its thread's stream, carrying
 * the projection's plan. Projectors apply it as the no-op upsert it is, and
 * resuming clients receive it in catch-up.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const unpublished = yield* sql<{ readonly planId: string }>`
    SELECT plans.plan_id AS "planId"
    FROM projection_thread_proposed_plans AS plans
    JOIN projection_threads AS threads ON threads.thread_id = plans.thread_id
    WHERE threads.deleted_at IS NULL
      AND (plans.implemented_at IS NOT NULL OR plans.closed_at IS NOT NULL)
      AND NOT EXISTS (
        SELECT 1
        FROM orchestration_events AS events
        WHERE events.aggregate_kind = 'thread'
          AND events.stream_id = plans.thread_id
          AND events.event_type = 'thread.proposed-plan-upserted'
          AND json_extract(events.payload_json, '$.proposedPlan.id') = plans.plan_id
          AND json_extract(events.payload_json, '$.proposedPlan.implementedAt')
            IS plans.implemented_at
          AND json_extract(events.payload_json, '$.proposedPlan.closedAt') IS plans.closed_at
      )
    ORDER BY plans.thread_id, plans.created_at, plans.plan_id
  `;

  // One insert per plan, so each sees the stream version the previous took.
  for (const { planId } of unpublished) {
    const eventId = `migration-080:${planId}`;
    yield* sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
      )
      SELECT
        ${eventId},
        'thread',
        plans.thread_id,
        (
          SELECT COALESCE(MAX(stream_version), 0) + 1
          FROM orchestration_events
          WHERE aggregate_kind = 'thread' AND stream_id = plans.thread_id
        ),
        'thread.proposed-plan-upserted',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        ${eventId},
        NULL,
        ${eventId},
        'server',
        json_object(
          'threadId', plans.thread_id,
          'proposedPlan', json_object(
            'id', plans.plan_id,
            'turnId', plans.turn_id,
            'planMarkdown', plans.plan_markdown,
            'implementedAt', plans.implemented_at,
            'implementationThreadId', plans.implementation_thread_id,
            'closedAt', plans.closed_at,
            'createdAt', plans.created_at,
            'updatedAt', plans.updated_at
          )
        ),
        '{}'
      FROM projection_thread_proposed_plans AS plans
      WHERE plans.plan_id = ${planId}
    `;
  }
});
