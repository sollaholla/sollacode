import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A user-input answer that failed with "No active provider session is bound
 * to this thread." used to leave its request counted as pending forever: the
 * failure detail was not in the pending recompute's stale/unknown list, and
 * nothing later resolves a request whose session is already gone — the
 * re-ask, when one happens, uses a fresh requestId. Observed 2026-08-29 as an
 * agent's sidebar badge stuck on "Waiting for your input" long after its
 * re-asked question had been answered.
 *
 * The recompute predicate now treats that failure as settling its request
 * (ProjectionPipeline.refreshPendingUserInputSummary, with the reactor also
 * delivering such answers as plain user messages so new occurrences resolve
 * outright). This repairs the rows written before either fix, by re-running
 * the same recompute for every thread currently flagged. The predicate only
 * shrinks the pending set, so unflagged threads cannot need repair.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_threads
    SET pending_user_input_count = COALESCE((
      WITH latest_user_input_states AS (
        SELECT
          latest.kind
        FROM (
          SELECT
            activity.kind,
            ROW_NUMBER() OVER (
              PARTITION BY json_extract(activity.payload_json, '$.requestId')
              ORDER BY activity.created_at DESC, activity.activity_id DESC
            ) AS row_number
          FROM projection_thread_activities AS activity
          WHERE activity.thread_id = projection_threads.thread_id
            AND json_valid(activity.payload_json)
            AND json_extract(activity.payload_json, '$.requestId') IS NOT NULL
            AND (
              activity.kind IN ('user-input.requested', 'user-input.resolved')
              OR (
                activity.kind = 'provider.user-input.respond.failed'
                AND (
                  lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                    LIKE '%stale pending user-input request%'
                  OR lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                    LIKE '%unknown pending user-input request%'
                  OR lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                    LIKE '%unknown pending user input request%'
                  OR lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                    LIKE '%unknown pending codex user input request%'
                  OR lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                    LIKE '%no active provider session is bound%'
                )
              )
            )
        ) AS latest
        WHERE latest.row_number = 1
      )
      SELECT COUNT(*)
      FROM latest_user_input_states
      WHERE latest_user_input_states.kind = 'user-input.requested'
    ), 0)
    WHERE pending_user_input_count > 0
  `;
});
