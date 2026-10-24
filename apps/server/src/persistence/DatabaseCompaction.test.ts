// @effect-diagnostics nodeBuiltinImport:off - scratch databases are built and inspected directly with node:sqlite.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  databaseCompactionRequestPath,
  databaseCompactionResultPath,
} from "@t3tools/shared/databaseCompaction";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import {
  DatabaseStorage,
  describeFactsMismatch,
  layer as databaseStorageLayer,
  readLastCompactionResult,
  requestDatabaseCompaction,
  runScheduledDatabaseCompaction,
} from "./DatabaseCompaction.ts";
import { makeWorkerSqlite } from "./DatabaseCompactionWorker.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

const makeScratchDirectory = Effect.promise(() =>
  NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-db-compaction-")),
);

/**
 * A WAL database shaped like state.sqlite: a payload table with an index, an
 * AUTOINCREMENT table (so sqlite_sequence exists), migration bookkeeping, and
 * a user_version. Deleting a contiguous half of the payload rows frees whole
 * pages, as deleting a long thread does.
 */
function buildScratchDatabase(dbPath: string): void {
  const db = new NodeSqlite.DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA user_version = 84;
    CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, payload_json TEXT NOT NULL);
    CREATE INDEX idx_events_thread ON orchestration_events(thread_id, sequence);
    CREATE TABLE projection_thread_activities (activity_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, payload_json TEXT NOT NULL);
  `);
  const migration = db.prepare(
    "INSERT INTO effect_sql_migrations (migration_id, created_at, name) VALUES (?, ?, ?)",
  );
  for (let id = 1; id <= 84; id += 1) migration.run(id, "2026-01-01T00:00:00.000Z", `m${id}`);
  const event = db.prepare(
    "INSERT INTO orchestration_events (thread_id, payload_json) VALUES (?, ?)",
  );
  const activity = db.prepare(
    "INSERT INTO projection_thread_activities (activity_id, thread_id, payload_json) VALUES (?, ?, ?)",
  );
  db.exec("BEGIN");
  for (let index = 0; index < 1_200; index += 1) {
    const thread = index < 600 ? "thread-deleted" : "thread-kept";
    event.run(thread, `{"n":${index},"text":"${"e".repeat(1_500)}"}`);
    activity.run(`activity-${index}`, thread, `{"n":${index},"text":"${"a".repeat(2_500)}"}`);
  }
  db.exec("COMMIT");
  db.exec("DELETE FROM orchestration_events WHERE thread_id = 'thread-deleted'");
  db.exec("DELETE FROM projection_thread_activities WHERE thread_id = 'thread-deleted'");
  db.close();
}

/** Every table's rows, hashed in rowid order, plus the header values that must survive. */
function fingerprint(dbPath: string) {
  const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map(({ name }) => {
      const hash = NodeCrypto.createHash("sha256");
      const rows = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
      for (const row of rows) {
        hash.update(
          Object.values(row)
            .map((value) => (value === null ? "\u0000" : `${typeof value}:${String(value)}`))
            .join("\u0001"),
        );
        hash.update("\u0002");
      }
      return { name, rows: rows.length, hash: hash.digest("hex") };
    });
    const pragma = (name: string) =>
      (db.prepare(`PRAGMA ${name}`).get() as Record<string, number>)[name];
    return {
      tables,
      userVersion: pragma("user_version"),
      pageCount: pragma("page_count"),
      freePages: pragma("freelist_count"),
    };
  } finally {
    db.close();
  }
}

const inodeOf = (path: string) => NodeFS.statSync(path, { bigint: true }).ino.toString();
const listDirectory = (directory: string) => NodeFS.readdirSync(directory).toSorted();

const runCompaction = (
  dbPath: string,
  overrides: Partial<Parameters<typeof runScheduledDatabaseCompaction>[0]> = {},
) =>
  runScheduledDatabaseCompaction({
    dbPath,
    deferral: null,
    sqlite: makeWorkerSqlite,
    ...overrides,
  });

const withScratchDatabase = Effect.gen(function* () {
  const directory = yield* makeScratchDirectory;
  const dbPath = NodePath.join(directory, "state.sqlite");
  buildScratchDatabase(dbPath);
  return { directory, dbPath };
});

describe("runScheduledDatabaseCompaction", () => {
  it.effect("shrinks a database with free pages and keeps every row", () =>
    Effect.gen(function* () {
      const { directory, dbPath } = yield* withScratchDatabase;
      const before = fingerprint(dbPath);
      expect(before.freePages).toBeGreaterThan(0);
      const sizeBefore = NodeFS.statSync(dbPath).size;
      yield* requestDatabaseCompaction(dbPath);

      const report = yield* runCompaction(dbPath);

      expect(report.kind).toBe("ran");
      const result = report.kind === "ran" ? report.result : null;
      expect(result?.outcome).toBe("compacted");
      expect(result?.reason).toBeNull();
      expect(result?.afterBytes).toBe(NodeFS.statSync(dbPath).size);
      expect(NodeFS.statSync(dbPath).size).toBeLessThan(sizeBefore * 0.7);
      const after = fingerprint(dbPath);
      expect(after.tables).toEqual(before.tables);
      expect(after.userVersion).toBe(84);
      expect(after.freePages).toBe(0);
      // The request is consumed, the result recorded, and no copy, log, or
      // shared-memory file is left beside the database.
      expect(listDirectory(directory)).toEqual([
        "state.sqlite",
        "state.sqlite.compact-result.json",
      ]);
      expect(yield* readLastCompactionResult(dbPath)).toEqual(result);

      // The server reopens it in WAL mode as usual.
      const reopened = new NodeSqlite.DatabaseSync(dbPath);
      expect(reopened.prepare("PRAGMA journal_mode = WAL").get()).toEqual({ journal_mode: "wal" });
      expect(reopened.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
      reopened.close();
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the original when the copy fails its integrity check", () =>
    Effect.gen(function* () {
      const { directory, dbPath } = yield* withScratchDatabase;
      const before = fingerprint(dbPath);
      const inode = inodeOf(dbPath);
      yield* requestDatabaseCompaction(dbPath);

      const report = yield* runCompaction(dbPath, {
        quickCheck: () => Effect.succeed("*** in database main *** Page 7: free space corrupted"),
      });

      expect(report.kind === "ran" ? report.result.outcome : null).toBe("failed");
      expect(report.kind === "ran" ? report.result.reason : null).toContain(
        "failed its integrity check",
      );
      expect(inodeOf(dbPath)).toBe(inode);
      expect(fingerprint(dbPath)).toEqual(before);
      // The failed copy is gone and the request is not retried.
      expect(listDirectory(directory)).toEqual([
        "state.sqlite",
        "state.sqlite.compact-result.json",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("skips, without touching the database, when the disk is too full", () =>
    Effect.gen(function* () {
      const { directory, dbPath } = yield* withScratchDatabase;
      const inode = inodeOf(dbPath);
      yield* requestDatabaseCompaction(dbPath);

      const report = yield* runCompaction(dbPath, {
        freeDiskBytes: () => Effect.succeed(1024 * 1024),
      });

      const result = report.kind === "ran" ? report.result : null;
      expect(result?.outcome).toBe("skipped");
      expect(result?.reason).toMatch(/^Not enough free disk space: compaction needs .* GB/);
      expect(inodeOf(dbPath)).toBe(inode);
      expect(listDirectory(directory)).not.toContain("state.sqlite.compact-request.json");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("skips when another connection has the database open", () =>
    Effect.gen(function* () {
      const { directory, dbPath } = yield* withScratchDatabase;
      const other = new NodeSqlite.DatabaseSync(dbPath);
      other.exec("PRAGMA journal_mode = WAL");
      const inode = inodeOf(dbPath);
      yield* requestDatabaseCompaction(dbPath);

      const report = yield* runCompaction(dbPath).pipe(
        Effect.ensuring(Effect.sync(() => other.close())),
      );

      const result = report.kind === "ran" ? report.result : null;
      expect(result?.outcome).toBe("skipped");
      expect(result?.reason).toBe("Another process had the database open.");
      expect(inodeOf(dbPath)).toBe(inode);
      expect(listDirectory(directory).filter((name) => name.includes("compacting"))).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves the request in place on an update launch", () =>
    Effect.gen(function* () {
      const { dbPath } = yield* withScratchDatabase;
      const inode = inodeOf(dbPath);
      yield* requestDatabaseCompaction(dbPath);

      const report = yield* runCompaction(dbPath, { deferral: "update-launch" });

      expect(report).toEqual({ kind: "deferred", reason: "update-launch" });
      expect(inodeOf(dbPath)).toBe(inode);
      expect(NodeFS.existsSync(databaseCompactionResultPath(dbPath))).toBe(false);
      const request = NodeFS.readFileSync(databaseCompactionRequestPath(dbPath), "utf8");
      expect(request).toContain('"deferredReason":"update-launch"');

      // The next ordinary start runs it.
      const next = yield* runCompaction(dbPath);
      expect(next.kind === "ran" ? next.result.outcome : null).toBe("compacted");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does nothing when nothing is scheduled, but clears an interrupted run's copy", () =>
    Effect.gen(function* () {
      const { directory, dbPath } = yield* withScratchDatabase;
      NodeFS.writeFileSync(`${dbPath}.compacting-1700000000000`, "partial copy");
      NodeFS.writeFileSync(`${dbPath}.compacting-1700000000000-journal`, "partial journal");
      const inode = inodeOf(dbPath);

      const report = yield* runCompaction(dbPath);

      expect(report).toEqual({ kind: "none" });
      expect(inodeOf(dbPath)).toBe(inode);
      expect(listDirectory(directory).filter((name) => name.includes("compacting"))).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a run cut short by a crash, by which file is in place", () =>
    Effect.gen(function* () {
      const { dbPath } = yield* withScratchDatabase;
      const running = (originalInode: string) =>
        `{"version":1,"state":"running","startedAt":"2026-10-24T10:00:00.000Z","beforeBytes":123,"originalInode":"${originalInode}"}`;

      NodeFS.writeFileSync(databaseCompactionResultPath(dbPath), running(inodeOf(dbPath)));
      yield* runCompaction(dbPath);
      const interrupted = yield* readLastCompactionResult(dbPath);
      expect(interrupted?.outcome).toBe("interrupted");
      expect(interrupted?.reason).toContain("original database was kept");

      NodeFS.writeFileSync(databaseCompactionResultPath(dbPath), running("1"));
      yield* runCompaction(dbPath);
      const swapped = yield* readLastCompactionResult(dbPath);
      expect(swapped?.outcome).toBe("compacted");
      expect(swapped?.afterBytes).toBe(NodeFS.statSync(dbPath).size);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the original and removes the copy when the server stops part way", () =>
    Effect.gen(function* () {
      const { directory, dbPath } = yield* withScratchDatabase;
      const before = fingerprint(dbPath);
      const inode = inodeOf(dbPath);
      yield* requestDatabaseCompaction(dbPath);
      const checking = yield* Deferred.make<void>();

      const run = yield* Effect.forkChild(
        runCompaction(dbPath, {
          // Stop while the copy is being checked: it exists and is open.
          quickCheck: () =>
            Deferred.succeed(checking, undefined).pipe(Effect.andThen(Effect.never)),
        }),
      );
      yield* Deferred.await(checking);
      expect(listDirectory(directory).some((name) => name.includes(".compacting-"))).toBe(true);
      yield* Fiber.interrupt(run);

      expect(inodeOf(dbPath)).toBe(inode);
      expect(fingerprint(dbPath)).toEqual(before);
      expect(listDirectory(directory)).toEqual([
        "state.sqlite",
        "state.sqlite.compact-result.json",
      ]);
      const result = yield* readLastCompactionResult(dbPath);
      expect(result?.outcome).toBe("interrupted");
      expect(result?.reason).toContain("original database was kept");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a runtime that cannot compact and consumes the request", () =>
    Effect.gen(function* () {
      const { dbPath } = yield* withScratchDatabase;
      yield* requestDatabaseCompaction(dbPath);
      const report = yield* runCompaction(dbPath, { sqlite: null });
      expect(report.kind === "ran" ? report.result.outcome : null).toBe("skipped");
      expect(NodeFS.existsSync(databaseCompactionRequestPath(dbPath))).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("describeFactsMismatch", () => {
  const facts = {
    pageSize: 4096,
    userVersion: 84,
    applicationId: 0,
    schema: ["table|t|t|CREATE TABLE t (id INTEGER PRIMARY KEY)"],
    tables: [{ name: "t", rows: 10, maxRowid: 10 }],
  };

  it("accepts identical facts and names the first difference otherwise", () => {
    expect(describeFactsMismatch(facts, facts)).toBeNull();
    expect(describeFactsMismatch(facts, { ...facts, userVersion: 83 })).toBe(
      "user_version changed",
    );
    expect(
      describeFactsMismatch(facts, { ...facts, tables: [{ name: "t", rows: 9, maxRowid: 10 }] }),
    ).toBe("table t has 9 rows instead of 10");
    expect(
      describeFactsMismatch(facts, { ...facts, tables: [{ name: "t", rows: 10, maxRowid: 9 }] }),
    ).toBe("table t lost its newest rows");
    expect(describeFactsMismatch(facts, { ...facts, tables: [] })).toBe("table t is missing");
  });
});

describe("DatabaseStorage", () => {
  it.effect("reports page counts and schedules and cancels a compaction", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      buildScratchDatabase(config.dbPath);
      yield* Effect.gen(function* () {
        const storage = yield* DatabaseStorage;
        const initial = yield* storage.status;
        expect(initial.scheduled).toBeNull();
        expect(initial.lastResult).toBeNull();
        expect(initial.freePageCount).toBeGreaterThan(0);
        expect(initial.reclaimableBytes).toBe(initial.freePageCount * initial.pageSize);
        expect(initial.liveBytes).toBe(
          (initial.pageCount - initial.freePageCount) * initial.pageSize,
        );
        expect(initial.requiredFreeBytes).toBeGreaterThan(initial.liveBytes);

        const scheduled = yield* storage.schedule;
        expect(scheduled.scheduled?.deferredReason).toBeNull();
        expect(NodeFS.existsSync(databaseCompactionRequestPath(config.dbPath))).toBe(true);
        const again = yield* storage.schedule;
        expect(again.scheduled?.requestedAt).toBe(scheduled.scheduled?.requestedAt);

        const cancelled = yield* storage.cancel;
        expect(cancelled.scheduled).toBeNull();
        expect(NodeFS.existsSync(databaseCompactionRequestPath(config.dbPath))).toBe(false);
      }).pipe(
        Effect.provide(
          databaseStorageLayer.pipe(
            Layer.provide(NodeSqliteClient.layer({ filename: config.dbPath })),
          ),
        ),
      );
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-db-storage-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});
