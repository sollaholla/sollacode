// @effect-diagnostics nodeBuiltinImport:off - node:sqlite runs in a worker thread so a minutes-long VACUUM INTO leaves the event loop free to answer startup requests.
import * as NodeWorkerThreads from "node:worker_threads";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

/**
 * SQLite connections for database compaction, each living in one worker
 * thread.
 *
 * `node:sqlite` is synchronous. Run on the main thread, `VACUUM INTO` and
 * `PRAGMA quick_check` on a multi-gigabyte database would stop the server
 * answering anything for minutes, including the "starting" page phones and
 * the desktop's readiness probe receive. The worker owns every connection, so
 * the lock a connection takes is held across calls exactly as it would be on
 * one thread.
 */

export class CompactionSqliteError extends Schema.TaggedErrorClass<CompactionSqliteError>()(
  "CompactionSqliteError",
  {
    operation: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `${this.operation}: ${this.detail}`;
  }
}

export type SqliteRow = Readonly<Record<string, unknown>>;

export interface CompactionConnection {
  readonly exec: (sql: string) => Effect.Effect<void, CompactionSqliteError>;
  readonly all: (sql: string) => Effect.Effect<ReadonlyArray<SqliteRow>, CompactionSqliteError>;
  /** Closes now; the scope that opened the connection closes it otherwise. */
  readonly close: Effect.Effect<void, CompactionSqliteError>;
}

export interface CompactionSqlite {
  readonly open: (
    path: string,
  ) => Effect.Effect<CompactionConnection, CompactionSqliteError, Scope.Scope>;
}

const WORKER_SOURCE = String.raw`
const { parentPort } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");

const connections = new Map();
let nextHandle = 1;

parentPort.on("message", (request) => {
  try {
    let value = null;
    if (request.op === "open") {
      const handle = nextHandle++;
      connections.set(handle, new DatabaseSync(request.path));
      value = handle;
    } else if (request.op === "close") {
      const connection = connections.get(request.handle);
      connections.delete(request.handle);
      if (connection) connection.close();
    } else {
      const connection = connections.get(request.handle);
      if (!connection) throw new Error("The connection is closed.");
      if (request.op === "exec") connection.exec(request.sql);
      else value = connection.prepare(request.sql).all().map((row) => ({ ...row }));
    }
    parentPort.postMessage({ id: request.id, ok: true, value });
  } catch (cause) {
    parentPort.postMessage({
      id: request.id,
      ok: false,
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }
});
`;

/** How long releasing a connection or the worker waits behind a statement still running. */
const RELEASE_TIMEOUT = Duration.seconds(2);

type WorkerRequest =
  | { readonly op: "open"; readonly path: string }
  | { readonly op: "close"; readonly handle: number }
  | { readonly op: "exec"; readonly handle: number; readonly sql: string }
  | { readonly op: "all"; readonly handle: number; readonly sql: string };

type WorkerResponse =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly detail: string };

/** Starts the worker; it stops, closing anything still open, when the scope closes. */
export const makeWorkerSqlite: Effect.Effect<CompactionSqlite, never, Scope.Scope> = Effect.gen(
  function* () {
    const worker = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeWorkerThreads.Worker(WORKER_SOURCE, { eval: true })),
      // A statement in progress holds the thread until it returns, so do not
      // wait on it at shutdown; the process exiting ends it.
      (started) =>
        Effect.promise(() => started.terminate()).pipe(
          Effect.timeout(RELEASE_TIMEOUT),
          Effect.ignore,
        ),
    );
    const pending = new Map<number, (response: WorkerResponse) => void>();
    let stopped: string | null = null;
    let nextId = 1;
    const stop = (reason: string) => {
      if (stopped !== null) return;
      stopped = reason;
      for (const [id, settle] of pending) {
        pending.delete(id);
        settle({ id, ok: false, detail: reason });
      }
    };
    worker.on("message", (response: WorkerResponse) => {
      const settle = pending.get(response.id);
      pending.delete(response.id);
      settle?.(response);
    });
    worker.on("error", (cause) => stop(`The compaction worker failed: ${String(cause)}`));
    worker.on("exit", (code) => stop(`The compaction worker stopped (${code}).`));

    const request = (operation: string, message: WorkerRequest) =>
      Effect.callback<unknown, CompactionSqliteError>((resume) => {
        if (stopped !== null) {
          resume(Effect.fail(new CompactionSqliteError({ operation, detail: stopped })));
          return;
        }
        const id = nextId++;
        pending.set(id, (response) =>
          resume(
            response.ok
              ? Effect.succeed(response.value)
              : Effect.fail(new CompactionSqliteError({ operation, detail: response.detail })),
          ),
        );
        // eslint-disable-next-line unicorn/require-post-message-target-origin -- a Node worker thread, not a window.
        worker.postMessage({ ...message, id });
        return Effect.sync(() => {
          pending.delete(id);
        });
      });

    const open = Effect.fn("CompactionSqlite.open")(function* (path: string) {
      const handle = yield* Effect.acquireRelease(
        request(`open ${path}`, { op: "open", path }).pipe(Effect.map(Number)),
        (opened) =>
          request("close", { op: "close", handle: opened }).pipe(
            Effect.timeout(RELEASE_TIMEOUT),
            Effect.ignore,
          ),
      );
      let closed = false;
      const connection: CompactionConnection = {
        exec: (sql) => request(sql, { op: "exec", handle, sql }).pipe(Effect.asVoid),
        all: (sql) =>
          request(sql, { op: "all", handle, sql }).pipe(
            Effect.map((rows) => (Array.isArray(rows) ? (rows as ReadonlyArray<SqliteRow>) : [])),
          ),
        close: Effect.suspend(() => {
          if (closed) return Effect.void;
          closed = true;
          return request("close", { op: "close", handle }).pipe(Effect.asVoid);
        }),
      };
      return connection;
    });

    return { open } satisfies CompactionSqlite;
  },
);
