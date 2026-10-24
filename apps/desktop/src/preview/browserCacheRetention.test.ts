// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const { browserSession } = vi.hoisted(() => ({
  browserSession: {
    clearCache: vi.fn(),
    clearCodeCaches: vi.fn(),
    clearStorageData: vi.fn(),
    clearAuthCache: vi.fn(),
  },
}));
vi.mock("electron", () => ({ session: { fromPartition: vi.fn(() => browserSession) } }));

import { clearPreviewCaches } from "./browserCacheMaintenance.ts";
import {
  BROWSER_CACHE_POLICY,
  planBrowserCacheCleanup,
  sweepBrowserCaches,
} from "./browserCacheRetention.ts";

const DAY = 86_400_000;
const NOW = 100 * DAY;
const roots: Array<string> = [];
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});
const entry = (name: string, days: number, bytes = 10) => ({
  name,
  bytes,
  modifiedAtMs: NOW - days * DAY,
});

describe("browser cache budget", () => {
  it("removes expired and then oldest eligible profiles while protecting active/recent ones", () => {
    expect(
      planBrowserCacheCleanup(
        [entry("active", 20, 100), entry("expired", 8), entry("old", 6), entry("young", 0.5, 100)],
        NOW,
        new Set(["active"]),
        { ...BROWSER_CACHE_POLICY, maxBytes: 15 },
      ).map((x) => x.name),
    ).toEqual(["expired", "old"]);
  });
  it("keeps unexpired caches under budget", () => {
    expect(planBrowserCacheCleanup([entry("one", 2)], NOW, new Set())).toEqual([]);
  });
});

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "solla-cache-retention-"));
  roots.push(root);
  const name = "t3code-preview-abcdef0123456789";
  const profile = NodePath.join(root, name);
  const preserved = [
    "Cookies",
    "Network/Cookies",
    "Login Data",
    "Local Storage/data",
    "IndexedDB/data",
    "Service Worker/data",
    "Session Storage/data",
  ];
  for (const relative of [...preserved, "Cache/data", "Code Cache/data"]) {
    const path = NodePath.join(profile, relative);
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFSP.writeFile(path, relative);
    await NodeFSP.utimes(path, 0, (NOW - 8 * DAY) / 1_000);
  }
  for (const cache of ["Cache", "Code Cache"])
    await NodeFSP.utimes(NodePath.join(profile, cache), 0, (NOW - 8 * DAY) / 1_000);
  return { root, name, profile, preserved };
}

it("clears only HTTP/code caches and preserves cookie and site-storage bytes", async () => {
  const { root, profile, preserved } = await fixture();
  browserSession.clearCache.mockImplementation(() =>
    NodeFSP.rm(NodePath.join(profile, "Cache"), { recursive: true }),
  );
  browserSession.clearCodeCaches.mockImplementation(() =>
    NodeFSP.rm(NodePath.join(profile, "Code Cache"), { recursive: true }),
  );
  const result = await sweepBrowserCaches({
    partitionsDir: root,
    nowMs: NOW,
    isEnabled: async () => true,
    activeProfiles: () => new Set(),
    clearCaches: clearPreviewCaches,
  });
  expect(result.removed).toHaveLength(1);
  expect(result.removed[0]!.bytes).toBeGreaterThan(0);
  expect(browserSession.clearCache).toHaveBeenCalledOnce();
  expect(browserSession.clearCodeCaches).toHaveBeenCalledWith({});
  expect(browserSession.clearStorageData).not.toHaveBeenCalled();
  expect(browserSession.clearAuthCache).not.toHaveBeenCalled();
  for (const relative of preserved)
    expect(await NodeFSP.readFile(NodePath.join(profile, relative), "utf8")).toBe(relative);
});

it("does nothing when disabled", async () => {
  const { root } = await fixture();
  const clearCaches = vi.fn();
  await sweepBrowserCaches({
    partitionsDir: root,
    nowMs: NOW,
    isEnabled: async () => false,
    activeProfiles: () => new Set(),
    clearCaches,
  });
  expect(clearCaches).not.toHaveBeenCalled();
});

it("rechecks active use after planning, including a profile opened during the sweep", async () => {
  const { root, name } = await fixture();
  const clearCaches = vi.fn();
  const activeProfiles = vi
    .fn()
    .mockReturnValueOnce(new Set())
    .mockReturnValue(new Set([name]));
  await sweepBrowserCaches({
    partitionsDir: root,
    nowMs: NOW,
    isEnabled: async () => true,
    activeProfiles,
    clearCaches,
  });
  expect(clearCaches).not.toHaveBeenCalled();
});

it("rejects symlinked profiles and cache entries", async () => {
  const { root, profile } = await fixture();
  await NodeFSP.symlink(profile, NodePath.join(root, "t3code-preview-aaaa"), "dir");
  await NodeFSP.symlink(
    NodePath.join(profile, "Cookies"),
    NodePath.join(profile, "Cache", "redirect"),
  );
  const clearCaches = vi.fn();
  await sweepBrowserCaches({
    partitionsDir: root,
    nowMs: NOW,
    isEnabled: async () => true,
    activeProfiles: () => new Set(),
    clearCaches,
  });
  expect(clearCaches).not.toHaveBeenCalled();
});

it("protects a cache written after the initial inventory", async () => {
  const { root, profile } = await fixture();
  const clearCaches = vi.fn();
  let enabledReads = 0;
  await sweepBrowserCaches({
    partitionsDir: root,
    nowMs: NOW,
    activeProfiles: () => new Set(),
    clearCaches,
    isEnabled: async () => {
      if (++enabledReads === 2)
        await NodeFSP.utimes(NodePath.join(profile, "Cache", "data"), 0, NOW / 1_000);
      return true;
    },
  });
  expect(clearCaches).not.toHaveBeenCalled();
});

it("honors disabling cleanup after the initial inventory", async () => {
  const { root } = await fixture();
  const clearCaches = vi.fn();
  let enabledReads = 0;
  await sweepBrowserCaches({
    partitionsDir: root,
    nowMs: NOW,
    activeProfiles: () => new Set(),
    clearCaches,
    isEnabled: async () => ++enabledReads === 1,
  });
  expect(clearCaches).not.toHaveBeenCalled();
});

it("continues past a failed cache clear and reports the failure", async () => {
  const { root } = await fixture();
  const result = await sweepBrowserCaches({
    partitionsDir: root,
    nowMs: NOW,
    isEnabled: async () => true,
    activeProfiles: () => new Set(),
    clearCaches: async () => {
      throw new Error("cache busy");
    },
  });
  expect(result.failures).toHaveLength(1);
  expect(result.removed).toEqual([]);
});
