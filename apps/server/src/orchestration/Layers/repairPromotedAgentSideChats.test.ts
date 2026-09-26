import { AGENTS_PROJECT_ID } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { repairPromotedAgentSideChats } from "./repairPromotedAgentSideChats.ts";

const encodeJson = Schema.encodeEffect(Schema.UnknownFromJsonString);

it.layer(SqlitePersistenceMemory)("repair promoted agent side chats", (it) => {
  it.effect("reattaches only hidden former agent side chats and is idempotent across replay", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const time = "2026-09-15T00:00:00.000Z";
      const cases = [
        "recover",
        "ordinary",
        "archived",
        "deleted",
        "registered",
        "not-side-chat",
        "no-fork",
        "missing-parent",
        "deleted-parent",
      ];
      for (const id of ["parent", "deleted-parent-root", ...cases]) {
        yield* sql`INSERT INTO projection_threads
          (thread_id, project_id, title, created_at, updated_at, is_side_chat, archived_at, deleted_at)
          VALUES (${id}, ${id === "ordinary" ? "normal-project" : AGENTS_PROJECT_ID}, ${id}, ${time}, ${time}, 0,
            ${id === "archived" ? time : null}, ${id === "deleted" || id === "deleted-parent-root" ? time : null})`;
      }
      for (const id of ["parent", "registered", "deleted-parent-root"]) {
        yield* sql`INSERT INTO vm_agents
          (vm_agent_id, name, name_lower, handle, purpose, vm_id, status, thread_id, created_at, updated_at)
          VALUES (${id}, ${id}, ${id}, ${id}, 'test', ${id}, 'stopped', ${id}, ${time}, ${time})`;
      }
      for (const id of cases.filter((id) => id !== "no-fork")) {
        const payload = yield* encodeJson({
          threadId: id,
          projectId: id === "ordinary" ? "normal-project" : AGENTS_PROJECT_ID,
          isSideChat: id !== "not-side-chat",
          sideChatParentThreadId:
            id === "missing-parent"
              ? "absent"
              : id === "deleted-parent"
                ? "deleted-parent-root"
                : "parent",
        });
        yield* sql`INSERT INTO orchestration_events
          (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
          VALUES (${id}, 'thread', ${id}, 1, 'thread.forked', ${time}, 'client', ${payload}, '{}')`;
      }
      yield* sql`INSERT INTO projection_thread_messages
        (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES ('retained-message', 'recover', 'assistant', 'existing conversation', 0, ${time}, ${time})`;
      yield* sql`INSERT INTO projection_thread_sessions (thread_id, status, updated_at)
        VALUES ('recover', 'ready', ${time})`;
      const beforeMessages = yield* sql`SELECT * FROM projection_thread_messages`;
      const beforeSessions = yield* sql`SELECT * FROM projection_thread_sessions`;
      const beforeThreads = yield* sql`SELECT * FROM projection_threads ORDER BY thread_id`;
      yield* repairPromotedAgentSideChats();
      const repaired = yield* sql`SELECT * FROM projection_threads ORDER BY thread_id`;
      assert.deepStrictEqual(
        repaired,
        beforeThreads.map((thread) =>
          thread.thread_id === "recover"
            ? { ...thread, is_side_chat: 1, side_chat_parent_thread_id: "parent" }
            : thread,
        ),
      );
      assert.deepStrictEqual(yield* sql`SELECT * FROM projection_thread_messages`, beforeMessages);
      assert.deepStrictEqual(yield* sql`SELECT * FROM projection_thread_sessions`, beforeSessions);
      yield* sql`CREATE TEMP TABLE repair_updates (id TEXT)`;
      yield* sql`CREATE TEMP TRIGGER count_repair_updates AFTER UPDATE ON projection_threads
        BEGIN INSERT INTO repair_updates VALUES (NEW.thread_id); END`;
      yield* repairPromotedAgentSideChats();
      assert.deepStrictEqual(yield* sql`SELECT * FROM repair_updates`, []);
      // A projection rebuild can replay the old promotion; the next bootstrap must repair it again.
      yield* sql`UPDATE projection_threads SET is_side_chat = 0, side_chat_parent_thread_id = NULL WHERE thread_id = 'recover'`;
      yield* repairPromotedAgentSideChats();
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM projection_threads ORDER BY thread_id`,
        repaired,
      );
    }),
  );
});
