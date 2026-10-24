// @effect-diagnostics nodeBuiltinImport:off - Electron's on-disk cache inventory.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const DAY = 24 * 60 * 60 * 1_000;
export const BROWSER_CACHE_POLICY = { maxBytes: 2 * 1024 ** 3, minAgeMs: DAY, maxAgeMs: 7 * DAY };
// These are disposable network/compiled-script caches, never site storage.
const CACHE_DIRECTORIES = ["Cache", "Code Cache"] as const;

export interface BrowserCacheEntry {
  readonly name: string;
  readonly bytes: number;
  readonly modifiedAtMs: number;
}

/** A soft cap: recent or active profiles remain protected even when over budget. */
export function planBrowserCacheCleanup(
  entries: ReadonlyArray<BrowserCacheEntry>,
  nowMs: number,
  active: ReadonlySet<string>,
  policy = BROWSER_CACHE_POLICY,
) {
  let remainingBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
  return entries
    .toSorted((a, b) => a.modifiedAtMs - b.modifiedAtMs)
    .filter((entry) => {
      if (active.has(entry.name) || entry.modifiedAtMs > nowMs - policy.minAgeMs) return false;
      if (remainingBytes <= policy.maxBytes && entry.modifiedAtMs > nowMs - policy.maxAgeMs)
        return false;
      remainingBytes -= entry.bytes;
      return true;
    });
}

async function measureCache(directory: string): Promise<{ bytes: number; modifiedAtMs: number }> {
  const info = await NodeFSP.lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return { bytes: 0, modifiedAtMs: 0 };
  // Reject the entire profile if a cache redirects outside its directory.
  if (info.isSymbolicLink()) throw new Error("Cache contains a symbolic link");
  if (info.isFile()) return { bytes: info.size, modifiedAtMs: info.mtimeMs };
  if (!info.isDirectory()) throw new Error("Unexpected cache entry");
  let bytes = 0;
  let modifiedAtMs = info.mtimeMs;
  const entries = await NodeFSP.opendir(directory);
  for await (const entry of entries) {
    const measured = await measureCache(NodePath.join(directory, entry.name));
    bytes += measured.bytes;
    modifiedAtMs = Math.max(modifiedAtMs, measured.modifiedAtMs);
  }
  return { bytes, modifiedAtMs };
}

async function measureProfile(partitionsDir: string, name: string): Promise<BrowserCacheEntry> {
  const profile = NodePath.join(partitionsDir, name);
  if (!(await NodeFSP.lstat(profile)).isDirectory()) throw new Error("Not a profile directory");
  let bytes = 0;
  let modifiedAtMs = 0;
  for (const cache of CACHE_DIRECTORIES) {
    const measured = await measureCache(NodePath.join(profile, cache));
    bytes += measured.bytes;
    modifiedAtMs = Math.max(modifiedAtMs, measured.modifiedAtMs);
  }
  return { name, bytes, modifiedAtMs };
}

/** Inventory old profiles without opening them; only Electron may clear their caches. */
export async function sweepBrowserCaches(input: {
  readonly partitionsDir: string;
  readonly nowMs: number;
  readonly isEnabled: () => Promise<boolean>;
  readonly activeProfiles: () => ReadonlySet<string>;
  readonly clearCaches: (profileName: string) => Promise<void>;
  readonly policy?: typeof BROWSER_CACHE_POLICY;
}) {
  const removed: Array<{ profile: string; bytes: number }> = [];
  const failures: Array<{ profile: string; message: string }> = [];
  if (!(await input.isEnabled())) return { scannedBytes: 0, removed, failures };
  const root = await NodeFSP.lstat(input.partitionsDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!root?.isDirectory()) return { scannedBytes: 0, removed, failures };
  const entries: Array<BrowserCacheEntry> = [];
  for (const dir of await NodeFSP.readdir(input.partitionsDir, { withFileTypes: true })) {
    if (
      !dir.isDirectory() ||
      !/^t3code-preview-[a-f0-9]+(?:\.superseded(?:-\d+)?)?$/.test(dir.name)
    )
      continue;
    try {
      const entry = await measureProfile(input.partitionsDir, dir.name);
      if (entry.bytes > 0) entries.push(entry);
    } catch {
      // Unreadable or redirected profiles are never cleanup candidates.
    }
  }
  const policy = input.policy ?? BROWSER_CACHE_POLICY;
  for (const entry of planBrowserCacheCleanup(
    entries,
    input.nowMs,
    input.activeProfiles(),
    policy,
  )) {
    if (!(await input.isEnabled())) break;
    try {
      const current = await measureProfile(input.partitionsDir, entry.name);
      if (
        input.activeProfiles().has(entry.name) ||
        current.modifiedAtMs > input.nowMs - policy.minAgeMs
      )
        continue;
      await input.clearCaches(entry.name);
      const after = await measureProfile(input.partitionsDir, entry.name);
      removed.push({ profile: entry.name, bytes: Math.max(0, current.bytes - after.bytes) });
    } catch (error) {
      failures.push({ profile: entry.name, message: String(error) });
    }
  }
  return {
    scannedBytes: entries.reduce((total, entry) => total + entry.bytes, 0),
    removed,
    failures,
  };
}
