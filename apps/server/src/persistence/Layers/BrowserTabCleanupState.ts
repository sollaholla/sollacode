import { ThreadId, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  BrowserTabCleanupState,
  BrowserTabCleanupStateStore,
  BrowserTabCleanupTurnReceipt,
  type BrowserTabCleanupCompletionPreparation,
  type BrowserTabCleanupStateStoreShape,
  type CommitBrowserTabCleanupCompletionInput,
  type PrepareBrowserTabCleanupCompletionInput,
  type RegisterBrowserTabCleanupTurnInput,
} from "../Services/BrowserTabCleanupState.ts";

const JsonTabIds = Schema.fromJsonString(Schema.Array(Schema.String));

const BrowserTabCleanupStateDbRow = Schema.Struct({
  threadId: BrowserTabCleanupState.fields.threadId,
  tabIds: JsonTabIds,
  lastProcessedTurnId: BrowserTabCleanupState.fields.lastProcessedTurnId,
  lastProcessedStartSequence: BrowserTabCleanupState.fields.lastProcessedStartSequence,
  updatedAt: BrowserTabCleanupState.fields.updatedAt,
});

const RegisterTurnDbInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  tabIds: JsonTabIds,
  createdAt: BrowserTabCleanupTurnReceipt.fields.createdAt,
});

const PrepareCompletionDbInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  currentTabIds: JsonTabIds,
  observedAt: BrowserTabCleanupTurnReceipt.fields.createdAt,
});

const CommitCompletionDbInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  tabIds: JsonTabIds,
  processedAt: BrowserTabCleanupTurnReceipt.fields.createdAt,
});

const CompletionInspectionDbRow = Schema.Struct({
  startSequence: BrowserTabCleanupTurnReceipt.fields.startSequence,
  processedAt: BrowserTabCleanupTurnReceipt.fields.processedAt,
  stateThreadId: Schema.NullOr(BrowserTabCleanupState.fields.threadId),
  stateTabIds: Schema.NullOr(JsonTabIds),
  lastProcessedTurnId: BrowserTabCleanupState.fields.lastProcessedTurnId,
  lastProcessedStartSequence: Schema.NullOr(
    BrowserTabCleanupState.fields.lastProcessedStartSequence,
  ),
  stateUpdatedAt: Schema.NullOr(BrowserTabCleanupState.fields.updatedAt),
});

const mapStoreError = (operation: string) => (cause: unknown) =>
  Schema.isSchemaError(cause)
    ? toPersistenceDecodeError(`${operation}:decode`)(cause)
    : toPersistenceSqlError(`${operation}:query`)(cause);

const makeBrowserTabCleanupStateStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getStateRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: ThreadId }),
    Result: BrowserTabCleanupStateDbRow,
    execute: ({ threadId }) => sql`
      SELECT
        thread_id AS "threadId",
        tab_set_json AS "tabIds",
        last_processed_turn_id AS "lastProcessedTurnId",
        last_processed_start_sequence AS "lastProcessedStartSequence",
        updated_at AS "updatedAt"
      FROM browser_tab_cleanup_state
      WHERE thread_id = ${threadId}
      LIMIT 1
    `,
  });

  const insertTurnReceipt = SqlSchema.void({
    Request: RegisterTurnDbInput,
    execute: (input) => sql`
      INSERT OR IGNORE INTO browser_tab_cleanup_turn_receipts (
        thread_id, turn_id, created_at, processed_at
      ) VALUES (
        ${input.threadId}, ${input.turnId}, ${input.createdAt}, NULL
      )
    `,
  });

  const insertStartBaseline = SqlSchema.void({
    Request: RegisterTurnDbInput,
    execute: (input) => sql`
      INSERT OR IGNORE INTO browser_tab_cleanup_state (
        thread_id, tab_set_json, last_processed_turn_id,
        last_processed_start_sequence, updated_at
      ) VALUES (
        ${input.threadId}, ${input.tabIds}, NULL, 0, ${input.createdAt}
      )
    `,
  });

  const inspectCompletionRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: ThreadId, turnId: TurnId }),
    Result: CompletionInspectionDbRow,
    execute: ({ threadId, turnId }) => sql`
      SELECT
        receipt.start_sequence AS "startSequence",
        receipt.processed_at AS "processedAt",
        state.thread_id AS "stateThreadId",
        state.tab_set_json AS "stateTabIds",
        state.last_processed_turn_id AS "lastProcessedTurnId",
        state.last_processed_start_sequence AS "lastProcessedStartSequence",
        state.updated_at AS "stateUpdatedAt"
      FROM browser_tab_cleanup_turn_receipts AS receipt
      LEFT JOIN browser_tab_cleanup_state AS state
        ON state.thread_id = receipt.thread_id
      WHERE receipt.thread_id = ${threadId}
        AND receipt.turn_id = ${turnId}
      LIMIT 1
    `,
  });

  const insertMissingReceipt = SqlSchema.void({
    Request: PrepareCompletionDbInput,
    execute: (input) => sql`
      INSERT OR IGNORE INTO browser_tab_cleanup_turn_receipts (
        thread_id, turn_id, created_at, processed_at
      ) VALUES (
        ${input.threadId}, ${input.turnId}, ${input.observedAt}, ${input.observedAt}
      )
    `,
  });

  const insertMissingBaseline = SqlSchema.void({
    Request: PrepareCompletionDbInput,
    execute: (input) => sql`
      INSERT OR IGNORE INTO browser_tab_cleanup_state (
        thread_id, tab_set_json, last_processed_turn_id,
        last_processed_start_sequence, updated_at
      )
      SELECT
        receipt.thread_id,
        ${input.currentTabIds},
        receipt.turn_id,
        receipt.start_sequence,
        ${input.observedAt}
      FROM browser_tab_cleanup_turn_receipts AS receipt
      WHERE receipt.thread_id = ${input.threadId}
        AND receipt.turn_id = ${input.turnId}
    `,
  });

  const markReceiptProcessed = SqlSchema.void({
    Request: Schema.Struct({
      threadId: ThreadId,
      turnId: TurnId,
      processedAt: BrowserTabCleanupTurnReceipt.fields.createdAt,
    }),
    execute: (input) => sql`
      UPDATE browser_tab_cleanup_turn_receipts
      SET processed_at = COALESCE(processed_at, ${input.processedAt})
      WHERE thread_id = ${input.threadId}
        AND turn_id = ${input.turnId}
    `,
  });

  const advanceBaseline = SqlSchema.void({
    Request: CommitCompletionDbInput,
    execute: (input) => sql`
      INSERT INTO browser_tab_cleanup_state (
        thread_id, tab_set_json, last_processed_turn_id,
        last_processed_start_sequence, updated_at
      )
      SELECT
        receipt.thread_id,
        ${input.tabIds},
        receipt.turn_id,
        receipt.start_sequence,
        ${input.processedAt}
      FROM browser_tab_cleanup_turn_receipts AS receipt
      WHERE receipt.thread_id = ${input.threadId}
        AND receipt.turn_id = ${input.turnId}
        AND receipt.processed_at IS NULL
      ON CONFLICT (thread_id) DO UPDATE SET
        tab_set_json = excluded.tab_set_json,
        last_processed_turn_id = excluded.last_processed_turn_id,
        last_processed_start_sequence = excluded.last_processed_start_sequence,
        updated_at = excluded.updated_at
      WHERE excluded.last_processed_start_sequence
        > browser_tab_cleanup_state.last_processed_start_sequence
    `,
  });

  const commitRows = (input: CommitBrowserTabCleanupCompletionInput) =>
    advanceBaseline(input).pipe(
      Effect.flatMap(() =>
        markReceiptProcessed({
          threadId: input.threadId,
          turnId: input.turnId,
          processedAt: input.processedAt,
        }),
      ),
    );

  const seedMissingRows = (input: PrepareBrowserTabCleanupCompletionInput) =>
    insertMissingReceipt(input).pipe(
      Effect.flatMap(() => insertMissingBaseline(input)),
      Effect.flatMap(() =>
        markReceiptProcessed({
          threadId: input.threadId,
          turnId: input.turnId,
          processedAt: input.observedAt,
        }),
      ),
    );

  const getByThreadId: BrowserTabCleanupStateStoreShape["getByThreadId"] = (threadId) =>
    getStateRow({ threadId }).pipe(
      Effect.mapError(mapStoreError("BrowserTabCleanupStateStore.getByThreadId")),
    );

  const registerTurn: BrowserTabCleanupStateStoreShape["registerTurn"] = (input) =>
    sql
      .withTransaction(
        insertTurnReceipt(input).pipe(Effect.flatMap(() => insertStartBaseline(input))),
      )
      .pipe(Effect.mapError(mapStoreError("BrowserTabCleanupStateStore.registerTurn")));

  const prepareCompletion: BrowserTabCleanupStateStoreShape["prepareCompletion"] = (input) =>
    sql
      .withTransaction(
        inspectCompletionRow({ threadId: input.threadId, turnId: input.turnId }).pipe(
          Effect.flatMap((inspection) => {
            if (Option.isNone(inspection)) {
              return seedMissingRows(input).pipe(
                Effect.as({ _tag: "Seeded" } as BrowserTabCleanupCompletionPreparation),
              );
            }

            const row = inspection.value;
            if (row.processedAt !== null) {
              return Effect.succeed({
                _tag: "AlreadyProcessed",
              } as BrowserTabCleanupCompletionPreparation);
            }
            if (
              row.stateThreadId === null ||
              row.stateTabIds === null ||
              row.lastProcessedStartSequence === null ||
              row.stateUpdatedAt === null
            ) {
              return commitRows({
                threadId: input.threadId,
                turnId: input.turnId,
                tabIds: input.currentTabIds,
                processedAt: input.observedAt,
              }).pipe(Effect.as({ _tag: "Seeded" } as BrowserTabCleanupCompletionPreparation));
            }
            if (row.startSequence <= row.lastProcessedStartSequence) {
              return markReceiptProcessed({
                threadId: input.threadId,
                turnId: input.turnId,
                processedAt: input.observedAt,
              }).pipe(Effect.as({ _tag: "Stale" } as BrowserTabCleanupCompletionPreparation));
            }

            return Effect.succeed({
              _tag: "Ready",
              baseline: {
                threadId: row.stateThreadId,
                tabIds: row.stateTabIds,
                lastProcessedTurnId: row.lastProcessedTurnId,
                lastProcessedStartSequence: row.lastProcessedStartSequence,
                updatedAt: row.stateUpdatedAt,
              },
            } as BrowserTabCleanupCompletionPreparation);
          }),
        ),
      )
      .pipe(Effect.mapError(mapStoreError("BrowserTabCleanupStateStore.prepareCompletion")));

  const commitCompletion: BrowserTabCleanupStateStoreShape["commitCompletion"] = (input) =>
    sql
      .withTransaction(commitRows(input))
      .pipe(Effect.mapError(mapStoreError("BrowserTabCleanupStateStore.commitCompletion")));

  return {
    getByThreadId,
    registerTurn,
    prepareCompletion,
    commitCompletion,
  } satisfies BrowserTabCleanupStateStoreShape;
});

export const BrowserTabCleanupStateStoreLive = Layer.effect(
  BrowserTabCleanupStateStore,
  makeBrowserTabCleanupStateStore,
);
