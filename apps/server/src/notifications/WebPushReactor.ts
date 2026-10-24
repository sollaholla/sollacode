import { DateTime, Effect, Layer, Option, Schema, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { EnvironmentId, OrchestrationEvent } from "@t3tools/contracts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { VmAgentWorkspace } from "../vm/VmAgentWorkspace.ts";
import { WebPush, type PushAttention } from "./WebPush.ts";

const decodeRequestPayload = Schema.decodeUnknownOption(
  Schema.Struct({ requestId: Schema.String }),
);

export function pushActionForEvent(
  event: OrchestrationEvent,
  environmentId: EnvironmentId,
): { readonly publish: PushAttention } | { readonly cancel: string } | null {
  if (event.type !== "thread.activity-appended") return null;
  const { threadId, activity } = event.payload;
  if (
    ![
      "approval.requested",
      "approval.resolved",
      "user-input.requested",
      "user-input.resolved",
    ].includes(activity.kind)
  )
    return null;
  const payload = decodeRequestPayload(activity.payload);
  if (Option.isNone(payload)) return null;
  const family = activity.kind.startsWith("approval.") ? "approval" : "input";
  const key = `${family}:${threadId}:${payload.value.requestId}`;
  if (activity.kind.endsWith(".resolved")) return { cancel: key };
  return {
    publish: {
      key,
      kind: "request",
      title: activity.summary,
      body: "Open Solla Code to review and respond.",
      path: `/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`,
      createdAt: activity.createdAt,
    },
  };
}

/** Producers only enqueue durable work; the push worker owns all network delivery. */
export const WebPushReactorLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const push = yield* WebPush;
    const workspace = yield* VmAgentWorkspace;
    const engine = yield* OrchestrationEngineService;
    const sql = yield* SqlClient.SqlClient;
    const environmentId = yield* (yield* ServerEnvironment).getEnvironmentId;
    const agentPath = (agentId: string) =>
      `/agents/${encodeURIComponent(environmentId)}/${encodeURIComponent(agentId)}`;
    const threadPath = (threadId: string) =>
      `/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;

    const captureAgentAttention = Effect.fn("WebPush.captureAgentAttention")(
      function* () {
        const cutoff = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { hours: 24 }));
        const rows = yield* sql<{
          key: string;
          kind: "agent" | "request";
          agentId: string;
          title: string;
          body: string;
          createdAt: string;
        }>`
      SELECT 'notification:' || notification_id AS key, 'agent' AS kind, vm_agent_id AS "agentId", title, body, created_at AS "createdAt"
      FROM vm_agent_notifications WHERE read_at IS NULL AND archived_at IS NULL AND created_at >= ${cutoff}
      UNION ALL
      SELECT 'blocker:' || blocker_id, 'request', vm_agent_id, title, detail, created_at
      FROM vm_agent_blockers WHERE resolved_at IS NULL AND created_at >= ${cutoff}
      ORDER BY "createdAt" DESC LIMIT 1000`;
        for (const row of rows) yield* push.publish({ ...row, path: agentPath(row.agentId) });
      },
      Effect.ignoreCause({ log: true }),
    );

    yield* Effect.acquireRelease(
      workspace.subscribeAttention(() => captureAgentAttention()),
      (unsubscribe) => Effect.sync(unsubscribe),
    );
    yield* engine.streamDomainEvents.pipe(
      Stream.runForEach(
        Effect.fn("WebPush.onEvent")(
          function* (event) {
            const action = pushActionForEvent(event, environmentId);
            if (!action) return;
            yield* "publish" in action ? push.publish(action.publish) : push.cancel(action.cancel);
          },
          Effect.ignoreCause({ log: true }),
        ),
      ),
      Effect.forkScoped,
    );

    // Catch requests that were persisted just before a restart. Older alerts are
    // excluded by each device's subscription time and the delivery dedupe key.
    const cutoff = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { hours: 24 }));
    const approvals = yield* sql<{ requestId: string; threadId: string; createdAt: string }>`
    SELECT request_id AS "requestId", thread_id AS "threadId", created_at AS "createdAt"
    FROM projection_pending_approvals WHERE status = 'pending' AND created_at >= ${cutoff}`;
    for (const row of approvals)
      yield* push.publish({
        key: `approval:${row.threadId}:${row.requestId}`,
        kind: "request",
        title: "Approval needed",
        body: "Open Solla Code to review and respond.",
        path: threadPath(row.threadId),
        createdAt: row.createdAt,
      });
    const inputs = yield* sql<{
      requestId: string;
      threadId: string;
      createdAt: string;
      title: string;
    }>`
    SELECT requestId, threadId, createdAt, title FROM (
      SELECT json_extract(a.payload_json, '$.requestId') AS requestId, a.thread_id AS threadId,
        a.created_at AS createdAt, a.summary AS title, a.kind,
        ROW_NUMBER() OVER (PARTITION BY a.thread_id, json_extract(a.payload_json, '$.requestId')
          ORDER BY a.created_at DESC, a.activity_id DESC) AS rank
      FROM projection_threads t
        -- CROSS JOIN keeps the few waiting threads as the outer loop. Joined the
        -- other way, SQLite scanned every activity of every thread: 47 s with
        -- the server blocked, at every startup (2026-10-14).
        CROSS JOIN projection_thread_activities a
          INDEXED BY idx_projection_thread_activities_thread_kind_created_id
      WHERE a.thread_id = t.thread_id
        AND t.pending_user_input_count > 0 AND a.created_at >= ${cutoff} AND json_valid(a.payload_json)
        AND json_extract(a.payload_json, '$.requestId') IS NOT NULL
        AND a.kind IN ('user-input.requested', 'user-input.resolved')
    ) WHERE rank = 1 AND kind = 'user-input.requested'`;
    for (const row of inputs)
      yield* push.publish({
        key: `input:${row.threadId}:${row.requestId}`,
        kind: "request",
        title: row.title,
        body: "Open Solla Code to review and respond.",
        path: threadPath(row.threadId),
        createdAt: row.createdAt,
      });
  }),
);
