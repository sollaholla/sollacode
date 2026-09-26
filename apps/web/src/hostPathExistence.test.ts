import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createHostPathExistenceStore,
  HOST_PATH_TTL_MS,
  type HostPathsExistRunner,
} from "./hostPathExistence";

const env = EnvironmentId.make("env-1");

function fakeRunner(existing: ReadonlyArray<string>) {
  const calls: string[][] = [];
  const runner: HostPathsExistRunner = async ({ input }) => {
    calls.push([...input.paths]);
    return AsyncResult.success({
      entries: input.paths.map((path) => ({
        path,
        kind: existing.includes(path) ? ("file" as const) : ("missing" as const),
      })),
    });
  };
  return { runner, calls };
}

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

describe("hostPathExistenceStore", () => {
  it("asks once per path, remembers both answers, and never re-asks", async () => {
    const { runner, calls } = fakeRunner(["/a/real.png"]);
    const store = createHostPathExistenceStore({ schedule: (flush) => flush(), storage: null });
    const listener = vi.fn();
    store.subscribe(listener);

    store.request(env, ["/a/real.png", "/a/fake.png", "/a/real.png"], runner);
    await store.flush();
    expect(calls).toEqual([["/a/real.png", "/a/fake.png"]]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect([...store.read(env, ["/a/real.png", "/a/fake.png", "/a/other.png"])]).toEqual([
      ["/a/real.png", "file"],
      ["/a/fake.png", "missing"],
    ]);

    store.request(env, ["/a/real.png", "/a/fake.png"], runner);
    await store.flush();
    expect(calls).toHaveLength(1);
  });

  it("batches paths queued in the same tick and splits large batches", async () => {
    const { runner, calls } = fakeRunner([]);
    let pending: (() => void) | null = null;
    const store = createHostPathExistenceStore({
      schedule: (flush) => {
        pending = flush;
      },
      storage: null,
    });
    const paths = Array.from({ length: 70 }, (_, index) => `/p/${index}.txt`);
    store.request(env, paths.slice(0, 10), runner);
    store.request(env, paths.slice(10), runner);
    expect(calls).toHaveLength(0);
    (pending as (() => void) | null)?.();
    await store.flush();
    expect(calls.map((batch) => batch.length)).toEqual([64, 6]);
  });

  it("survives a reload through storage and ages answers out", async () => {
    let clock = 1_000_000;
    const storage = memoryStorage();
    const { runner, calls } = fakeRunner(["/a/real.png"]);
    const first = createHostPathExistenceStore({
      now: () => clock,
      schedule: (flush) => flush(),
      storage,
    });
    first.request(env, ["/a/real.png"], runner);
    await first.flush();

    const second = createHostPathExistenceStore({
      now: () => clock,
      schedule: (flush) => flush(),
      storage,
    });
    expect(second.read(env, ["/a/real.png"]).get("/a/real.png")).toBe("file");
    second.request(env, ["/a/real.png"], runner);
    await second.flush();
    expect(calls).toHaveLength(1);

    clock += HOST_PATH_TTL_MS + 1;
    expect(second.read(env, ["/a/real.png"]).size).toBe(0);
    second.request(env, ["/a/real.png"], runner);
    await second.flush();
    expect(calls).toHaveLength(2);
  });

  it("can recheck newly created and deleted files after a short result-cache lifetime", async () => {
    let clock = 1000;
    let exists = false;
    const runner: HostPathsExistRunner = async ({ input }) =>
      AsyncResult.success({
        entries: input.paths.map((path) => ({ path, kind: exists ? "file" : "missing" })),
      });
    const store = createHostPathExistenceStore({
      now: () => clock,
      ttlMs: 30_000,
      storage: null,
      schedule: (flush) => flush(),
    });
    store.request(env, ["/result.txt"], runner);
    await store.flush();
    expect(store.read(env, ["/result.txt"]).get("/result.txt")).toBe("missing");
    clock += 30_000;
    exists = true;
    expect(store.read(env, ["/result.txt"]).has("/result.txt")).toBe(false);
    store.request(env, ["/result.txt"], runner);
    await store.flush();
    expect(store.read(env, ["/result.txt"]).get("/result.txt")).toBe("file");
    clock += 30_000;
    exists = false;
    store.request(env, ["/result.txt"], runner);
    await store.flush();
    expect(store.read(env, ["/result.txt"]).get("/result.txt")).toBe("missing");
  });

  it("keeps answers separate per environment", async () => {
    const { runner } = fakeRunner(["/shared.txt"]);
    const store = createHostPathExistenceStore({ schedule: (flush) => flush(), storage: null });
    store.request(env, ["/shared.txt"], runner);
    await store.flush();
    expect(store.read(EnvironmentId.make("env-2"), ["/shared.txt"]).size).toBe(0);
  });
});
