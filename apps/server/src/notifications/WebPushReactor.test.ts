import { assert, it } from "@effect/vitest";
import { EnvironmentId, OrchestrationEvent } from "@t3tools/contracts";
import { DateTime, Deferred, Effect, Layer, Schema, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect } from "vite-plus/test";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { VmAgentWorkspace } from "../vm/VmAgentWorkspace.ts";
import { WebPush, type PushAttention } from "./WebPush.ts";
import { pushActionForEvent, WebPushReactorLive } from "./WebPushReactor.ts";

const environmentId = EnvironmentId.make("host");
const decodeEvent = Schema.decodeUnknownSync(OrchestrationEvent);
const makeEvent = (kind: string, payload: unknown = { requestId: "request" }) =>
  decodeEvent({
    sequence: 1,
    eventId: "event",
    type: "thread.activity-appended",
    aggregateKind: "thread",
    aggregateId: "thread",
    occurredAt: "2026-10-08T12:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId: "thread",
      activity: {
        id: "activity",
        tone: "info",
        kind,
        summary: "Approval needed",
        payload,
        turnId: null,
        createdAt: "2026-10-08T12:00:00.000Z",
      },
    },
  });

it("routes provider approvals and questions and cancels matching resolutions", () => {
  for (const [kind, family] of [
    ["approval", "approval"],
    ["user-input", "input"],
  ]) {
    expect(pushActionForEvent(makeEvent(`${kind}.requested`), environmentId)).toMatchObject({
      publish: { key: `${family}:thread:request`, kind: "request", path: "/host/thread" },
    });
    expect(pushActionForEvent(makeEvent(`${kind}.resolved`), environmentId)).toEqual({
      cancel: `${family}:thread:request`,
    });
  }
  expect(pushActionForEvent(makeEvent("tool.started"), environmentId)).toBeNull();
  expect(pushActionForEvent(makeEvent("approval.requested", {}), environmentId)).toBeNull();
});

it.effect(
  "bridges live requests and persisted unread agent alerts, blockers, and pending input",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`INSERT INTO vm_agents (vm_agent_id, name, name_lower, handle, purpose, vm_id, thread_id,
    status, control_mode, created_at, updated_at) VALUES
    ('agent', 'Agent', 'agent', 'agent', 'test', 'vm', 'agent-thread', 'running', 'agent', ${now}, ${now})`;
      yield* sql`INSERT INTO vm_agent_notifications (notification_id, vm_agent_id, kind, title, body, deep_link, dedupe_key, created_at)
    VALUES ('notice', 'agent', 'agent-message', 'Report ready', 'Read the report', '/agents/agent', 'unique-notice', ${now})`;
      yield* sql`INSERT INTO vm_agent_blockers (blocker_id, vm_agent_id, title, detail, created_at, updated_at)
    VALUES ('block', 'agent', 'Sign in', 'Open the login page', ${now}, ${now})`;
      yield* sql`INSERT INTO projection_pending_approvals (request_id, thread_id, status, created_at)
    VALUES ('pending', 'thread', 'pending', ${now}), ('resolved', 'thread', 'resolved', ${now})`;
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at, pending_user_input_count)
    VALUES ('thread', 'project', 'Thread', ${now}, ${now}, 1)`;
      yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, tone, kind, summary, payload_json, created_at)
    VALUES ('input', 'thread', 'info', 'user-input.requested', 'Choose an option', '{"requestId":"question"}', ${now})`;
      const published: PushAttention[] = [];
      const cancelled: string[] = [];
      const liveDone = yield* Deferred.make<void>();
      let attention: Effect.Effect<void> = Effect.void;
      yield* Layer.build(
        WebPushReactorLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(WebPush)({
                publish: (value) =>
                  Effect.sync(() => {
                    published.push(value);
                  }),
                cancel: (key) =>
                  Effect.sync(() => {
                    cancelled.push(key);
                  }).pipe(Effect.andThen(Deferred.succeed(liveDone, undefined))),
              }),
              Layer.mock(VmAgentWorkspace)({
                subscribeAttention: (listener) =>
                  Effect.gen(function* () {
                    attention = listener({ type: "snapshot", agents: [] });
                    yield* attention;
                    return () => {};
                  }),
              }),
              Layer.mock(OrchestrationEngineService)({
                streamDomainEvents: Stream.make(
                  makeEvent("approval.requested"),
                  makeEvent("approval.resolved"),
                ),
              }),
              Layer.mock(ServerEnvironment)({ getEnvironmentId: Effect.succeed(environmentId) }),
            ),
          ),
        ),
      );
      yield* Deferred.await(liveDone);
      assert.sameMembers(
        published.map((value) => value.key),
        [
          "notification:notice",
          "blocker:block",
          "approval:thread:pending",
          "input:thread:question",
          "approval:thread:request",
        ],
      );
      assert.sameMembers(cancelled, ["approval:thread:request"]);
      assert.strictEqual(published.find((value) => value.key === "blocker:block")?.kind, "request");
      assert.strictEqual(
        published.find((value) => value.key === "notification:notice")?.path,
        "/agents/host/agent",
      );
      published.length = 0;
      yield* sql`UPDATE vm_agent_notifications SET read_at = ${now}`;
      yield* sql`UPDATE vm_agent_blockers SET resolved_at = ${now}`;
      yield* attention;
      assert.strictEqual(published.length, 0);
    }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);
