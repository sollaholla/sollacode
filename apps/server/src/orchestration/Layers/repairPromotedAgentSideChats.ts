import { AGENTS_PROJECT_ID } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Reattach agent side chats that old clients promoted into the hidden agents project. */
export const repairPromotedAgentSideChats = Effect.fn("repairPromotedAgentSideChats")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const candidates = yield* sql<{ threadId: string }>`
    SELECT thread_id AS "threadId" FROM projection_threads
    WHERE project_id = ${AGENTS_PROJECT_ID} AND is_side_chat = 0
      AND side_chat_parent_thread_id IS NULL AND deleted_at IS NULL AND archived_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM vm_agents WHERE vm_agents.thread_id = projection_threads.thread_id)
  `;
  for (const { threadId } of candidates) {
    // Keep the full indexed stream prefix: the event log can contain millions of rows.
    const forks = yield* sql<{ parentThreadId: string | null }>`
      SELECT CASE WHEN json_extract(payload_json, '$.isSideChat') = 1
        AND json_extract(payload_json, '$.projectId') = ${AGENTS_PROJECT_ID}
        THEN json_extract(payload_json, '$.sideChatParentThreadId') END AS "parentThreadId"
      FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id = ${threadId} AND event_type = 'thread.forked'
      ORDER BY sequence ASC LIMIT 1
    `;
    const parentThreadId = forks[0]?.parentThreadId;
    if (!parentThreadId || parentThreadId === threadId) continue;
    yield* sql`
      UPDATE projection_threads SET is_side_chat = 1, side_chat_parent_thread_id = ${parentThreadId}
      WHERE thread_id = ${threadId} AND project_id = ${AGENTS_PROJECT_ID} AND is_side_chat = 0
        AND side_chat_parent_thread_id IS NULL AND deleted_at IS NULL AND archived_at IS NULL
        AND EXISTS (SELECT 1 FROM projection_threads parent
          JOIN vm_agents agent ON agent.thread_id = parent.thread_id
          WHERE parent.thread_id = ${parentThreadId} AND parent.project_id = ${AGENTS_PROJECT_ID}
            AND parent.is_side_chat = 0 AND parent.deleted_at IS NULL)
    `;
  }
});
