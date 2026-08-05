import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("039_RestorePromotedSideChats", (it) => {
  it.effect("restores only side chats explicitly promoted after their latest deletion", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 38 });

      for (const threadId of ["promoted-side-chat", "closed-side-chat", "deleted-normal-thread"]) {
        yield* sql`
          INSERT INTO projection_threads (
            thread_id,
            project_id,
            title,
            is_side_chat,
            side_chat_parent_thread_id,
            model_selection_json,
            runtime_mode,
            interaction_mode,
            branch,
            worktree_path,
            latest_turn_id,
            created_at,
            updated_at,
            archived_at,
            latest_user_message_at,
            pending_approval_count,
            pending_user_input_count,
            has_actionable_proposed_plan,
            deleted_at
          )
          VALUES (
            ${threadId},
            'project-1',
            ${threadId},
            0,
            NULL,
            '{"instanceId":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-08-03T00:00:00.000Z',
            '2026-08-03T00:00:03.000Z',
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-08-03T00:00:02.000Z'
          )
        `;
      }

      const appendEvent = (input: {
        readonly eventId: string;
        readonly streamId: string;
        readonly streamVersion: number;
        readonly type: string;
        readonly occurredAt: string;
        readonly payloadJson: string;
      }) => sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          ${input.eventId},
          'thread',
          ${input.streamId},
          ${input.streamVersion},
          ${input.type},
          ${input.occurredAt},
          NULL,
          NULL,
          NULL,
          'user',
          ${input.payloadJson},
          '{}'
        )
      `;

      yield* appendEvent({
        eventId: "fork-promoted",
        streamId: "promoted-side-chat",
        streamVersion: 1,
        type: "thread.forked",
        occurredAt: "2026-08-03T00:00:00.000Z",
        payloadJson: '{"isSideChat":true}',
      });
      yield* appendEvent({
        eventId: "delete-promoted",
        streamId: "promoted-side-chat",
        streamVersion: 2,
        type: "thread.deleted",
        occurredAt: "2026-08-03T00:00:01.000Z",
        payloadJson: "{}",
      });
      yield* appendEvent({
        eventId: "promote-promoted",
        streamId: "promoted-side-chat",
        streamVersion: 3,
        type: "thread.meta-updated",
        occurredAt: "2026-08-03T00:00:02.000Z",
        payloadJson: '{"isSideChat":false}',
      });
      yield* appendEvent({
        eventId: "fork-closed",
        streamId: "closed-side-chat",
        streamVersion: 1,
        type: "thread.forked",
        occurredAt: "2026-08-03T00:00:00.000Z",
        payloadJson: '{"isSideChat":true}',
      });
      yield* appendEvent({
        eventId: "delete-closed",
        streamId: "closed-side-chat",
        streamVersion: 2,
        type: "thread.deleted",
        occurredAt: "2026-08-03T00:00:01.000Z",
        payloadJson: "{}",
      });
      yield* appendEvent({
        eventId: "promote-normal",
        streamId: "deleted-normal-thread",
        streamVersion: 1,
        type: "thread.meta-updated",
        occurredAt: "2026-08-03T00:00:02.000Z",
        payloadJson: '{"isSideChat":false}',
      });

      yield* runMigrations({ toMigrationInclusive: 39 });

      const rows = yield* sql<{ readonly threadId: string; readonly deletedAt: string | null }>`
        SELECT thread_id AS "threadId", deleted_at AS "deletedAt"
        FROM projection_threads
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(rows, [
        { threadId: "closed-side-chat", deletedAt: "2026-08-03T00:00:02.000Z" },
        { threadId: "deleted-normal-thread", deletedAt: "2026-08-03T00:00:02.000Z" },
        { threadId: "promoted-side-chat", deletedAt: null },
      ]);
    }),
  );
});
