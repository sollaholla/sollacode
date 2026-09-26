import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlError, UnknownError } from "effect/unstable/sql/SqlError";

import { PersistenceDecodeError, PersistenceSqlError, toPersistenceSqlError } from "./Errors.ts";
import * as SqliteClient from "./NodeSqliteClient.ts";

const decodeRuntimePayload = Schema.decodeUnknownEffect(
  Schema.Struct({
    runtimePayload: Schema.Struct({
      attempt: Schema.Number,
    }),
  }),
);

it("keeps SQL operation context without a tautological detail", () => {
  const cause = new Error("database unavailable");
  const error = new PersistenceSqlError({
    operation: "AuthSessionRepository.list:query",
    cause,
  });

  assert.equal(error.operation, "AuthSessionRepository.list:query");
  assert.equal(error.detail, undefined);
  assert.equal(error.cause, cause);
  assert.equal(error.message, "SQL error in AuthSessionRepository.list:query");
});

it("explains nested storage failures without exposing SQL or local paths", () => {
  for (const nativeCause of [
    Object.assign(new Error("private SQL and path"), { code: "SQLITE_FULL" }),
    Object.assign(new Error("private SQL and path"), { code: "ENOSPC" }),
    Object.assign(new Error("private SQL and path"), { code: "ERR_SQLITE_ERROR", errcode: 13 }),
    new Error("database or disk is full"),
  ]) {
    const cause = new SqlError({ reason: new UnknownError({ cause: nativeCause }) });
    const error = toPersistenceSqlError("OrchestrationCommandReceiptRepository.upsert:query")(
      cause,
    );
    assert.include(error.message, "database or disk is full");
    assert.include(error.message, "machine running Solla");
    assert.notInclude(error.message, "private SQL and path");
    assert.equal(error.cause, cause);
    assert.equal(error.operation, "OrchestrationCommandReceiptRepository.upsert:query");
  }
});

it("does not claim every database-open failure means the disk is full", () => {
  for (const cause of [
    Object.assign(new Error("private database path"), { code: "SQLITE_CANTOPEN" }),
    Object.assign(new Error("private database path"), { code: "ERR_SQLITE_ERROR", errcode: 270 }),
    new Error("unable to open database file"),
  ]) {
    const error = toPersistenceSqlError("test.query")(new Error("wrapper", { cause }));
    assert.include(error.message, "couldn't open its database");
    assert.include(error.message, "disk space and folder permissions");
    assert.notInclude(error.message, "disk is full");
    assert.notInclude(error.message, "private database path");
  }
});

it("preserves other SQL failures and terminates on circular causes", () => {
  const cycle: { cause?: unknown } = {};
  cycle.cause = cycle;
  for (const cause of [undefined, "SQLITE_FULL", new Error("database is locked"), cycle]) {
    const error = toPersistenceSqlError("test.query")(cause);
    assert.equal(error.message, "SQL error in test.query: Failed to execute test.query");
  }
});

it.effect("explains a real SQLite capacity failure and allows writes after recovery", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE capacity_test (data BLOB)`;
    yield* sql`PRAGMA max_page_count = 2`;
    const error = yield* Effect.flip(
      sql`INSERT INTO capacity_test VALUES (zeroblob(32768))`.pipe(
        Effect.mapError(toPersistenceSqlError("capacity_test.insert")),
      ),
    );
    assert.include(error.message, "database or disk is full");
    assert.equal((yield* sql`SELECT * FROM capacity_test`).length, 0);
    yield* sql`PRAGMA max_page_count = 100`;
    yield* sql`INSERT INTO capacity_test VALUES (zeroblob(32768))`;
    assert.equal((yield* sql`SELECT * FROM capacity_test`).length, 1);
  }).pipe(Effect.provide(SqliteClient.layerMemory())),
);

it.effect("maps schema errors without copying rejected payloads into diagnostics", () =>
  Effect.gen(function* () {
    const rejectedPayload = "runtime-payload-secret-sentinel";
    const cause = yield* Effect.flip(
      decodeRuntimePayload({
        runtimePayload: {
          attempt: rejectedPayload,
        },
      }),
    );
    const error = PersistenceDecodeError.fromSchemaError(
      "ProviderSessionRuntimeRepository.list:decodeRows",
      cause,
    );

    assert.equal(error.operation, "ProviderSessionRuntimeRepository.list:decodeRows");
    assert.equal(error.cause, cause);
    assert.notInclude(error.issue, rejectedPayload);
    assert.notInclude(error.message, rejectedPayload);
    assert.include(error.issue, "InvalidType");
  }),
);
