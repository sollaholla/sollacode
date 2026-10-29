import * as NodeSqlite from "node:sqlite";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

const openDatabaseAsync = vi.hoisted(() => vi.fn());

vi.mock("expo-sqlite", () => ({ openDatabaseAsync }));

import { decodeLegacyCacheRecord, make } from "./mobile-database";

describe("mobile database legacy cache migration", () => {
  it.effect("keeps acquisition failures typed on database operations", () =>
    Effect.scoped(
      Effect.gen(function* () {
        openDatabaseAsync.mockRejectedValueOnce(new Error("SQLite unavailable"));

        const database = yield* make;
        const result = yield* Effect.result(database.loadPreferencesJson);

        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "MobileDatabaseError", operation: "open" },
        });
      }),
    ),
  );

  it("maps legacy thread records to their SQLite identity", () => {
    const payload = JSON.stringify({
      schemaVersion: 2,
      environmentId: "environment-1",
      threadId: "thread-1",
      snapshot: {},
    });

    expect(decodeLegacyCacheRecord("connection-thread-snapshots", payload)).toEqual({
      environmentId: "environment-1",
      kind: "thread",
      cacheKey: "thread-1",
      schemaVersion: 2,
      payload,
    });
  });

  it("preserves the old shell payload for schema decoding after migration", () => {
    const payload = JSON.stringify({
      schemaVersion: 1,
      environmentId: "environment-1",
      snapshotReceivedAt: "2026-07-01T00:00:00.000Z",
      snapshot: {},
    });

    expect(decodeLegacyCacheRecord("shell-snapshots", payload)).toEqual({
      environmentId: "environment-1",
      kind: "shell",
      cacheKey: "snapshot",
      schemaVersion: 1,
      payload,
    });
  });

  it("skips malformed legacy records", () => {
    expect(decodeLegacyCacheRecord("connection-vcs-refs", "{not-json")).toBeNull();
    expect(
      decodeLegacyCacheRecord(
        "connection-vcs-refs",
        JSON.stringify({ schemaVersion: 1, environmentId: "environment-1" }),
      ),
    ).toBeNull();
  });
});

describe("mobile database cache versions", () => {
  it.effect("discards outdated thread rows in SQLite without returning their payload", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sqlite = new NodeSqlite.DatabaseSync(":memory:");
        sqlite.exec("PRAGMA user_version = 1");
        const returnedPayloads: unknown[] = [];
        const adapter = {
          execAsync: async (sql: string) => sqlite.exec(sql),
          runAsync: async (sql: string, ...params: NodeSqlite.SQLInputValue[]) =>
            sqlite.prepare(sql).run(...params),
          getFirstAsync: async (sql: string, ...params: NodeSqlite.SQLInputValue[]) => {
            const row = sqlite.prepare(sql).get(...params);
            if (row?.payload !== undefined) returnedPayloads.push(row.payload);
            return row ?? null;
          },
          withExclusiveTransactionAsync: async (
            body: (transaction: { execAsync: (sql: string) => Promise<void> }) => Promise<void>,
          ) => body(adapter),
          closeAsync: async () => sqlite.close(),
        };
        openDatabaseAsync.mockResolvedValueOnce(adapter);
        const database = yield* make;
        const environmentId = EnvironmentId.make("environment-1");
        const otherEnvironmentId = EnvironmentId.make("environment-2");
        const stale = '{"schemaVersion":2,"snapshot":' + " ".repeat(100_000);
        yield* database.saveCache(environmentId, "thread", "old", 2, stale);
        yield* database.saveCache(environmentId, "thread", "current", 3, "current");
        yield* database.saveCache(otherEnvironmentId, "thread", "old", 2, "other");
        yield* database.saveCache(environmentId, "shell", "old", 1, "shell");

        expect(yield* database.loadCache(environmentId, "thread", "old", 3)).toEqual(Option.none());
        expect(yield* database.loadCache(environmentId, "thread", "old")).toEqual(Option.none());
        expect(yield* database.loadCache(environmentId, "thread", "current", 3)).toEqual(
          Option.some("current"),
        );
        expect(yield* database.loadCache(otherEnvironmentId, "thread", "old")).toEqual(
          Option.some("other"),
        );
        expect(yield* database.loadCache(environmentId, "shell", "old")).toEqual(
          Option.some("shell"),
        );
        expect(returnedPayloads).not.toContain(stale);
      }),
    ),
  );
});
