import { DEFAULT_SERVER_SETTINGS, type OrchestrationCommand } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { deleteArchivedThreads, purgeExpiredArchivedThreads } from "./archivedThreadRetention.ts";
import { OrchestrationCommandInvariantError } from "./orchestration/Errors.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import * as NodeSqliteClient from "./persistence/NodeSqliteClient.ts";
import { ServerSettingsService } from "./serverSettings.ts";

it.effect("does nothing when automatic deletion is disabled", () =>
  Effect.gen(function* () {
    const result = yield* purgeExpiredArchivedThreads(
      DateTime.makeUnsafe("2026-09-28T12:00:00.000Z"),
    ).pipe(
      Effect.provide(
        Layer.mock(ServerSettingsService)({
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        }),
      ),
    );
    assert.strictEqual(result, 0);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeSqliteClient.layerMemory(),
        Layer.mock(OrchestrationEngineService)({}),
      ),
    ),
  ),
);

it.effect(
  "deletes only expired archives, including the exact 48-hour boundary, across batches",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY, archived_at TEXT, deleted_at TEXT
    )`;
      for (let i = 0; i < 101; i++) {
        yield* sql`INSERT INTO projection_threads VALUES (
        ${`expired-${String(i).padStart(3, "0")}`}, '2026-09-26T12:00:00.000Z', NULL
      )`;
      }
      yield* sql`INSERT INTO projection_threads VALUES
      ('active', NULL, NULL),
      ('recent', '2026-09-26T12:00:00.001Z', NULL),
      ('deleted', '2026-09-25T12:00:00.000Z', '2026-09-27T12:00:00.000Z')`;
      const commands: OrchestrationCommand[] = [];
      const count = yield* purgeExpiredArchivedThreads(
        DateTime.makeUnsafe("2026-09-28T12:00:00.000Z"),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ServerSettingsService)({
              getSettings: Effect.succeed({
                ...DEFAULT_SERVER_SETTINGS,
                archivedThreadAutoDelete: true,
              }),
            }),
            Layer.mock(OrchestrationEngineService)({
              dispatch: (command) =>
                Effect.sync(() => {
                  commands.push(command);
                  return { sequence: commands.length };
                }),
            }),
          ),
        ),
      );
      assert.strictEqual(count, 101);
      assert.strictEqual(new Set(commands.map((command) => command.commandId)).size, 101);
      assert.isTrue(
        commands.every(
          (command) =>
            command.type === "thread.delete" &&
            command.threadId.startsWith("expired-") &&
            command.archivedBefore === "2026-09-26T12:00:00.000Z",
        ),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeSqliteClient.layerMemory()))),
);

it.effect("deletes the archived chats it is given, and carries on past a refused one", () =>
  Effect.gen(function* () {
    const commands: OrchestrationCommand[] = [];
    const result = yield* deleteArchivedThreads(
      ["a-old", "b-refused", "c-shown"],
      "2026-10-12T19:39:23.880Z",
    ).pipe(
      Effect.provide(
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            command.type === "thread.delete" && command.threadId === "b-refused"
              ? Effect.fail(
                  new OrchestrationCommandInvariantError({
                    commandType: command.type,
                    detail: "The thread is no longer eligible for archive retention cleanup.",
                  }),
                )
              : Effect.sync(() => {
                  commands.push(command);
                  return { sequence: commands.length };
                }),
        }),
      ),
    );
    assert.deepStrictEqual(result, { deleted: 2, skipped: 1 });
    assert.deepStrictEqual(
      commands.flatMap((command) =>
        command.type === "thread.delete" ? [`${command.threadId}@${command.archivedBefore}`] : [],
      ),
      ["a-old@2026-10-12T19:39:23.880Z", "c-shown@2026-10-12T19:39:23.880Z"],
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
