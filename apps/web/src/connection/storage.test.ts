import {
  EnvironmentId,
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";
import { THREAD_CACHE_MAX_CHARS } from "@t3tools/client-runtime/platform/thread-cache-format";
import { ConnectionTransientError } from "@t3tools/client-runtime/connection";
import { ConnectionCatalogDocument, EnvironmentCacheStore } from "@t3tools/client-runtime/platform";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { afterEach, vi } from "vite-plus/test";

import { connectionStorageLayer, makeCatalogBackend, makeCatalogStore } from "./storage";

const emptyCatalog = {
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
} as const;
const decodeCatalog = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionCatalogDocument));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("makeCatalogStore", () => {
  it.effect("quarantines malformed catalogs and starts from an empty document", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const quarantined: string[] = [];
      const store = yield* makeCatalogStore({
        read: Effect.succeed("{not-json"),
        write: (raw) => Effect.sync(() => writes.push(raw)),
        quarantine: (raw) => Effect.sync(() => quarantined.push(raw)),
      });

      expect(yield* store.read).toEqual(emptyCatalog);
      expect(quarantined).toEqual(["{not-json"]);
      expect(writes).toHaveLength(1);
      expect(decodeCatalog(writes[0]!)).toEqual(emptyCatalog);
    }),
  );

  it.effect("does not hide catalog read failures", () =>
    Effect.gen(function* () {
      const failure = new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: "permission denied",
      });
      const store = yield* makeCatalogStore({
        read: Effect.fail(failure),
        write: () => Effect.void,
      });

      expect(yield* Effect.flip(store.read)).toBe(failure);
    }),
  );
});

describe("makeCatalogBackend", () => {
  it.effect("fails writes when desktop secure storage declines the catalog", () =>
    Effect.gen(function* () {
      const setConnectionCatalog = vi.fn().mockResolvedValue(false);
      vi.stubGlobal("window", {
        desktopBridge: {
          getConnectionCatalog: vi.fn().mockResolvedValue(null),
          setConnectionCatalog,
        },
      });
      const backend = makeCatalogBackend({} as IDBDatabase);

      const error = yield* backend.write("{}").pipe(Effect.flip);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error.message).toContain("Desktop secure storage is unavailable");
      expect(setConnectionCatalog).toHaveBeenCalledWith("{}");
    }),
  );
});

const cacheEnvironmentId = EnvironmentId.make("environment-1");
const cacheThreadId = ThreadId.make("thread-1");
const threadSnapshot: OrchestrationThreadDetailSnapshot = {
  snapshotSequence: 7,
  thread: {
    id: cacheThreadId,
    projectId: ProjectId.make("project-1"),
    title: "Cached thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  },
};

function installMemoryIndexedDb() {
  vi.stubGlobal("window", {});
  const values = new Map<string, unknown>();
  const removed: string[] = [];
  const database = {
    close() {},
    transaction(storeName: string) {
      const transaction = new EventTarget();
      return Object.assign(transaction, {
        objectStore() {
          return {
            get(key: string) {
              const request = Object.assign(new EventTarget(), {
                result: values.get(`${storeName}:${key}`),
              });
              queueMicrotask(() => request.dispatchEvent(new Event("success")));
              return request;
            },
            put(value: unknown, key: string) {
              values.set(`${storeName}:${key}`, value);
              queueMicrotask(() => transaction.dispatchEvent(new Event("complete")));
            },
            delete(key: string) {
              const id = `${storeName}:${key}`;
              removed.push(id);
              values.delete(id);
              queueMicrotask(() => transaction.dispatchEvent(new Event("complete")));
            },
          };
        },
      });
    },
  };
  vi.stubGlobal("indexedDB", {
    open() {
      const request = Object.assign(new EventTarget(), { result: database });
      queueMicrotask(() => request.dispatchEvent(new Event("success")));
      return request;
    },
  });
  return { values, removed };
}

const threadCacheId = `thread:${cacheEnvironmentId}:${cacheThreadId}`;

describe("web thread cache", () => {
  it.effect("round-trips version 3 snapshots with the resume sequence", () =>
    Effect.gen(function* () {
      const memory = installMemoryIndexedDb();
      yield* Effect.gen(function* () {
        const store = yield* EnvironmentCacheStore;
        yield* store.saveThread(cacheEnvironmentId, threadSnapshot);
        expect(String(memory.values.get(threadCacheId))).toMatch(/^\{"schemaVersion":3,/);
        expect(yield* store.loadThread(cacheEnvironmentId, cacheThreadId)).toMatchObject(
          Option.some(threadSnapshot),
        );
      }).pipe(Effect.provide(connectionStorageLayer));
    }),
  );

  for (const [name, raw] of [
    ["old version", '{"schemaVersion":2,"snapshot":' + " ".repeat(100_000)],
    [
      "oversized current version",
      '{"schemaVersion":3,"snapshot":' + " ".repeat(THREAD_CACHE_MAX_CHARS),
    ],
  ] as const) {
    it.effect(`evicts ${name} without parsing the JSON`, () =>
      Effect.gen(function* () {
        const memory = installMemoryIndexedDb();
        memory.values.set(threadCacheId, raw);
        const parse = vi.spyOn(JSON, "parse");
        yield* Effect.gen(function* () {
          const store = yield* EnvironmentCacheStore;
          expect(yield* store.loadThread(cacheEnvironmentId, cacheThreadId)).toEqual(Option.none());
        }).pipe(Effect.provide(connectionStorageLayer));
        expect(parse.mock.calls.some(([input]) => input === raw)).toBe(false);
        expect(memory.removed).toEqual([threadCacheId]);
      }),
    );
  }

  it.effect("evicts malformed current rows instead of decoding them on every open", () =>
    Effect.gen(function* () {
      const memory = installMemoryIndexedDb();
      memory.values.set(threadCacheId, '{"schemaVersion":3,"snapshot":broken}');
      yield* Effect.gen(function* () {
        const store = yield* EnvironmentCacheStore;
        expect(yield* store.loadThread(cacheEnvironmentId, cacheThreadId)).toEqual(Option.none());
        expect(yield* store.loadThread(cacheEnvironmentId, cacheThreadId)).toEqual(Option.none());
      }).pipe(Effect.provide(connectionStorageLayer));
      expect(memory.removed).toEqual([threadCacheId]);
    }),
  );

  it.effect("removes the previous cache if its replacement exceeds the decode budget", () =>
    Effect.gen(function* () {
      const memory = installMemoryIndexedDb();
      yield* Effect.gen(function* () {
        const store = yield* EnvironmentCacheStore;
        yield* store.saveThread(cacheEnvironmentId, threadSnapshot);
        yield* store.saveThread(cacheEnvironmentId, {
          ...threadSnapshot,
          thread: { ...threadSnapshot.thread, title: "x".repeat(THREAD_CACHE_MAX_CHARS) },
        });
        expect(yield* store.loadThread(cacheEnvironmentId, cacheThreadId)).toEqual(Option.none());
      }).pipe(Effect.provide(connectionStorageLayer));
      expect(memory.removed).toEqual([threadCacheId]);
    }),
  );
});
