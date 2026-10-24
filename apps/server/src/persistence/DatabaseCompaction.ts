// @effect-diagnostics nodeBuiltinImport:off - fsync, statfs, and exact (bigint) inode reads have no Effect FileSystem equivalent.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  DatabaseCompactionResult,
  DatabaseCompactionSchedule,
  DatabaseStorageError,
  type DatabaseCompactionDeferral,
  type DatabaseStorageStatus,
} from "@t3tools/contracts";
import {
  DEFER_DATABASE_COMPACTION_ENV,
  compactionEstimatedSeconds,
  compactionRequiredFreeBytes,
  databaseCompactionRequestPath,
  databaseCompactionResultPath,
  databaseCompactionTempPrefix,
} from "@t3tools/shared/databaseCompaction";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import { setStartupStage } from "../httpStartupResponder.ts";
import {
  type CompactionConnection,
  type CompactionSqlite,
  type CompactionSqliteError,
  type SqliteRow,
  makeWorkerSqlite,
} from "./DatabaseCompactionWorker.ts";

/**
 * Database compaction: rewriting `state.sqlite` without its free pages.
 *
 * SQLite reuses pages freed by deleted threads but never gives them back to
 * the disk (the database runs with auto_vacuum off). A person schedules a
 * compaction from Settings; the next server start runs it before the main
 * SQLite client opens the file, with nothing else using the database:
 *
 *  1. checkpoint the write-ahead log, measure live pages, check free disk;
 *  2. switch the file out of WAL mode — SQLite refuses while any other
 *     connection has it open, which proves nothing else is using it — and hold
 *     an exclusive lock;
 *  3. `VACUUM INTO` a new file beside it, then require `PRAGMA quick_check` to
 *     pass and the schema, version numbers, and every table's row count to
 *     match the original;
 *  4. close both, flush the copy to disk, and rename it over the original.
 *
 * A crash at any point leaves the original or the complete, checked copy:
 * the rename is the only step that changes what `state.sqlite` names. The
 * request is removed before the work starts, so a run that crashes the server
 * is never retried on its own.
 */

const RESULT_FILE_VERSION = 1;

/** Written before the work starts, so a run cut short is reported at the next start. */
const RunningRecord = Schema.Struct({
  version: Schema.Literal(RESULT_FILE_VERSION),
  state: Schema.Literal("running"),
  startedAt: Schema.String,
  beforeBytes: Schema.Number,
  /** The original file's inode: a different one at the next start means the swap happened. */
  originalInode: Schema.String,
});

const FinishedRecord = Schema.Struct({
  version: Schema.Literal(RESULT_FILE_VERSION),
  state: Schema.Literal("finished"),
  result: DatabaseCompactionResult,
});

const ResultFile = Schema.Union([RunningRecord, FinishedRecord]);
type ResultFile = typeof ResultFile.Type;

const RequestFile = Schema.Struct({
  version: Schema.Literal(RESULT_FILE_VERSION),
  schedule: DatabaseCompactionSchedule,
});
type RequestFile = typeof RequestFile.Type;

const decodeResultFile = Schema.decodeUnknownEffect(Schema.fromJsonString(ResultFile));
const encodeResultFile = Schema.encodeEffect(Schema.fromJsonString(ResultFile));
const decodeRequestFile = Schema.decodeUnknownEffect(Schema.fromJsonString(RequestFile));
const encodeRequestFile = Schema.encodeEffect(Schema.fromJsonString(RequestFile));

const nowIso = Effect.map(Clock.currentTimeMillis, (ms) =>
  DateTime.formatIso(DateTime.makeUnsafe(ms)),
);

const describe = (cause: unknown): string => {
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message;
  const text = String(cause).trim();
  return text.length > 0 ? text : "Unknown error.";
};

const GIB = 1024 * 1024 * 1024;
const formatGib = (bytes: number) => `${(bytes / GIB).toFixed(1)} GB`;

// ---------------------------------------------------------------------------
// Files beside the database

const readTextIfPresent = Effect.fn("DatabaseCompaction.readTextIfPresent")(function* (
  path: string,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(path).pipe(
    Effect.map((text): string | null => text),
    Effect.catchTag("PlatformError", (error) =>
      error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
    ),
  );
});

/** The scheduled request, or null; an unreadable one counts as absent and is logged. */
export const readCompactionRequest = Effect.fn("DatabaseCompaction.readRequest")(function* (
  dbPath: string,
) {
  const path = databaseCompactionRequestPath(dbPath);
  const text = yield* readTextIfPresent(path).pipe(Effect.orElseSucceed(() => null));
  if (text === null) return null;
  return yield* decodeRequestFile(text).pipe(
    Effect.map((file): RequestFile | null => file),
    Effect.catch((cause) =>
      Effect.logWarning("Ignoring an unreadable database compaction request.", {
        path,
        cause: describe(cause),
      }).pipe(Effect.as(null)),
    ),
  );
});

const writeCompactionRequest = Effect.fn("DatabaseCompaction.writeRequest")(function* (
  dbPath: string,
  schedule: DatabaseCompactionSchedule,
) {
  const contents = yield* encodeRequestFile({ version: RESULT_FILE_VERSION, schedule });
  yield* writeFileStringAtomically({
    filePath: databaseCompactionRequestPath(dbPath),
    contents: `${contents}\n`,
  });
});

/** Schedules a compaction for the next start, keeping an existing request's time. */
export const requestDatabaseCompaction = Effect.fn("DatabaseCompaction.request")(function* (
  dbPath: string,
) {
  if ((yield* readCompactionRequest(dbPath)) !== null) return;
  yield* writeCompactionRequest(dbPath, {
    requestedAt: yield* nowIso,
    deferredAt: null,
    deferredReason: null,
  });
});

export const removeCompactionRequest = Effect.fn("DatabaseCompaction.removeRequest")(function* (
  dbPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(databaseCompactionRequestPath(dbPath), { force: true });
});

const readResultFile = Effect.fn("DatabaseCompaction.readResultFile")(function* (dbPath: string) {
  const path = databaseCompactionResultPath(dbPath);
  const text = yield* readTextIfPresent(path).pipe(Effect.orElseSucceed(() => null));
  if (text === null) return null;
  return yield* decodeResultFile(text).pipe(
    Effect.map((file): ResultFile | null => file),
    Effect.catch((cause) =>
      Effect.logWarning("Ignoring an unreadable database compaction result.", {
        path,
        cause: describe(cause),
      }).pipe(Effect.as(null)),
    ),
  );
});

const writeResultFile = Effect.fn("DatabaseCompaction.writeResultFile")(function* (
  dbPath: string,
  file: ResultFile,
) {
  const contents = yield* encodeResultFile(file);
  yield* writeFileStringAtomically({
    filePath: databaseCompactionResultPath(dbPath),
    contents: `${contents}\n`,
  });
});

/** The last finished compaction, for the status RPC. */
export const readLastCompactionResult = Effect.fn("DatabaseCompaction.readLastResult")(function* (
  dbPath: string,
) {
  const file = yield* readResultFile(dbPath);
  return file?.state === "finished" ? file.result : null;
});

const fileSize = (path: string) =>
  Effect.tryPromise(() => NodeFSP.stat(path)).pipe(
    Effect.map((info) => info.size),
    Effect.orElseSucceed(() => 0),
  );

const fileInode = (path: string) =>
  Effect.tryPromise(() => NodeFSP.stat(path, { bigint: true })).pipe(
    Effect.map((info): string | null => info.ino.toString()),
    Effect.orElseSucceed(() => null),
  );

const pathExists = (path: string) =>
  Effect.tryPromise(() => NodeFSP.lstat(path)).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

/** Free bytes this user can write on the volume holding `directory`, or null when unknown. */
export const freeDiskBytes = (directory: string): Effect.Effect<number | null> =>
  Effect.tryPromise(() => NodeFSP.statfs(directory)).pipe(
    Effect.map((stats): number | null => Math.floor(Number(stats.bavail) * Number(stats.bsize))),
    Effect.orElseSucceed(() => null),
  );

const syncFile = (path: string) =>
  Effect.tryPromise(async () => {
    const handle = await NodeFSP.open(path, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  });

/** Makes a rename durable. Directories cannot be opened for fsync on Windows. */
const syncDirectory = (directory: string, platform: NodeJS.Platform) =>
  platform === "win32"
    ? Effect.void
    : Effect.tryPromise(async () => {
        const handle = await NodeFSP.open(directory, "r");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }).pipe(Effect.ignore);

/** Removes copies left by a run that was cut short. */
export const removeLeftoverCompactionFiles = Effect.fn("DatabaseCompaction.removeLeftovers")(
  function* (dbPath: string) {
    const fs = yield* FileSystem.FileSystem;
    const directory = NodePath.dirname(dbPath);
    const prefix = databaseCompactionTempPrefix(NodePath.basename(dbPath));
    const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
    const leftovers = names.filter((name) => name.startsWith(prefix));
    yield* Effect.forEach(
      leftovers,
      (name) => fs.remove(NodePath.join(directory, name), { force: true }).pipe(Effect.ignore),
      { discard: true },
    );
    return leftovers;
  },
);

// ---------------------------------------------------------------------------
// The compaction itself

class CompactionStop extends Schema.TaggedErrorClass<CompactionStop>()("CompactionStop", {
  outcome: Schema.Literals(["skipped", "failed"]),
  reason: Schema.String,
}) {}

const skip = (reason: string) => new CompactionStop({ outcome: "skipped", reason });
const fail = (reason: string) => new CompactionStop({ outcome: "failed", reason });

export type CompactionFileOutcome =
  | { readonly outcome: "compacted"; readonly beforeBytes: number; readonly afterBytes: number }
  | {
      readonly outcome: "skipped" | "failed";
      readonly beforeBytes: number;
      readonly reason: string;
    };

const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
const quoteLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

const numberField = (row: SqliteRow | undefined, field: string): number | null => {
  const value = row?.[field];
  return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : null;
};

const stringField = (row: SqliteRow | undefined, field: string): string | null => {
  const value = row?.[field];
  return typeof value === "string" ? value : null;
};

const pragmaNumber = Effect.fn("DatabaseCompaction.pragmaNumber")(function* (
  connection: CompactionConnection,
  pragma: string,
) {
  const rows = yield* connection.all(`PRAGMA ${pragma}`);
  const value = numberField(rows[0], pragma);
  if (value === null) return yield* fail(`SQLite did not report ${pragma}.`);
  return value;
});

interface DatabaseFacts {
  readonly pageSize: number;
  readonly userVersion: number;
  readonly applicationId: number;
  readonly schema: ReadonlyArray<string>;
  readonly tables: ReadonlyArray<{
    readonly name: string;
    readonly rows: number;
    readonly maxRowid: number | null;
  }>;
}

/**
 * What must survive a compaction unchanged: the schema (minus root page
 * numbers, which a rewrite renumbers), the header values migrations and SQLite
 * bookkeeping rely on, and every table's row count and highest rowid. Counts
 * walk each table's smallest b-tree, never row payloads.
 */
const readFacts = Effect.fn("DatabaseCompaction.readFacts")(function* (
  connection: CompactionConnection,
) {
  const schemaRows = yield* connection.all(
    "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
  );
  const schema = schemaRows.map((row) =>
    [
      stringField(row, "type") ?? "",
      stringField(row, "name") ?? "",
      stringField(row, "tbl_name") ?? "",
      stringField(row, "sql") ?? "",
    ].join("|"),
  );
  const tables: Array<DatabaseFacts["tables"][number]> = [];
  for (const row of schemaRows) {
    const name = stringField(row, "name");
    const sql = stringField(row, "sql") ?? "";
    if (stringField(row, "type") !== "table" || name === null) continue;
    if (/^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(sql)) continue;
    const counted = yield* connection.all(`SELECT count(*) AS n FROM ${quoteIdentifier(name)}`);
    const maxRowid = /WITHOUT\s+ROWID/i.test(sql)
      ? null
      : numberField(
          (yield* connection.all(`SELECT max(rowid) AS m FROM ${quoteIdentifier(name)}`))[0],
          "m",
        );
    tables.push({ name, rows: numberField(counted[0], "n") ?? -1, maxRowid });
  }
  return {
    pageSize: yield* pragmaNumber(connection, "page_size"),
    userVersion: yield* pragmaNumber(connection, "user_version"),
    applicationId: yield* pragmaNumber(connection, "application_id"),
    schema,
    tables,
  } satisfies DatabaseFacts;
});

/** The first difference between two databases' facts, or null when they match. */
export function describeFactsMismatch(source: DatabaseFacts, copy: DatabaseFacts): string | null {
  if (source.pageSize !== copy.pageSize) return "the page size changed";
  if (source.userVersion !== copy.userVersion) return "user_version changed";
  if (source.applicationId !== copy.applicationId) return "application_id changed";
  if (source.schema.length !== copy.schema.length) return "the schema has a different shape";
  for (let index = 0; index < source.schema.length; index += 1) {
    if (source.schema[index] !== copy.schema[index]) return "the schema differs";
  }
  const copyTables = new Map(copy.tables.map((table) => [table.name, table]));
  for (const table of source.tables) {
    const copied = copyTables.get(table.name);
    if (copied === undefined) return `table ${table.name} is missing`;
    if (copied.rows !== table.rows) {
      return `table ${table.name} has ${copied.rows} rows instead of ${table.rows}`;
    }
    if (copied.maxRowid !== table.maxRowid) return `table ${table.name} lost its newest rows`;
  }
  return null;
}

export interface CompactDatabaseFileInput {
  readonly dbPath: string;
  /** Distinguishes this run's copy from any other: `<db>.compacting-<suffix>`. */
  readonly runId: string;
  readonly sqlite: CompactionSqlite;
  readonly freeDiskBytes: (directory: string) => Effect.Effect<number | null>;
  readonly platform: NodeJS.Platform;
  /**
   * Replaces the integrity check's answer. Tests use it to prove a failing
   * check keeps the original; production never sets it.
   */
  readonly quickCheck?: (
    connection: CompactionConnection,
  ) => Effect.Effect<string, CompactionSqliteError>;
}

const defaultQuickCheck = (connection: CompactionConnection) =>
  connection
    .all("PRAGMA quick_check")
    .pipe(
      Effect.map((rows) => rows.map((row) => stringField(row, "quick_check") ?? "?").join("; ")),
    );

const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * Windows refuses to replace a file another process (often a virus scanner)
 * has open for a moment; wait it out briefly. Elsewhere rename never retries.
 */
class RenameError extends Schema.TaggedErrorClass<RenameError>()("RenameError", {
  code: Schema.NullOr(Schema.String),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const renameOver = (from: string, to: string, platform: NodeJS.Platform) => {
  const attempt = (remaining: number): Effect.Effect<void, RenameError> =>
    Effect.tryPromise({
      try: () => NodeFSP.rename(from, to),
      catch: (cause) => {
        const code = (cause as { readonly code?: unknown } | null)?.code;
        return new RenameError({
          code: typeof code === "string" ? code : null,
          detail: describe(cause),
        });
      },
    }).pipe(
      Effect.catch((error) =>
        platform === "win32" &&
        remaining > 0 &&
        error.code !== null &&
        RENAME_RETRY_CODES.has(error.code)
          ? Effect.sleep(Duration.millis(250)).pipe(Effect.andThen(attempt(remaining - 1)))
          : Effect.fail(error),
      ),
    );
  return attempt(20);
};

/**
 * Compacts one database file in place. Never fails: every way it can stop is
 * an outcome, and every outcome but "compacted" leaves the original file
 * exactly as it was (apart from its journal mode, which the server sets back
 * to WAL when it opens the file).
 */
export const compactDatabaseFile = Effect.fn("DatabaseCompaction.compactDatabaseFile")(function* (
  input: CompactDatabaseFileInput,
) {
  const { dbPath } = input;
  const directory = NodePath.dirname(dbPath);
  const tempPath = NodePath.join(
    directory,
    `${databaseCompactionTempPrefix(NodePath.basename(dbPath))}${input.runId}`,
  );
  const beforeBytes = (yield* fileSize(dbPath)) + (yield* fileSize(`${dbPath}-wal`));
  let swapped = false;

  const run = Effect.gen(function* () {
    if (!(yield* pathExists(dbPath))) {
      return yield* skip("There is no database to compact yet.");
    }
    const source = yield* input.sqlite.open(dbPath);
    yield* source.exec("PRAGMA busy_timeout = 5000");
    const checkpoint = yield* source.all("PRAGMA wal_checkpoint(TRUNCATE)");
    if (numberField(checkpoint[0], "busy") === 1) {
      return yield* skip("Another process was using the database.");
    }

    const pageSize = yield* pragmaNumber(source, "page_size");
    const pageCount = yield* pragmaNumber(source, "page_count");
    const freePages = yield* pragmaNumber(source, "freelist_count");
    if (freePages === 0) {
      return yield* skip("The database had no free space to reclaim.");
    }
    const liveBytes = (pageCount - freePages) * pageSize;
    const required = compactionRequiredFreeBytes(liveBytes);
    const available = yield* input.freeDiskBytes(directory);
    if (available !== null && available < required) {
      return yield* skip(
        `Not enough free disk space: compaction needs ${formatGib(required)} and ${formatGib(available)} was free.`,
      );
    }

    // SQLite leaves WAL mode only when no other connection has the file open,
    // so this is the proof that nothing else is using it. It also removes the
    // -wal and -shm files, which must never sit beside the replacement.
    const journal = yield* source
      .all("PRAGMA journal_mode = DELETE")
      .pipe(
        Effect.mapError((error) =>
          /locked|busy/i.test(error.detail)
            ? skip("Another process had the database open.")
            : fail(`The database could not leave WAL mode: ${error.detail}`),
        ),
      );
    if (stringField(journal[0], "journal_mode") !== "delete") {
      return yield* skip("Another process had the database open.");
    }
    // Hold the lock from here until the copy is checked: nothing can read or
    // write the original in between.
    yield* source.exec("PRAGMA locking_mode = EXCLUSIVE");
    yield* source.exec("PRAGMA synchronous = FULL");
    yield* source.exec("BEGIN IMMEDIATE; COMMIT;");

    yield* source.exec(`VACUUM INTO ${quoteLiteral(tempPath)}`);
    const sourceFacts = yield* readFacts(source);

    const copy = yield* input.sqlite.open(tempPath);
    const check = yield* (input.quickCheck ?? defaultQuickCheck)(copy).pipe(
      Effect.mapError((cause) => fail(`The integrity check could not run: ${describe(cause)}`)),
    );
    if (check !== "ok") {
      return yield* fail(`The compacted copy failed its integrity check (${check}).`);
    }
    const mismatch = describeFactsMismatch(sourceFacts, yield* readFacts(copy));
    if (mismatch !== null) {
      return yield* fail(`The compacted copy did not match the original: ${mismatch}.`);
    }
    yield* copy.close;
    yield* source.close;

    yield* syncFile(tempPath).pipe(
      Effect.mapError((cause) => fail(`The compacted copy could not be saved: ${describe(cause)}`)),
    );
    // With the original out of WAL mode and closed, these exist only if
    // another process opened it since. A write-ahead log or rollback journal
    // beside the replacement would be applied to it, so keep the original.
    if ((yield* pathExists(`${dbPath}-wal`)) || (yield* pathExists(`${dbPath}-journal`))) {
      return yield* skip("Another process opened the database during compaction.");
    }
    // A shared-memory file with no log is left from an earlier crash; no
    // connection exists to use it (every WAL connection keeps a -wal open).
    yield* Effect.tryPromise(() => NodeFSP.rm(`${dbPath}-shm`, { force: true })).pipe(
      Effect.ignore,
    );
    // The rename and the record of it happen together or not at all.
    yield* Effect.uninterruptible(
      renameOver(tempPath, dbPath, input.platform).pipe(
        Effect.mapError((cause) =>
          fail(`The compacted copy could not replace the database: ${describe(cause)}`),
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            swapped = true;
          }),
        ),
      ),
    );
    yield* syncDirectory(directory, input.platform);
    return { outcome: "compacted", beforeBytes, afterBytes: yield* fileSize(dbPath) } as const;
  });

  return yield* Effect.scoped(run).pipe(
    Effect.catch((error): Effect.Effect<CompactionFileOutcome> => {
      if (error._tag === "CompactionStop") {
        return Effect.succeed({ outcome: error.outcome, beforeBytes, reason: error.reason });
      }
      return Effect.succeed({ outcome: "failed", beforeBytes, reason: describe(error) });
    }),
    Effect.ensuring(
      Effect.suspend(() =>
        swapped ? Effect.void : removeLeftoverCompactionFiles(dbPath).pipe(Effect.ignore),
      ),
    ),
  );
});

// ---------------------------------------------------------------------------
// The startup step

export type StartupCompactionReport =
  | { readonly kind: "none" }
  | { readonly kind: "deferred"; readonly reason: DatabaseCompactionDeferral }
  | { readonly kind: "ran"; readonly result: DatabaseCompactionResult };

export interface RunScheduledCompactionInput {
  readonly dbPath: string;
  /** Set when this start must leave a scheduled compaction for the next one. */
  readonly deferral: DatabaseCompactionDeferral | null;
  /** Null when this runtime cannot compact (Bun has no `node:sqlite`). */
  readonly sqlite: Effect.Effect<CompactionSqlite, never, Scope.Scope> | null;
  readonly freeDiskBytes?: (directory: string) => Effect.Effect<number | null>;
  /** Told when the slow part starts and stops, to label the startup page. */
  readonly onActive?: (active: boolean) => void;
  readonly quickCheck?: CompactDatabaseFileInput["quickCheck"];
}

/**
 * A "running" record at startup means the last run was cut short. The swap is
 * a single rename, so the inode says which file is in place.
 */
const settleInterruptedRun = Effect.fn("DatabaseCompaction.settleInterruptedRun")(function* (
  dbPath: string,
) {
  const file = yield* readResultFile(dbPath);
  if (file === null || file.state !== "running") return;
  const inode = yield* fileInode(dbPath);
  const swapped = inode !== null && inode !== file.originalInode;
  const finishedAt = yield* nowIso;
  const result: DatabaseCompactionResult = swapped
    ? {
        outcome: "compacted",
        startedAt: file.startedAt,
        finishedAt,
        durationMs: null,
        beforeBytes: file.beforeBytes,
        afterBytes: yield* fileSize(dbPath),
        reason: "Solla Code stopped just after the compacted database was put in place.",
      }
    : {
        outcome: "interrupted",
        startedAt: file.startedAt,
        finishedAt,
        durationMs: null,
        beforeBytes: file.beforeBytes,
        afterBytes: null,
        reason: "Solla Code stopped before compaction finished. The original database was kept.",
      };
  yield* writeResultFile(dbPath, { version: RESULT_FILE_VERSION, state: "finished", result });
  yield* Effect.logWarning("A database compaction was cut short by a stop.", {
    outcome: result.outcome,
  });
});

/**
 * Runs before the server's SQLite client opens the database. Does nothing
 * unless a compaction was scheduled; never fails startup.
 */
export const runScheduledDatabaseCompaction = Effect.fn("DatabaseCompaction.runScheduled")(
  function* (input: RunScheduledCompactionInput) {
    const { dbPath } = input;
    const leftovers = yield* removeLeftoverCompactionFiles(dbPath);
    if (leftovers.length > 0) {
      yield* Effect.logWarning("Removed copies left by an interrupted database compaction.", {
        files: leftovers,
      });
    }
    yield* settleInterruptedRun(dbPath).pipe(Effect.ignore);

    const request = yield* readCompactionRequest(dbPath);
    if (request === null) return { kind: "none" } satisfies StartupCompactionReport;

    if (input.deferral !== null) {
      yield* writeCompactionRequest(dbPath, {
        ...request.schedule,
        deferredAt: yield* nowIso,
        deferredReason: input.deferral,
      }).pipe(Effect.ignore);
      yield* Effect.logInfo("Database compaction left for the next start.", {
        reason: input.deferral,
      });
      return { kind: "deferred", reason: input.deferral } satisfies StartupCompactionReport;
    }

    const startedAtMs = yield* Clock.currentTimeMillis;
    const startedAt = DateTime.formatIso(DateTime.makeUnsafe(startedAtMs));
    const beforeBytes = (yield* fileSize(dbPath)) + (yield* fileSize(`${dbPath}-wal`));
    const finish = Effect.fn("DatabaseCompaction.finish")(function* (
      outcome: CompactionFileOutcome,
    ) {
      const finishedAtMs = yield* Clock.currentTimeMillis;
      const result: DatabaseCompactionResult = {
        outcome: outcome.outcome,
        startedAt,
        finishedAt: DateTime.formatIso(DateTime.makeUnsafe(finishedAtMs)),
        durationMs: Math.max(0, finishedAtMs - startedAtMs),
        beforeBytes,
        afterBytes: outcome.outcome === "compacted" ? outcome.afterBytes : null,
        reason: outcome.outcome === "compacted" ? null : outcome.reason,
      };
      yield* writeResultFile(dbPath, { version: RESULT_FILE_VERSION, state: "finished", result });
      return result;
    });

    // Recorded, then consumed, before any work: a run that crashes the server
    // is reported at the next start and never retried on its own.
    yield* writeResultFile(dbPath, {
      version: RESULT_FILE_VERSION,
      state: "running",
      startedAt,
      beforeBytes,
      originalInode: (yield* fileInode(dbPath)) ?? "",
    });
    yield* removeCompactionRequest(dbPath);

    if (input.sqlite === null) {
      const result = yield* finish({
        outcome: "skipped",
        beforeBytes,
        reason: "This server runtime cannot compact the database.",
      });
      return { kind: "ran", result } satisfies StartupCompactionReport;
    }
    const sqliteFactory = input.sqlite;

    yield* Effect.logInfo("Compacting the database.", { dbPath, beforeBytes });
    input.onActive?.(true);
    const outcome = yield* Effect.scoped(
      Effect.gen(function* () {
        const sqlite = yield* sqliteFactory;
        return yield* compactDatabaseFile({
          dbPath,
          runId: String(startedAtMs),
          sqlite,
          freeDiskBytes: input.freeDiskBytes ?? freeDiskBytes,
          platform: yield* HostProcessPlatform,
          ...(input.quickCheck === undefined ? {} : { quickCheck: input.quickCheck }),
        });
      }),
    ).pipe(
      Effect.ensuring(Effect.sync(() => input.onActive?.(false))),
      // Stopped part way (the server is shutting down): record which file is
      // in place now rather than leave it for the next start to work out.
      Effect.onInterrupt(() => settleInterruptedRun(dbPath).pipe(Effect.ignore)),
    );
    const result = yield* finish(outcome);
    yield* (result.outcome === "compacted" ? Effect.logInfo : Effect.logWarning)(
      "Database compaction finished.",
      {
        outcome: result.outcome,
        beforeBytes: result.beforeBytes,
        afterBytes: result.afterBytes,
        durationMs: result.durationMs,
        reason: result.reason,
      },
    );
    return { kind: "ran", result } satisfies StartupCompactionReport;
  },
  Effect.catch((cause) =>
    Effect.logError("Database compaction could not run.", { cause: describe(cause) }).pipe(
      Effect.as({ kind: "none" } satisfies StartupCompactionReport as StartupCompactionReport),
    ),
  ),
);

/**
 * Runs a scheduled compaction before anything opens the database. Bun has no
 * `node:sqlite`, so a compaction scheduled there is reported as skipped.
 */
export const startupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig.ServerConfig;
    const environment = yield* HostProcessEnvironment;
    const deferred = (environment[DEFER_DATABASE_COMPACTION_ENV] ?? "").trim().length > 0;
    yield* runScheduledDatabaseCompaction({
      dbPath,
      deferral: deferred ? "update-launch" : null,
      sqlite: process.versions.bun === undefined ? makeWorkerSqlite : null,
      onActive: (active) => setStartupStage(active ? "compacting-database" : null),
    });
  }).pipe(
    // Compaction is optional work: nothing it does may stop the server starting.
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logError("Database compaction could not run.", { cause: Cause.pretty(cause) }),
    ),
  ),
);

// ---------------------------------------------------------------------------
// Status, schedule, and cancel for clients

export const readDatabaseStorageStatus = Effect.fn("DatabaseCompaction.readStatus")(function* (
  dbPath: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const pragma = (name: string) =>
    sql.unsafe<Record<string, unknown>>(`PRAGMA ${name}`).pipe(
      Effect.map((rows) => {
        const value = rows[0]?.[name];
        return typeof value === "number" ? value : Number(value ?? 0);
      }),
    );
  const pageSize = Math.max(1, yield* pragma("page_size"));
  const pageCount = yield* pragma("page_count");
  const freePageCount = yield* pragma("freelist_count");
  const liveBytes = Math.max(0, pageCount - freePageCount) * pageSize;
  const request = yield* readCompactionRequest(dbPath);
  return {
    fileBytes: yield* fileSize(dbPath),
    walBytes: yield* fileSize(`${dbPath}-wal`),
    pageSize,
    pageCount,
    freePageCount,
    liveBytes,
    reclaimableBytes: freePageCount * pageSize,
    requiredFreeBytes: compactionRequiredFreeBytes(liveBytes),
    availableDiskBytes: yield* freeDiskBytes(NodePath.dirname(dbPath)),
    estimatedSeconds: compactionEstimatedSeconds(liveBytes),
    scheduled: request?.schedule ?? null,
    lastResult: yield* readLastCompactionResult(dbPath),
  } satisfies DatabaseStorageStatus;
});

export class DatabaseStorage extends Context.Service<
  DatabaseStorage,
  {
    readonly status: Effect.Effect<DatabaseStorageStatus, DatabaseStorageError>;
    /** Compacts at the next start. Scheduling twice keeps the first request time. */
    readonly schedule: Effect.Effect<DatabaseStorageStatus, DatabaseStorageError>;
    readonly cancel: Effect.Effect<DatabaseStorageStatus, DatabaseStorageError>;
  }
>()("t3/persistence/DatabaseCompaction/DatabaseStorage") {}

const toStorageError = (cause: unknown) =>
  new DatabaseStorageError({ detail: describe(cause).trim() || "Unknown error." });

export const layer = Layer.effect(
  DatabaseStorage,
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig.ServerConfig;
    const context = yield* Effect.context<
      SqlClient.SqlClient | FileSystem.FileSystem | Path.Path
    >();
    const withServices = <A, E>(
      effect: Effect.Effect<A, E, SqlClient.SqlClient | FileSystem.FileSystem | Path.Path>,
    ) => effect.pipe(Effect.provideContext(context), Effect.mapError(toStorageError));

    const status = withServices(readDatabaseStorageStatus(dbPath));
    const schedule = withServices(
      requestDatabaseCompaction(dbPath).pipe(Effect.andThen(readDatabaseStorageStatus(dbPath))),
    );
    const cancel = withServices(
      removeCompactionRequest(dbPath).pipe(Effect.andThen(readDatabaseStorageStatus(dbPath))),
    );
    return DatabaseStorage.of({ status, schedule, cancel });
  }),
);
