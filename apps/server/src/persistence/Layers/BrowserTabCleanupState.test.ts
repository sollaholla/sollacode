import { ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { BrowserTabCleanupStateStore } from "../Services/BrowserTabCleanupState.ts";
import { BrowserTabCleanupStateStoreLive } from "./BrowserTabCleanupState.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const seedThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projectId = `project-${threadId}`;
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at
      ) VALUES (
        ${projectId}, 'Project', '/tmp/project', '{}',
        '2026-08-25T11:58:00.000Z', '2026-08-25T11:58:00.000Z'
      )
    `;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, created_at, updated_at
      ) VALUES (
        ${threadId}, ${projectId}, 'Thread',
        '2026-08-25T11:59:00.000Z', '2026-08-25T11:59:00.000Z'
      )
    `;
  });

it.layer(BrowserTabCleanupStateStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)))(
  "BrowserTabCleanupStateStore",
  (it) => {
    it.effect("orders equal-time turns by receipt and never regresses on late completion", () =>
      Effect.gen(function* () {
        const store = yield* BrowserTabCleanupStateStore;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("thread-tab-cleanup-order");
        const olderTurnId = TurnId.make("turn-older");
        const newerTurnId = TurnId.make("turn-newer");
        yield* seedThread(threadId);

        yield* store.registerTurn({
          threadId,
          turnId: olderTurnId,
          tabIds: ["tab-a"],
          createdAt: "2026-08-25T12:00:00.000Z",
        });
        yield* store.registerTurn({
          threadId,
          turnId: newerTurnId,
          tabIds: ["tab-ignored"],
          createdAt: "2026-08-25T12:00:00.000Z",
        });

        assert.deepEqual(Option.getOrThrow(yield* store.getByThreadId(threadId)), {
          threadId,
          tabIds: ["tab-a"],
          lastProcessedTurnId: null,
          lastProcessedStartSequence: 0,
          updatedAt: "2026-08-25T12:00:00.000Z",
        });

        const receiptRows = yield* sql<{
          readonly turnId: string;
          readonly startSequence: number;
          readonly processedAt: string | null;
        }>`
          SELECT
            turn_id AS "turnId",
            start_sequence AS "startSequence",
            processed_at AS "processedAt"
          FROM browser_tab_cleanup_turn_receipts
          WHERE thread_id = ${threadId}
          ORDER BY start_sequence
        `;
        assert.strictEqual(receiptRows.length, 2);
        assert.strictEqual(receiptRows[0]?.turnId, olderTurnId);
        assert.strictEqual(receiptRows[1]?.turnId, newerTurnId);
        assert.isTrue(
          (receiptRows[0]?.startSequence ?? Number.MAX_SAFE_INTEGER) <
            (receiptRows[1]?.startSequence ?? 0),
        );

        const readyInput = {
          threadId,
          turnId: newerTurnId,
          currentTabIds: ["tab-a", "tab-b"],
          observedAt: "2026-08-25T12:02:00.000Z",
        } as const;
        const firstPreparation = yield* store.prepareCompletion(readyInput);
        assert.strictEqual(firstPreparation._tag, "Ready");
        // A crash before command dispatch/commit must leave the deterministic
        // follow-up retryable instead of burning the receipt.
        assert.strictEqual((yield* store.prepareCompletion(readyInput))._tag, "Ready");

        yield* store.commitCompletion({
          threadId,
          turnId: newerTurnId,
          tabIds: ["tab-a", "tab-b"],
          processedAt: "2026-08-25T12:02:00.000Z",
        });

        const newerSequence = receiptRows[1]?.startSequence ?? 0;
        assert.deepEqual(Option.getOrThrow(yield* store.getByThreadId(threadId)), {
          threadId,
          tabIds: ["tab-a", "tab-b"],
          lastProcessedTurnId: newerTurnId,
          lastProcessedStartSequence: newerSequence,
          updatedAt: "2026-08-25T12:02:00.000Z",
        });

        assert.strictEqual(
          (yield* store.prepareCompletion({
            threadId,
            turnId: olderTurnId,
            currentTabIds: ["tab-stale"],
            observedAt: "2026-08-25T12:03:00.000Z",
          }))._tag,
          "Stale",
        );
        assert.deepEqual(Option.getOrThrow(yield* store.getByThreadId(threadId)), {
          threadId,
          tabIds: ["tab-a", "tab-b"],
          lastProcessedTurnId: newerTurnId,
          lastProcessedStartSequence: newerSequence,
          updatedAt: "2026-08-25T12:02:00.000Z",
        });
        assert.strictEqual(
          (yield* store.prepareCompletion({
            threadId,
            turnId: olderTurnId,
            currentTabIds: ["tab-stale"],
            observedAt: "2026-08-25T12:04:00.000Z",
          }))._tag,
          "AlreadyProcessed",
        );
        assert.strictEqual((yield* store.prepareCompletion(readyInput))._tag, "AlreadyProcessed");
      }),
    );

    it.effect("seeds missing completions once without replacing a known baseline", () =>
      Effect.gen(function* () {
        const store = yield* BrowserTabCleanupStateStore;
        const threadId = ThreadId.make("thread-tab-cleanup-missing");
        const startedTurnId = TurnId.make("turn-started");
        const missingTurnId = TurnId.make("turn-missing");
        yield* seedThread(threadId);
        yield* store.registerTurn({
          threadId,
          turnId: startedTurnId,
          tabIds: ["tab-baseline"],
          createdAt: "2026-08-25T13:00:00.000Z",
        });

        const missingInput = {
          threadId,
          turnId: missingTurnId,
          currentTabIds: ["tab-baseline", "tab-auxiliary"],
          observedAt: "2026-08-25T13:01:00.000Z",
        } as const;
        assert.strictEqual((yield* store.prepareCompletion(missingInput))._tag, "Seeded");
        assert.strictEqual((yield* store.prepareCompletion(missingInput))._tag, "AlreadyProcessed");
        assert.deepEqual(Option.getOrThrow(yield* store.getByThreadId(threadId)), {
          threadId,
          tabIds: ["tab-baseline"],
          lastProcessedTurnId: null,
          lastProcessedStartSequence: 0,
          updatedAt: "2026-08-25T13:00:00.000Z",
        });
      }),
    );

    it.effect("seeds the first unknown completion and cascades all cleanup rows", () =>
      Effect.gen(function* () {
        const store = yield* BrowserTabCleanupStateStore;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("thread-tab-cleanup-cascade");
        const turnId = TurnId.make("turn-unknown");
        yield* seedThread(threadId);

        assert.strictEqual(
          (yield* store.prepareCompletion({
            threadId,
            turnId,
            currentTabIds: ["tab-a"],
            observedAt: "2026-08-25T14:00:00.000Z",
          }))._tag,
          "Seeded",
        );
        const state = Option.getOrThrow(yield* store.getByThreadId(threadId));
        assert.deepEqual(state.tabIds, ["tab-a"]);
        assert.strictEqual(state.lastProcessedTurnId, turnId);
        assert.isAbove(state.lastProcessedStartSequence, 0);

        yield* sql`DELETE FROM projection_threads WHERE thread_id = ${threadId}`;
        const counts = yield* sql<{
          readonly stateCount: number;
          readonly receiptCount: number;
        }>`
          SELECT
            (
              SELECT COUNT(*) FROM browser_tab_cleanup_state
              WHERE thread_id = ${threadId}
            ) AS "stateCount",
            (
              SELECT COUNT(*) FROM browser_tab_cleanup_turn_receipts
              WHERE thread_id = ${threadId}
            ) AS "receiptCount"
        `;
        assert.deepEqual(counts, [{ stateCount: 0, receiptCount: 0 }]);
      }),
    );
  },
);
