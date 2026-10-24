// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { cleanupCodexRuntimes } from "./runtimeRetention.ts";

const NOW = 100 * 86_400_000;
const roots: Array<string> = [];
const name = (patch: number) => `0.1.${patch}-aarch64-apple-darwin`;
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const temporary = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "solla-runtime-retention-"),
  );
  const root = await NodeFSP.realpath(temporary);
  roots.push(root);
  for (const patch of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const path = NodePath.join(root, "releases", name(patch));
    await NodeFSP.mkdir(path, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(path, "codex"), "binary");
    await NodeFSP.utimes(path, 0, 0);
  }
  await NodeFSP.symlink(
    NodePath.join(root, "releases", name(1)),
    NodePath.join(root, "current"),
    "dir",
  );
  return { standaloneDir: root, settingsPath: NodePath.join(root, "settings.json"), nowMs: NOW };
}

it("keeps newest three, current, selected and running versions", async () => {
  const input = await fixture();
  await NodeFSP.writeFile(
    input.settingsPath,
    JSON.stringify({
      codex: { binaryPath: NodePath.join(input.standaloneDir, "releases", name(2), "codex") },
    }),
  );
  const removed = await cleanupCodexRuntimes({
    ...input,
    openPaths: async () =>
      new Set([NodePath.join(input.standaloneDir, "releases", name(3), "codex")]),
  });
  expect(removed.map((path) => NodePath.basename(path))).toEqual([name(5), name(4)]);
  for (const patch of [1, 2, 3, 6, 7, 8])
    expect(
      await NodeFSP.readFile(
        NodePath.join(input.standaloneDir, "releases", name(patch), "codex"),
        "utf8",
      ),
    ).toBe("binary");
});

it("does not clean while the vendor installer lock is held", async () => {
  const input = await fixture();
  expect(
    await cleanupCodexRuntimes({
      ...input,
      openPaths: async () => new Set([NodePath.join(input.standaloneDir, "install.lock")]),
    }),
  ).toEqual([]);
});

it("resolves a configured binary symlink before retiring runtimes", async () => {
  const input = await fixture();
  const alias = NodePath.join(input.standaloneDir, "pinned-codex");
  await NodeFSP.symlink(NodePath.join(input.standaloneDir, "releases", name(4), "codex"), alias);
  await NodeFSP.writeFile(
    input.settingsPath,
    JSON.stringify({ providerInstances: { pinned: { config: { binaryPath: alias } } } }),
  );
  const removed = await cleanupCodexRuntimes({ ...input, openPaths: async () => new Set() });
  expect(removed).not.toContain(NodePath.join(input.standaloneDir, "releases", name(4)));
  expect(await NodeFSP.readFile(alias, "utf8")).toBe("binary");
});

it("does not clean when disabled or unable to identify the current runtime", async () => {
  const input = await fixture();
  await NodeFSP.writeFile(input.settingsPath, '{"automaticStorageCleanupEnabled":false}');
  expect(await cleanupCodexRuntimes({ ...input, openPaths: async () => new Set() })).toEqual([]);
  await NodeFSP.writeFile(input.settingsPath, "{}");
  await NodeFSP.unlink(NodePath.join(input.standaloneDir, "current"));
  await expect(
    cleanupCodexRuntimes({ ...input, openPaths: async () => new Set() }),
  ).rejects.toThrow();
  expect(
    await NodeFSP.readFile(
      NodePath.join(input.standaloneDir, "releases", name(4), "codex"),
      "utf8",
    ),
  ).toBe("binary");
});

it("leaves recent directories and unknown versions untouched", async () => {
  const input = await fixture();
  await NodeFSP.utimes(NodePath.join(input.standaloneDir, "releases", name(4)), 0, NOW / 1_000);
  await NodeFSP.mkdir(NodePath.join(input.standaloneDir, "releases", "custom-build"));
  const removed = await cleanupCodexRuntimes({ ...input, openPaths: async () => new Set() });
  expect(removed).not.toContain(NodePath.join(input.standaloneDir, "releases", name(4)));
  expect(
    (
      await NodeFSP.stat(NodePath.join(input.standaloneDir, "releases", "custom-build"))
    ).isDirectory(),
  ).toBe(true);
});
