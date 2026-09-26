import type {
  EnvironmentId,
  FilesystemPathKind,
  FilesystemPathsExistResult,
} from "@t3tools/contracts";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";

/**
 * A remembered answer to "does this host path exist?".
 *
 * Bare paths in chat prose become clickable only once the host confirms
 * them. Messages re-render constantly (streaming, scrolling, theme changes)
 * and the same path is quoted in many messages, so the answer is looked up
 * here first and asked for at most once per path per environment. Answers
 * (including `missing`) are kept in memory and mirrored to localStorage, so
 * a reload does not re-ask either; they age out after {@link HOST_PATH_TTL_MS}
 * because files do get created and deleted.
 */
export type HostPathKind = FilesystemPathKind;

export type HostPathsExistRunner = (input: {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly paths: ReadonlyArray<string> };
}) => Promise<AtomCommandResult<FilesystemPathsExistResult, unknown>>;

export const HOST_PATH_TTL_MS = 60 * 60 * 1000;
/** Matches the RPC's batch bound; see `FILESYSTEM_PATHS_EXIST_MAX_PATHS`. */
export const HOST_PATH_BATCH_SIZE = 64;
export const HOST_PATH_CACHE_LIMIT = 4000;
const STORAGE_KEY = "solla.hostPathExistence.v1";
const FLUSH_DELAY_MS = 40;

interface CacheEntry {
  readonly kind: HostPathKind;
  readonly at: number;
}

const EMPTY_KINDS: ReadonlyMap<string, HostPathKind> = new Map();

export interface HostPathExistenceStore {
  /** Known kinds for these paths; unknown or expired paths are absent. */
  read(
    environmentId: EnvironmentId,
    paths: ReadonlyArray<string>,
  ): ReadonlyMap<string, HostPathKind>;
  /** Ask the host about whichever of these paths are unknown. Batched; a no-op for known ones. */
  request(
    environmentId: EnvironmentId,
    paths: ReadonlyArray<string>,
    runner: HostPathsExistRunner,
  ): void;
  subscribe(listener: () => void): () => void;
  /** Monotonic; bumps whenever an answer lands. Snapshot for React. */
  version(): number;
  /** Drain the batch queue now instead of on the timer. Tests only. */
  flush(): Promise<void>;
}

function cacheKey(environmentId: EnvironmentId, path: string): string {
  return `${environmentId} ${path}`;
}

export function createHostPathExistenceStore(
  options: {
    readonly now?: () => number;
    readonly ttlMs?: number;
    readonly schedule?: (flush: () => void) => void;
    readonly storage?: Pick<Storage, "getItem" | "setItem"> | null;
  } = {},
): HostPathExistenceStore {
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? HOST_PATH_TTL_MS;
  const schedule = options.schedule ?? ((flush) => window.setTimeout(flush, FLUSH_DELAY_MS));
  const storage =
    options.storage === undefined
      ? typeof localStorage === "undefined"
        ? null
        : localStorage
      : options.storage;

  const known = new Map<string, CacheEntry>();
  const inFlight = new Set<string>();
  const queue = new Map<EnvironmentId, { paths: Set<string>; runner: HostPathsExistRunner }>();
  const listeners = new Set<() => void>();
  let version = 0;
  let flushScheduled = false;
  let flushing: Promise<void> | null = null;

  const load = () => {
    if (!storage) return;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const cutoff = now() - ttlMs;
      for (const item of parsed) {
        if (!Array.isArray(item) || item.length !== 3) continue;
        const [key, kind, at] = item as [unknown, unknown, unknown];
        if (typeof key !== "string" || typeof at !== "number" || at < cutoff) continue;
        if (kind !== "file" && kind !== "directory" && kind !== "missing") continue;
        known.set(key, { kind, at });
      }
    } catch {
      // A corrupt or unavailable store just means asking again.
    }
  };
  const persist = () => {
    if (!storage) return;
    try {
      storage.setItem(
        STORAGE_KEY,
        JSON.stringify([...known.entries()].map(([key, entry]) => [key, entry.kind, entry.at])),
      );
    } catch {
      // Quota or privacy mode: the in-memory cache still does its job.
    }
  };
  const trim = () => {
    if (known.size <= HOST_PATH_CACHE_LIMIT) return;
    const oldest = [...known.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [key] of oldest.slice(0, known.size - HOST_PATH_CACHE_LIMIT)) known.delete(key);
  };
  const fresh = (entry: CacheEntry | undefined): entry is CacheEntry =>
    entry !== undefined && now() - entry.at < ttlMs;

  load();

  const notify = () => {
    version += 1;
    for (const listener of listeners) listener();
  };

  const runBatch = async (
    environmentId: EnvironmentId,
    paths: string[],
    runner: HostPathsExistRunner,
  ) => {
    const result = await runner({ environmentId, input: { paths } }).catch(() => null);
    const at = now();
    const succeeded = result !== null && result._tag === "Success";
    if (succeeded) {
      for (const entry of result.value.entries) {
        known.set(cacheKey(environmentId, entry.path), { kind: entry.kind, at });
      }
    }
    for (const path of paths) inFlight.delete(cacheKey(environmentId, path));
    if (succeeded) {
      trim();
      persist();
      notify();
    }
  };

  const flush = async () => {
    flushScheduled = false;
    const work: Promise<void>[] = [];
    for (const [environmentId, pending] of queue) {
      const paths = [...pending.paths];
      pending.paths.clear();
      for (let index = 0; index < paths.length; index += HOST_PATH_BATCH_SIZE) {
        work.push(
          runBatch(environmentId, paths.slice(index, index + HOST_PATH_BATCH_SIZE), pending.runner),
        );
      }
    }
    queue.clear();
    await Promise.all(work);
  };

  return {
    read(environmentId, paths) {
      if (paths.length === 0) return EMPTY_KINDS;
      const kinds = new Map<string, HostPathKind>();
      for (const path of paths) {
        const entry = known.get(cacheKey(environmentId, path));
        if (fresh(entry)) kinds.set(path, entry.kind);
      }
      return kinds;
    },
    request(environmentId, paths, runner) {
      let queued = false;
      for (const path of paths) {
        const key = cacheKey(environmentId, path);
        if (fresh(known.get(key)) || inFlight.has(key)) continue;
        inFlight.add(key);
        const pending = queue.get(environmentId) ?? { paths: new Set<string>(), runner };
        pending.paths.add(path);
        queue.set(environmentId, pending);
        queued = true;
      }
      if (queued && !flushScheduled) {
        flushScheduled = true;
        schedule(() => {
          flushing = flush();
        });
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => version,
    flush: async () => {
      if (flushScheduled) {
        flushing = flush();
      }
      await flushing;
    },
  };
}

export const hostPathExistenceStore: HostPathExistenceStore = createHostPathExistenceStore();

/**
 * Which of `paths` exist on `environmentId`'s host, as far as is known.
 *
 * Reads the cache synchronously, so a path answered for any earlier message
 * is a chip on first paint. Unknown paths are requested once (only while
 * `enabled`, so a streaming message does not probe half-typed paths) and the
 * component re-renders when the answer lands.
 */
export function useHostPathExistence(
  environmentId: EnvironmentId | null,
  paths: ReadonlyArray<string>,
  enabled: boolean,
  runner: HostPathsExistRunner,
  store: HostPathExistenceStore = hostPathExistenceStore,
): ReadonlyMap<string, HostPathKind> {
  const version = useSyncExternalStore(store.subscribe, store.version, store.version);
  useEffect(() => {
    if (!enabled || environmentId === null || paths.length === 0) return;
    store.request(environmentId, paths, runner);
  }, [enabled, environmentId, paths, runner, store]);
  return useMemo(
    () => (environmentId === null ? EMPTY_KINDS : store.read(environmentId, paths)),
    // `version` is the store's change signal; the read has no other input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [environmentId, paths, store, version],
  );
}
