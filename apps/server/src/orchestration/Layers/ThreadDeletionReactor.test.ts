import { CommandId, EventId, type OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { purgeDeletedThreadPersistence } from "../../persistence/DeletedThreadPersistence.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";

import {
  logCleanupCauseUnlessInterrupted,
  makeThreadDeletionWorker,
} from "./ThreadDeletionReactor.ts";

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });

  it.effect("drains queued deleted-thread cleanup without sleeps", () =>
    Effect.gen(function* () {
      const processed: string[] = [];
      const worker = yield* makeThreadDeletionWorker((event) =>
        Effect.sync(() => {
          processed.push(event.payload.threadId);
        }),
      );
      const event = {
        sequence: 1,
        type: "thread.deleted",
        eventId: EventId.make("event-artifact-cleanup"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-08-21T00:00:00.000Z",
        commandId: CommandId.make("command-artifact-cleanup"),
        causationEventId: null,
        correlationId: CommandId.make("command-artifact-cleanup"),
        metadata: {},
        payload: {
          threadId,
          deletedAt: "2026-08-21T00:00:00.000Z",
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.deleted" }>;

      yield* worker.enqueue(event);
      yield* worker.drain;
      expect(processed).toEqual([threadId]);
    }),
  );
});

it.layer(SqlitePersistenceMemory)("purgeDeletedThreadPersistence", (it) => {
  it.effect("removes deleted conversation data but retains its synchronization tombstone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-persisted-delete");
      const deleteCommandId = CommandId.make("command-delete-thread-persisted");
      const createdCommandId = CommandId.make("command-create-thread-persisted");
      const now = "2026-08-25T12:00:00.000Z";

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES ('project-persisted-delete', 'Project', '/tmp/project', '[]', ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, created_at, updated_at, deleted_at
        ) VALUES (
          ${threadId}, 'project-persisted-delete', 'Deleted thread', ${now}, ${now}, ${now}
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES ('message-persisted-delete', ${threadId}, 'user', 'large private payload', 0, ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, tone, kind, summary, payload_json, created_at
        ) VALUES (
          'activity-persisted-delete', ${threadId}, 'tool', 'tool-result', 'result',
          '{"large":"payload"}', ${now}
        )
      `;
      yield* sql`
        INSERT INTO preview_sessions (thread_id, tab_id, snapshot_json, updated_at)
        VALUES (${threadId}, 'tab-persisted-delete', '{"_tag":"Idle","url":""}', ${now})
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, actor_kind, payload_json, metadata_json
        ) VALUES
          (
            'event-thread-created-persisted', 'thread', ${threadId}, 0, 'thread.created',
            ${now}, ${createdCommandId}, 'client', '{"private":"history"}', '{}'
          ),
          (
            'event-thread-deleted-persisted', 'thread', ${threadId}, 1, 'thread.deleted',
            ${now}, ${deleteCommandId}, 'client',
            '{"threadId":"thread-persisted-delete","deletedAt":"2026-08-25T12:00:00.000Z"}', '{}'
          )
      `;
      yield* sql`
        INSERT INTO orchestration_command_receipts (
          command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status
        )
        SELECT ${createdCommandId}, 'thread', ${threadId}, ${now}, sequence, 'accepted'
        FROM orchestration_events WHERE event_id = 'event-thread-created-persisted'
      `;
      yield* sql`
        INSERT INTO orchestration_command_receipts (
          command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status
        )
        SELECT ${deleteCommandId}, 'thread', ${threadId}, ${now}, sequence, 'accepted'
        FROM orchestration_events WHERE event_id = 'event-thread-deleted-persisted'
      `;

      yield* purgeDeletedThreadPersistence(threadId);

      const counts = yield* sql<{
        readonly threads: number;
        readonly messages: number;
        readonly activities: number;
        readonly previews: number;
        readonly events: number;
        readonly receipts: number;
      }>`
        SELECT
          (SELECT COUNT(*) FROM projection_threads WHERE thread_id = ${threadId}) AS threads,
          (SELECT COUNT(*) FROM projection_thread_messages WHERE thread_id = ${threadId}) AS messages,
          (SELECT COUNT(*) FROM projection_thread_activities WHERE thread_id = ${threadId}) AS activities,
          (SELECT COUNT(*) FROM preview_sessions WHERE thread_id = ${threadId}) AS previews,
          (
            SELECT COUNT(*) FROM orchestration_events
            WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
          ) AS events,
          (
            SELECT COUNT(*) FROM orchestration_command_receipts
            WHERE aggregate_kind = 'thread' AND aggregate_id = ${threadId}
          ) AS receipts
      `;
      expect(counts).toEqual([
        { threads: 0, messages: 0, activities: 0, previews: 0, events: 1, receipts: 1 },
      ]);

      const tombstones = yield* sql<{ readonly eventType: string; readonly commandId: string }>`
        SELECT event_type AS "eventType", command_id AS "commandId"
        FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
      `;
      expect(tombstones).toEqual([{ eventType: "thread.deleted", commandId: deleteCommandId }]);
    }),
  );
});
