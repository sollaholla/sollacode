// @effect-diagnostics nodeBuiltinImport:off - Maintenance of standalone runtime packages.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as Schema from "effect/Schema";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { storageCleanupEnabled } from "./storageCleanupSettings.ts";

const RELEASE =
  /^(\d+)\.(\d+)\.(\d+)-(aarch64|x86_64)-(apple-darwin|unknown-linux-gnu|pc-windows-msvc)$/;
const DAY = 86_400_000;
const BinaryConfig = Schema.Struct({ binaryPath: Schema.optionalKey(Schema.String) });
const isBinaryConfig = Schema.is(BinaryConfig);
const decodePins = Schema.decodeUnknownSync(
  fromLenientJson(
    Schema.Struct({
      codex: Schema.optionalKey(BinaryConfig),
      providerInstances: Schema.optionalKey(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            config: Schema.optionalKey(Schema.Unknown),
          }),
        ),
      ),
    }),
  ),
);

async function configuredRuntimePaths(settings: string) {
  const decoded = decodePins(settings || "{}");
  const paths = [decoded.codex?.binaryPath];
  for (const instance of Object.values(decoded.providerInstances ?? {})) {
    if (isBinaryConfig(instance.config)) paths.push(instance.config.binaryPath);
  }
  return Promise.all(
    paths
      .filter((path): path is string => Boolean(path))
      .map((path) =>
        NodeFSP.realpath(
          path.startsWith("~/") ? NodePath.join(NodeOS.homedir(), path.slice(2)) : path,
        ).catch(() => path),
      ),
  );
}

/** Keep three per platform, the current pointer, pinned versions, and every open runtime. */
export async function cleanupCodexRuntimes(input: {
  readonly standaloneDir: string;
  readonly settingsPath: string;
  readonly nowMs: number;
  readonly openPaths: () => Promise<ReadonlySet<string>>;
}) {
  const removed: Array<string> = [];
  if (!(await storageCleanupEnabled(input.settingsPath))) return removed;
  const root = await NodeFSP.realpath(input.standaloneDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!root) return removed;
  const releases = NodePath.join(root, "releases");
  if (!(await NodeFSP.lstat(releases)).isDirectory()) return removed;
  const groups = new Map<string, Array<{ name: string; version: number[] }>>();
  for (const entry of await NodeFSP.readdir(releases, { withFileTypes: true })) {
    const match = RELEASE.exec(entry.name);
    if (!entry.isDirectory() || !match) continue;
    const key = `${match[4]}-${match[5]}`;
    const group = groups.get(key) ?? [];
    group.push({
      name: entry.name,
      version: [Number(match[1]), Number(match[2]), Number(match[3])],
    });
    groups.set(key, group);
  }
  const candidates = [...groups.values()].flatMap((group) =>
    group
      .toSorted(
        (a, b) =>
          b.version[0]! - a.version[0]! ||
          b.version[1]! - a.version[1]! ||
          b.version[2]! - a.version[2]!,
      )
      .slice(3),
  );
  for (const candidate of candidates) {
    if (!(await storageCleanupEnabled(input.settingsPath))) break;
    // Re-read all protections per deletion so an update/pin made during the sweep wins.
    const current = await NodeFSP.realpath(NodePath.join(root, "current"));
    if (NodePath.dirname(current) !== releases) return removed;
    const settings = await NodeFSP.readFile(input.settingsPath, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      },
    );
    const path = NodePath.join(releases, candidate.name);
    if (current === path || settings.includes(candidate.name)) continue;
    if (
      (await configuredRuntimePaths(settings)).some(
        (pinned) => pinned === path || pinned.startsWith(`${path}${NodePath.sep}`),
      )
    )
      continue;
    const open = await input.openPaths();
    if (open.has(NodePath.join(root, "install.lock"))) return removed;
    if ([...open].some((entry) => entry === path || entry.startsWith(`${path}${NodePath.sep}`)))
      continue;
    const info = await NodeFSP.lstat(path);
    if (!info.isDirectory() || info.mtimeMs > input.nowMs - DAY) continue;
    await NodeFSP.rm(path, { recursive: true });
    removed.push(path);
  }
  return removed;
}
