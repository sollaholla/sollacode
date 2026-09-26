import { CommandId, EventId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { repairMuseActivityChronology } from "./repairMuseActivityChronology.ts";

it.layer(OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)))(
  "Muse historical activity chronology repair",
  (it) => {
    it.effect(
      "restores matching receipt times once without rolling back content or other providers",
      () =>
        Effect.gen(function* () {
          const store = yield* OrchestrationEventStore;
          const sql = yield* SqlClient.SqlClient;
          const threadId = ThreadId.make("history-repair");
          const turnId = TurnId.make("muse-turn");
          const originalTime = "2026-09-13T20:43:00.000Z";
          const updatedTime = "2026-09-13T20:44:00.000Z";
          const replayTime = "2026-09-13T21:26:00.000Z";
          const ids = [
            "muse:instance:history-repair:v:1:item.completed:tool",
            "reasoning:history-repair:muse-turn:item",
            "codex:other",
          ];
          let eventNumber = 0;
          for (const id of ids) {
            const reasoning = id.startsWith("reasoning:");
            for (const [index, time] of [originalTime, updatedTime, replayTime].entries()) {
              const activity = {
                id: EventId.make(id),
                turnId,
                tone: "info" as const,
                kind: reasoning ? "reasoning.updated" : "tool.completed",
                summary: reasoning && index === 0 ? "First thought" : "Completed thought",
                payload: { detail: reasoning && index === 0 ? "partial" : "complete" },
                ...(index === 0 ? { sequence: 10 } : {}),
                createdAt: time,
              };
              const event = yield* store.append({
                type: "thread.activity-appended",
                eventId: EventId.make(`receipt-${++eventNumber}`),
                aggregateKind: "thread",
                aggregateId: threadId,
                occurredAt: time,
                commandId: CommandId.make(`receipt-command-${eventNumber}`),
                causationEventId: null,
                correlationId: null,
                metadata: {},
                payload: { threadId, activity },
              });
              assert.ok(event);
            }
            yield* sql`INSERT INTO projection_thread_activities
            (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at)
            VALUES (${id}, ${threadId}, ${turnId}, 'info', ${reasoning ? "reasoning.updated" : "tool.completed"},
              'Completed thought', '{"detail":"complete"}', NULL, ${replayTime})`;
          }
          yield* repairMuseActivityChronology();
          const rows = yield* sql<{
            id: string;
            createdAt: string;
            sequence: number | null;
            payload: string;
          }>`
          SELECT activity_id AS id, created_at AS "createdAt", sequence, payload_json AS payload
          FROM projection_thread_activities ORDER BY activity_id`;
          assert.deepStrictEqual(
            rows.map(({ id, createdAt, sequence }) => ({ id, createdAt, sequence })),
            [
              { id: ids[2], createdAt: replayTime, sequence: null },
              { id: ids[0], createdAt: originalTime, sequence: 10 },
              { id: ids[1], createdAt: updatedTime, sequence: null },
            ],
          );
          assert.ok(rows.every((row) => row.payload === '{"detail":"complete"}'));
          yield* sql`CREATE TEMP TABLE repair_updates (id TEXT)`;
          yield* sql`CREATE TEMP TRIGGER count_repair_updates AFTER UPDATE ON projection_thread_activities
          BEGIN INSERT INTO repair_updates VALUES (NEW.activity_id); END`;
          yield* repairMuseActivityChronology();
          const counts = yield* sql`SELECT COUNT(*) AS count FROM repair_updates`;
          assert.deepStrictEqual(counts, [{ count: 0 }]);
        }),
    );
  },
);
