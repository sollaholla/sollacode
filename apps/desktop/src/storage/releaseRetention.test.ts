// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { cleanupReleaseArtifacts, planReleaseCleanup } from "./releaseRetention.ts";
import { storageCleanupEnabled } from "./storageCleanupSettings.ts";

const NOW = 100 * 86_400_000;
const roots: Array<string> = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});
const name = (patch: number, arch = "arm64", ext = "zip") =>
  `Solla-Code-0.1.${patch}-${arch}.${ext}`;
const file = (patch: number, arch = "arm64", ext = "zip") => ({
  name: name(patch, arch, ext),
  bytes: 4,
  modifiedAtMs: 0,
});

it("keeps five versions per architecture/format and the installed older version", () => {
  const files = [1, 2, 3, 4, 5, 6, 7].flatMap((patch) => [
    file(patch),
    file(patch, "x64"),
    file(patch, "arm64", "dmg"),
  ]);
  expect(planReleaseCleanup(files, name(1), NOW).map((x) => x.name)).toEqual([
    name(2),
    name(2, "x64"),
    name(1, "x64"),
    name(2, "arm64", "dmg"),
    name(1, "arm64", "dmg"),
  ]);
});

it("keeps recent, unknown and prerelease files", () => {
  const files = [1, 2, 3, 4, 5, 6].map((patch) => file(patch));
  files[0]!.modifiedAtMs = NOW;
  files.push(
    { name: "my-source.zip", bytes: 4, modifiedAtMs: 0 },
    { name: "Solla-Code-0.1.1-beta-arm64.zip", bytes: 4, modifiedAtMs: 0 },
  );
  expect(planReleaseCleanup(files, name(6), NOW)).toEqual([]);
});

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "solla-release-retention-"));
  roots.push(root);
  for (const patch of [1, 2, 3, 4, 5, 6, 7]) {
    for (const suffix of ["", ".blockmap"]) {
      const path = NodePath.join(root, name(patch) + suffix);
      await NodeFSP.writeFile(path, "data");
      await NodeFSP.utimes(path, 0, 0);
    }
  }
  return root;
}

it("removes obsolete packages and companion blockmaps, preserving open files and other data", async () => {
  const root = await fixture();
  await NodeFSP.writeFile(NodePath.join(root, "project.zip"), "source");
  const removed = await cleanupReleaseArtifacts({
    artifactPath: NodePath.join(root, name(7)),
    nowMs: NOW,
    isEnabled: async () => true,
    openPaths: async () => new Set([NodePath.join(root, name(2))]),
  });
  expect(removed.map((x) => NodePath.basename(x.path))).toEqual([name(1), `${name(1)}.blockmap`]);
  expect(await NodeFSP.readFile(NodePath.join(root, "project.zip"), "utf8")).toBe("source");
  expect(await NodeFSP.readFile(NodePath.join(root, name(2)), "utf8")).toBe("data");
});

it("cannot delete without a known open-file inventory or when disabled", async () => {
  const root = await fixture();
  const input = {
    artifactPath: NodePath.join(root, name(7)),
    nowMs: NOW,
    isEnabled: async () => true,
    openPaths: async (): Promise<ReadonlySet<string>> => {
      throw new Error("unavailable");
    },
  };
  await expect(cleanupReleaseArtifacts(input)).rejects.toThrow("unavailable");
  expect(await NodeFSP.readFile(NodePath.join(root, name(1)), "utf8")).toBe("data");
  expect(await cleanupReleaseArtifacts({ ...input, isEnabled: async () => false })).toEqual([]);
});

it("skips a file modified after it was selected", async () => {
  const root = await fixture();
  const removed = await cleanupReleaseArtifacts({
    artifactPath: NodePath.join(root, name(7)),
    nowMs: NOW,
    isEnabled: async () => true,
    openPaths: async () => {
      await NodeFSP.writeFile(NodePath.join(root, name(1)), "new download");
      await NodeFSP.writeFile(NodePath.join(root, name(2)), "new download");
      return new Set();
    },
  });
  expect(removed).toEqual([]);
});

it("reads the disable switch and fails closed for malformed settings", async () => {
  const root = await fixture();
  const settings = NodePath.join(root, "settings.json");
  expect(await storageCleanupEnabled(settings)).toBe(true);
  for (const [document, enabled] of [
    ["{}", true],
    ['{"automaticStorageCleanupEnabled":false}', false],
    ['{"automaticStorageCleanupEnabled":"false"}', false],
    ["broken", false],
  ] as const) {
    await NodeFSP.writeFile(settings, document);
    expect(await storageCleanupEnabled(settings)).toBe(enabled);
  }
});
