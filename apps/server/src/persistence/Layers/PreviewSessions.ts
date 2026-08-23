import { PreviewSessionSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  type PersistedPreviewSession,
  PreviewSessionStore,
  type PreviewSessionStoreShape,
} from "../Services/PreviewSessions.ts";

const SnapshotJson = Schema.fromJsonString(PreviewSessionSnapshot);
const encodeSnapshot = Schema.encodeSync(SnapshotJson);
const decodeSnapshot = Schema.decodeUnknownOption(SnapshotJson);

const RawRow = Schema.Struct({
  threadId: Schema.String,
  tabId: Schema.String,
  snapshotJson: Schema.String,
  updatedAt: Schema.String,
});

const makePreviewSessionStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: Schema.Struct({
      threadId: Schema.String,
      tabId: Schema.String,
      snapshotJson: Schema.String,
      updatedAt: Schema.String,
    }),
    execute: (row) => sql`
      INSERT INTO preview_sessions (thread_id, tab_id, snapshot_json, updated_at)
      VALUES (${row.threadId}, ${row.tabId}, ${row.snapshotJson}, ${row.updatedAt})
      ON CONFLICT (thread_id, tab_id) DO UPDATE SET
        snapshot_json = excluded.snapshot_json,
        updated_at = excluded.updated_at
    `,
  });

  const deleteRow = SqlSchema.void({
    Request: Schema.Struct({ threadId: Schema.String, tabId: Schema.String }),
    execute: ({ threadId, tabId }) => sql`
      DELETE FROM preview_sessions WHERE thread_id = ${threadId} AND tab_id = ${tabId}
    `,
  });

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: RawRow,
    execute: () => sql`
      SELECT
        thread_id AS "threadId",
        tab_id AS "tabId",
        snapshot_json AS "snapshotJson",
        updated_at AS "updatedAt"
      FROM preview_sessions
      ORDER BY updated_at ASC, tab_id ASC
    `,
  });

  const upsert: PreviewSessionStoreShape["upsert"] = (session) =>
    upsertRow({
      threadId: session.threadId,
      tabId: session.tabId,
      snapshotJson: encodeSnapshot(session.snapshot),
      updatedAt: session.updatedAt,
    }).pipe(Effect.mapError(toPersistenceSqlError("PreviewSessionStore.upsert:query")));

  const deleteSession: PreviewSessionStoreShape["deleteSession"] = (input) =>
    deleteRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("PreviewSessionStore.delete:query")),
    );

  const listAll: PreviewSessionStoreShape["listAll"] = () =>
    listRows(undefined).pipe(
      Effect.mapError(toPersistenceSqlError("PreviewSessionStore.listAll:query")),
      Effect.flatMap((rows) =>
        Effect.gen(function* () {
          const sessions: PersistedPreviewSession[] = [];
          for (const row of rows) {
            const snapshot = decodeSnapshot(row.snapshotJson);
            if (Option.isSome(snapshot)) {
              sessions.push({
                threadId: row.threadId,
                tabId: row.tabId,
                snapshot: snapshot.value,
                updatedAt: row.updatedAt,
              });
              continue;
            }
            // A row written by a newer/older contract that no longer decodes
            // is dead weight: drop it so it cannot fail every future boot.
            yield* deleteRow({ threadId: row.threadId, tabId: row.tabId }).pipe(
              Effect.mapError(toPersistenceSqlError("PreviewSessionStore.prune:query")),
            );
          }
          return sessions;
        }),
      ),
    );

  return { upsert, deleteSession, listAll } satisfies PreviewSessionStoreShape;
});

export const PreviewSessionStoreLive = Layer.effect(PreviewSessionStore, makePreviewSessionStore);
